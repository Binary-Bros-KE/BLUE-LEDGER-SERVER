import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { ShopContext } from "../middleware/shop-tenant.js";
import type { OrderLinkSaleInput, OrderListInput, OrderStatusInput, ShopOrderCreateInput } from "../schemas/shop.js";
import { activeSharedVariants, parseVariantConfig, sharedVariantPrice, variantLabel } from "../lib/variants.js";

/**
 * Storefront orders → the POS "Online Orders" inbox (model OnlineOrder).
 *
 * Trust boundary: the shopper sends only product ids + quantities + contact/delivery details.
 * Everything with money in it — unit prices, line totals, the delivery fee, the total — is read
 * from this tenant's own rows here, so a tampered request can't change what an order costs.
 */

export type OnlineOrderItem = {
  productId: string;
  /** shared-stock variant (lib/variants.ts) — the POS rings it up as that variant. Absent on older orders. */
  variantKey?: string | null;
  variantLabel?: string | null;
  /** "Travel Mug — Red" for a variant line */
  name: string;
  unitPriceCents: number;
  qty: number;
  lineTotalCents: number;
};

export type OnlineOrderView = {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  deliveryMethodName: string | null;
  deliveryFeeCents: number;
  paymentMethod: string;
  items: OnlineOrderItem[];
  subtotalCents: number;
  totalCents: number;
  currency: string;
  /** the store's fulfilment branch when the order came in — the POS rings it up there by default */
  fulfilmentLocationId: string | null;
  seen: boolean;
  createdAt: string;
  statusChangedAt: string | null;
  /** set once a POS rang the order up as a sale */
  linkedSaleId: string | null;
  linkedReceiptNumber: string | null;
};

export function formatOrderNumber(seq: number): string {
  return `WEB-${String(seq).padStart(4, "0")}`;
}

type OrderRow = Prisma.OnlineOrderGetPayload<object>;

function toView(r: OrderRow): OnlineOrderView {
  return {
    id: r.id,
    orderNumber: formatOrderNumber(r.orderSeq),
    status: r.status,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    customerEmail: r.customerEmail,
    deliveryAddress: r.deliveryAddress,
    notes: r.notes,
    deliveryMethodName: r.deliveryMethodName,
    deliveryFeeCents: r.deliveryFeeCents,
    paymentMethod: r.paymentMethod,
    items: (Array.isArray(r.itemsJson) ? r.itemsJson : []) as OnlineOrderItem[],
    subtotalCents: r.subtotalCents,
    totalCents: r.totalCents,
    currency: r.currency,
    fulfilmentLocationId: r.fulfilmentLocationId,
    seen: r.seenAt !== null,
    createdAt: r.createdAt.toISOString(),
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
    linkedSaleId: r.linkedSaleId,
    linkedReceiptNumber: r.linkedReceiptNumber,
  };
}

// --- Storefront side (public, tenant resolved from the domain) ------------------------------------

export async function createOrder(
  ctx: ShopContext,
  input: ShopOrderCreateInput,
): Promise<{ orderNumber: string; totalCents: number; subtotalCents: number; deliveryFeeCents: number; currency: string; items: OnlineOrderItem[] }> {
  // Merge duplicate lines for the same product + variant (a tampered cart could repeat one).
  const lines = new Map<string, { productId: string; variantKey: string | null; qty: number }>();
  for (const it of input.items) {
    const variantKey = it.variantKey ?? null;
    const key = `${it.productId}|${variantKey ?? ""}`;
    const prev = lines.get(key);
    lines.set(key, { productId: it.productId, variantKey, qty: Math.min(999, (prev?.qty ?? 0) + it.qty) });
  }
  const productIds = [...new Set([...lines.values()].map((l) => l.productId))];

  return withTenantContext(ctx.tenantId, async (tx) => {
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, publishedOnline: true, status: "active" },
      select: { id: true, name: true, onlinePriceCents: true, sellingPriceCents: true, variantConfigJson: true },
    });
    if (products.length !== productIds.length) {
      throw new HttpError(409, "Some items in your cart are no longer available. Please review your cart and try again.");
    }
    const byId = new Map(products.map((p) => [p.id, p]));

    const items: OnlineOrderItem[] = [...lines.values()].map((line) => {
      const p = byId.get(line.productId)!;
      const shopper = p.onlinePriceCents ?? p.sellingPriceCents;
      const config = parseVariantConfig(p.variantConfigJson);
      const shared = activeSharedVariants(config);
      if (!line.variantKey) {
        if (shared.length > 0) {
          throw new HttpError(409, `Please choose an option for "${p.name}" — open it from your cart and pick one.`);
        }
        return { productId: p.id, name: p.name, unitPriceCents: shopper, qty: line.qty, lineTotalCents: shopper * line.qty };
      }
      const variant = shared.find((v) => v.key === line.variantKey);
      if (!variant || !config) {
        throw new HttpError(409, `An option you chose for "${p.name}" is no longer available. Please review your cart.`);
      }
      const unit = sharedVariantPrice(variant, shopper);
      const label = variantLabel(config.options, variant.values);
      return {
        productId: p.id,
        variantKey: variant.key,
        variantLabel: label,
        name: `${p.name} — ${label}`,
        unitPriceCents: unit,
        qty: line.qty,
        lineTotalCents: unit * line.qty,
      };
    });
    const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0);

    let deliveryMethodId: string | null = null;
    let deliveryMethodName: string | null = null;
    let deliveryFeeCents = 0;
    const activeMethods = await tx.webDeliveryMethod.count({ where: { active: true } });
    if (input.deliveryMethodId) {
      const m = await tx.webDeliveryMethod.findFirst({ where: { id: input.deliveryMethodId, active: true } });
      if (!m) throw new HttpError(409, "That delivery option is no longer available. Please choose another.");
      deliveryMethodId = m.id;
      deliveryMethodName = m.name;
      deliveryFeeCents = m.priceCents;
    } else if (activeMethods > 0) {
      throw new HttpError(400, "Please choose a delivery option.");
    }

    const base = {
      tenantId: ctx.tenantId,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail || null,
      deliveryAddress: input.deliveryAddress || null,
      notes: input.notes || null,
      deliveryMethodId,
      deliveryMethodName,
      deliveryFeeCents,
      paymentMethod: input.paymentMethod,
      itemsJson: items as unknown as Prisma.InputJsonValue,
      subtotalCents,
      totalCents: subtotalCents + deliveryFeeCents,
      currency: ctx.store.currency,
      fulfilmentLocationId: ctx.store.fulfilmentLocationId,
    };

    // Next running number. A per-tenant transaction-scoped advisory lock serialises order creation
    // for this shop only (released at commit), so two simultaneous checkouts can't pick the same
    // number — the unique index stays as the backstop. (Retrying after a unique violation inside
    // one transaction doesn't work in Postgres: the whole transaction is aborted by the error.)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`online_orders:${ctx.tenantId}`}))`;
    const last = await tx.onlineOrder.aggregate({ _max: { orderSeq: true } });
    const row = await tx.onlineOrder.create({ data: { ...base, orderSeq: (last._max.orderSeq ?? 0) + 1 } });
    return {
      orderNumber: formatOrderNumber(row.orderSeq),
      totalCents: row.totalCents,
      subtotalCents: row.subtotalCents,
      deliveryFeeCents: row.deliveryFeeCents,
      currency: row.currency,
      items,
    };
  });
}

// --- POS side (device-authed /shop-admin/orders/*) ------------------------------------------------

export async function listOrders(tenantId: string, q: OrderListInput) {
  return withTenantContext(tenantId, async (tx) => {
    const where: Prisma.OnlineOrderWhereInput = q.status === "ALL" ? {} : { status: q.status };
    const [rows, total, grouped, unseen] = await Promise.all([
      tx.onlineOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.onlineOrder.count({ where }),
      tx.onlineOrder.groupBy({ by: ["status"], _count: { _all: true } }),
      tx.onlineOrder.count({ where: { seenAt: null } }),
    ]);
    const counts: Record<string, number> = { NEW: 0, CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return { orders: rows.map(toView), total, page: q.page, pageSize: q.pageSize, counts, unseen };
  });
}

/** Cheap poll for the POS badge / new-order toast: counts + the newest few unseen orders. */
export async function orderSummary(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const [newCount, unseenRows, unseen] = await Promise.all([
      tx.onlineOrder.count({ where: { status: "NEW" } }),
      tx.onlineOrder.findMany({ where: { seenAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
      tx.onlineOrder.count({ where: { seenAt: null } }),
    ]);
    return { newCount, unseen, latestUnseen: unseenRows.map(toView) };
  });
}

export async function setOrderStatus(tenantId: string, deviceId: string, input: OrderStatusInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.onlineOrder.findUnique({ where: { id: input.id } });
    if (!existing) throw new HttpError(404, "Order not found");
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        status: input.status,
        statusChangedAt: new Date(),
        handledByDeviceId: deviceId,
        seenAt: existing.seenAt ?? new Date(),
      },
    });
    return toView(row);
  });
}

export async function getOrder(tenantId: string, id: string) {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.onlineOrder.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, "Order not found");
    return toView(row);
  });
}

/**
 * Records that a POS rang this order up as a sale, and completes it. Idempotent for the SAME sale
 * (a retry after a dropped response is fine); refuses a second, different sale — one web order
 * becomes at most one sale, even with two tills racing.
 */
export async function linkOrderSale(tenantId: string, deviceId: string, input: OrderLinkSaleInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.onlineOrder.findUnique({ where: { id: input.id } });
    if (!existing) throw new HttpError(404, "Order not found");
    if (existing.linkedSaleId && existing.linkedSaleId !== input.saleId) {
      throw new HttpError(
        409,
        `This order was already rung up as receipt ${existing.linkedReceiptNumber ?? existing.linkedSaleId}.`,
      );
    }
    const now = new Date();
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        linkedSaleId: input.saleId,
        linkedReceiptNumber: input.receiptNumber ?? null,
        status: "COMPLETED",
        statusChangedAt: now,
        handledByDeviceId: deviceId,
        seenAt: existing.seenAt ?? now,
      },
    });
    return toView(row);
  });
}

/** Marks orders as seen (clears them from the "new" badge). No ids = everything unseen. */
export async function markOrdersSeen(tenantId: string, ids?: string[]) {
  return withTenantContext(tenantId, async (tx) => {
    const res = await tx.onlineOrder.updateMany({
      where: { seenAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { seenAt: new Date() },
    });
    return { marked: res.count };
  });
}
