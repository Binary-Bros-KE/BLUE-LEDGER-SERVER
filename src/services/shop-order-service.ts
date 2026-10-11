import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { ShopContext } from "../middleware/shop-tenant.js";
import {
  ONLINE_ORDER_STATUSES,
  type OrderFulfilmentInput,
  type OrderLinkSaleInput,
  type OrderListInput,
  type OrderPaymentAddInput,
  type OrderPaymentRemoveInput,
  type OrderStatusInput,
  type ShopOrderCreateInput,
} from "../schemas/shop.js";
import { activeSharedVariants, parseVariantConfig, variantLabel } from "../lib/variants.js";
import { readWebPricing, shopperPrice, shopperVariantPrice } from "../lib/web-pricing.js";

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

/** Same shape as the POS's SalePayment, so the payments carry onto the sale unchanged. */
export type OnlineOrderPayment = {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  notes: string | null;
};

export type OnlineOrderHistoryEntry = {
  at: string;
  kind: "status" | "payment" | "payment_removed" | "fulfilment";
  /** the new status (kind "status") or route "pickup"/"delivery" (kind "fulfilment") */
  status?: string;
  amountCents?: number;
  /** payment method name, or the delivery option chosen */
  method?: string;
  /** who on the POS did it */
  by?: string | null;
  rider?: string | null;
  receipt?: string;
};

function readPayments(json: Prisma.JsonValue): OnlineOrderPayment[] {
  return Array.isArray(json) ? (json as unknown as OnlineOrderPayment[]) : [];
}

export type OnlineOrderStockHold = {
  locationId: string;
  items: { productId: string; qty: number }[];
  heldAt: string;
};

function readStockHold(json: Prisma.JsonValue | null): OnlineOrderStockHold | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const hold = json as unknown as OnlineOrderStockHold;
  return typeof hold.locationId === "string" && Array.isArray(hold.items) ? hold : null;
}

function readHistory(json: Prisma.JsonValue): OnlineOrderHistoryEntry[] {
  return Array.isArray(json) ? (json as unknown as OnlineOrderHistoryEntry[]) : [];
}

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
  /** "pickup" | "delivery" */
  deliveryType: string;
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
  payments: OnlineOrderPayment[];
  paidCents: number;
  /** totalCents - paidCents (never negative) */
  balanceCents: number;
  history: OnlineOrderHistoryEntry[];
  riderId: string | null;
  riderName: string | null;
  /** stock held out of a branch for this order (set on confirmation) */
  stockHold: OnlineOrderStockHold | null;
};

export function formatOrderNumber(seq: number): string {
  return `WEB-${String(seq).padStart(4, "0")}`;
}

type OrderRow = Prisma.OnlineOrderGetPayload<object>;

function toView(r: OrderRow): OnlineOrderView {
  const payments = readPayments(r.paymentsJson);
  const paidCents = payments.reduce((s, p) => s + p.amountCents, 0);
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
    deliveryType: r.deliveryType,
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
    payments,
    paidCents,
    balanceCents: Math.max(0, r.totalCents - paidCents),
    history: readHistory(r.historyJson),
    riderId: r.riderId,
    riderName: r.riderName,
    stockHold: readStockHold(r.stockHoldJson),
  };
}

// --- Storefront side (public, tenant resolved from the domain) ------------------------------------

export async function createOrder(
  ctx: ShopContext,
  input: ShopOrderCreateInput,
): Promise<{ orderNumber: string; totalCents: number; subtotalCents: number; deliveryFeeCents: number; deliveryType: string; currency: string; items: OnlineOrderItem[] }> {
  // Merge duplicate lines for the same product + variant (a tampered cart could repeat one).
  const lines = new Map<string, { productId: string; variantKey: string | null; qty: number }>();
  for (const it of input.items) {
    const variantKey = it.variantKey ?? null;
    const key = `${it.productId}|${variantKey ?? ""}`;
    const prev = lines.get(key);
    lines.set(key, { productId: it.productId, variantKey, qty: Math.min(999, (prev?.qty ?? 0) + it.qty) });
  }
  const productIds = [...new Set([...lines.values()].map((l) => l.productId))];
  // Same website pricing the catalog shows (markup included) — the order charges what was displayed.
  const pricing = readWebPricing(ctx.store.pricingJson);

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
      const shopper = shopperPrice(p, pricing);
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
      const unit = shopperVariantPrice(variant, shopper, pricing);
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
    const pickup = input.deliveryType === "pickup";
    if (!pickup && !input.deliveryAddress?.trim()) {
      throw new HttpError(400, "Please enter your delivery address, or choose to pick up from the shop.");
    }
    const activeMethods = pickup ? 0 : await tx.webDeliveryMethod.count({ where: { active: true } });
    if (pickup) {
      // collected from the shop — no delivery option, no fee
    } else if (input.deliveryMethodId) {
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
      deliveryAddress: pickup ? null : input.deliveryAddress || null,
      notes: input.notes || null,
      deliveryMethodId,
      deliveryMethodName,
      deliveryFeeCents,
      paymentMethod: "to_be_arranged",
      deliveryType: pickup ? "pickup" : "delivery",
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
      deliveryType: row.deliveryType,
      currency: row.currency,
      items,
    };
  });
}

// --- POS side (device-authed /shop-admin/orders/*) ------------------------------------------------

/**
 * The steps an order walks through, per fulfilment route. Each step is unlocked only by the one
 * before it; COMPLETED comes after the last step and is reached only by converting the order to a
 * POS sale (linkOrderSale) — never by a plain status change. Cancelling is allowed up to, but not
 * after, the hand-over (PICKED_UP / DELIVERED).
 */
export const ORDER_FLOWS = {
  pickup: ["NEW", "CONFIRMED", "READY", "PICKED_UP"],
  delivery: ["NEW", "CONFIRMED", "SHIPPED", "DELIVERED"],
} as const;

const HANDED_OVER = new Set(["PICKED_UP", "DELIVERED"]);
/** The route can be switched only before anything has been prepared for it. */
const ROUTE_EDITABLE = new Set(["NEW", "CONFIRMED"]);

function flowFor(deliveryType: string): readonly string[] {
  return deliveryType === "pickup" ? ORDER_FLOWS.pickup : ORDER_FLOWS.delivery;
}

const STATUS_WORDS: Record<string, string> = {
  NEW: "pending",
  CONFIRMED: "confirmed",
  READY: "ready for pickup",
  PICKED_UP: "picked up",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

/** Locks the order row for the rest of the transaction, so two tills can't interleave a status
 * change / payment on the same order (e.g. both recording the last payment and overpaying it). */
async function lockOrder(tx: Prisma.TransactionClient, id: string): Promise<OrderRow> {
  await tx.$executeRaw`SELECT 1 FROM "online_orders" WHERE "id" = ${id} FOR UPDATE`;
  const row = await tx.onlineOrder.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, "Order not found");
  return row;
}

function historyWith(row: OrderRow, entry: Omit<OnlineOrderHistoryEntry, "at">, at = new Date()): Prisma.InputJsonValue {
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null));
  return [...readHistory(row.historyJson), { at: at.toISOString(), ...clean }] as unknown as Prisma.InputJsonValue;
}

function assertOpen(row: OrderRow, action: string): void {
  if (row.linkedSaleId || row.status === "COMPLETED") {
    throw new HttpError(409, `${formatOrderNumber(row.orderSeq)} is already completed — ${action} isn't possible any more.`);
  }
  if (row.status === "CANCELLED") {
    throw new HttpError(409, `${formatOrderNumber(row.orderSeq)} is cancelled — reopen it first.`);
  }
}

/** Search + date filters (everything except status) — also scopes the per-status counts. */
function listScope(q: OrderListInput): Prisma.OnlineOrderWhereInput[] {
  const and: Prisma.OnlineOrderWhereInput[] = [];
  if (q.from || q.to) {
    and.push({ createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } });
  }
  const term = q.search?.trim();
  if (term) {
    const or: Prisma.OnlineOrderWhereInput[] = [
      { customerName: { contains: term, mode: "insensitive" } },
      { customerEmail: { contains: term, mode: "insensitive" } },
    ];
    const digits = term.replace(/\D/g, "");
    // "WEB-0012", "web12" or "12" → order 12. A long digit run is a phone number, not an order.
    if (/^(web-?)?\d{1,6}$/i.test(term)) or.push({ orderSeq: Number(digits) });
    if (digits.length >= 3) or.push({ customerPhone: { contains: digits.length > 9 ? digits.slice(-9) : digits } });
    and.push({ OR: or });
  }
  return and;
}

export async function listOrders(tenantId: string, q: OrderListInput) {
  return withTenantContext(tenantId, async (tx) => {
    const scope = listScope(q);
    const statusFilter: Prisma.OnlineOrderWhereInput = q.statuses
      ? { status: { in: q.statuses } }
      : q.status === "ALL"
        ? {}
        : { status: q.status };
    const where: Prisma.OnlineOrderWhereInput = { AND: [...scope, statusFilter] };
    const closed = ["COMPLETED", "CANCELLED"];
    // Orders still being worked on come first, then completed, then cancelled — newest first within
    // each. Paged as one list: open orders fill pages before any closed one appears.
    const [openRows, openTotal] = await Promise.all([
      tx.onlineOrder.findMany({
        where: { AND: [where, { status: { notIn: closed } }] },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.onlineOrder.count({ where: { AND: [where, { status: { notIn: closed } }] } }),
    ]);
    const closedSkip = Math.max(0, (q.page - 1) * q.pageSize - openTotal);
    const closedTake = q.pageSize - openRows.length;
    const closedRows =
      closedTake > 0
        ? await tx.onlineOrder.findMany({
            where: { AND: [where, { status: { in: closed } }] },
            // COMPLETED sorts before CANCELLED alphabetically
            orderBy: [{ status: "asc" }, { createdAt: "desc" }],
            skip: closedSkip,
            take: closedTake,
          })
        : [];
    const rows = [...openRows, ...closedRows];
    const [total, grouped, unseen] = await Promise.all([
      tx.onlineOrder.count({ where }),
      tx.onlineOrder.groupBy({ by: ["status"], where: { AND: scope }, _count: { _all: true } }),
      tx.onlineOrder.count({ where: { seenAt: null } }),
    ]);
    const counts: Record<string, number> = Object.fromEntries(ONLINE_ORDER_STATUSES.map((s) => [s, 0]));
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

/**
 * Moves an order one step: forward to the next step of its route, back one step (undoing a
 * mis-click), to CANCELLED (before the hand-over), or from CANCELLED back to NEW (reopen).
 * Anything else — skipping a step, or COMPLETED (that's linkOrderSale's job) — is refused here,
 * so every till follows the same order no matter which build it runs.
 */
export async function setOrderStatus(tenantId: string, deviceId: string, input: OrderStatusInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockOrder(tx, input.id);
    const number = formatOrderNumber(existing.orderSeq);
    const from = existing.status;
    const to = input.status;
    const existingHold = readStockHold(existing.stockHoldJson);
    // Another till already moved it here — any hold this request carries is surplus; say so.
    if (from === to) return { ...toView(existing), holdAccepted: false, releasedHold: null };

    if (to === "COMPLETED") {
      throw new HttpError(409, `Complete ${number} from the POS — that records it as a sale.`);
    }
    if (existing.linkedSaleId || from === "COMPLETED") {
      throw new HttpError(409, `${number} is already completed and recorded as a sale.`);
    }

    const flow = flowFor(existing.deliveryType);
    if (to === "CANCELLED") {
      if (HANDED_OVER.has(from)) {
        throw new HttpError(409, `${number} was already ${STATUS_WORDS[from]} — it can't be cancelled now.`);
      }
    } else if (from === "CANCELLED") {
      if (to !== "NEW") throw new HttpError(409, `Reopen ${number} first — it goes back to pending.`);
    } else {
      const at = flow.indexOf(from);
      const target = flow.indexOf(to);
      if (target === -1) {
        throw new HttpError(409, `"${STATUS_WORDS[to] ?? to}" isn't a step for a ${existing.deliveryType} order.`);
      }
      // An order sitting on a step its route doesn't have can only have come from an older build —
      // let it rejoin the flow anywhere up to the hand-over rather than getting stuck.
      const allowed = at === -1 ? !HANDED_OVER.has(to) : target === at + 1 || target === at - 1;
      if (!allowed) {
        const next = flow[at + 1];
        throw new HttpError(
          409,
          next
            ? `${number} is ${STATUS_WORDS[from]} — mark it ${STATUS_WORDS[next]} first.`
            : `${number} is ${STATUS_WORDS[from]} — the only step left is completing it as a sale.`,
        );
      }
    }

    const now = new Date();
    const shipping = to === "SHIPPED" ? { riderId: input.riderId ?? null, riderName: input.riderName ?? null } : {};
    // Back to pending / cancelled gives the held stock back — returned to the caller (who writes the
    // release movements) and cleared here in the same locked update, so only one till ever does it.
    const releasedHold = (to === "NEW" || to === "CANCELLED") && existingHold ? existingHold : null;
    const holdAccepted = !existingHold && !releasedHold && !!input.stockHold && to !== "NEW" && to !== "CANCELLED";
    const hold: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined = releasedHold
      ? Prisma.DbNull
      : holdAccepted
        ? ({ ...input.stockHold!, heldAt: now.toISOString() } as Prisma.InputJsonValue)
        : undefined;
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        status: to,
        ...shipping,
        ...(hold !== undefined ? { stockHoldJson: hold } : {}),
        statusChangedAt: now,
        handledByDeviceId: deviceId,
        seenAt: existing.seenAt ?? now,
        historyJson: historyWith(
          existing,
          { kind: "status", status: to, by: input.actorName, rider: to === "SHIPPED" ? input.riderName : undefined },
          now,
        ),
      },
    });
    return { ...toView(row), holdAccepted, releasedHold };
  });
}

/** Records money received for an order before it becomes a sale. Never more than what's still owed,
 * so the payments always add up to at most the total — exactly what the sale will need. */
export async function addOrderPayment(tenantId: string, deviceId: string, input: OrderPaymentAddInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockOrder(tx, input.id);
    assertOpen(existing, "recording a payment");
    const payments = readPayments(existing.paymentsJson);
    const balance = existing.totalCents - payments.reduce((s, p) => s + p.amountCents, 0);
    if (balance <= 0) throw new HttpError(409, `${formatOrderNumber(existing.orderSeq)} is already fully paid.`);
    if (input.amountCents > balance) {
      throw new HttpError(
        409,
        `Only ${existing.currency} ${(balance / 100).toFixed(2)} is still owed on ${formatOrderNumber(existing.orderSeq)}.`,
      );
    }
    const now = new Date();
    const payment: OnlineOrderPayment = {
      id: `payment_${randomUUID()}`,
      paymentMethodId: input.paymentMethodId,
      paymentMethodName: input.paymentMethodName,
      amountCents: input.amountCents,
      reference: input.reference ?? null,
      receivedBy: input.receivedBy,
      receivedByName: input.receivedByName,
      receivedAt: now.toISOString(),
      notes: input.notes || null,
    };
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        paymentsJson: [...payments, payment] as unknown as Prisma.InputJsonValue,
        handledByDeviceId: deviceId,
        seenAt: existing.seenAt ?? now,
        historyJson: historyWith(
          existing,
          { kind: "payment", amountCents: input.amountCents, method: input.paymentMethodName, by: input.receivedByName },
          now,
        ),
      },
    });
    return toView(row);
  });
}

/** Takes back a payment recorded by mistake (or refunded) while the order is still open. */
export async function removeOrderPayment(tenantId: string, deviceId: string, input: OrderPaymentRemoveInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockOrder(tx, input.id);
    if (existing.linkedSaleId || existing.status === "COMPLETED") {
      throw new HttpError(409, `${formatOrderNumber(existing.orderSeq)} is already a sale — its payments are on the receipt now.`);
    }
    const payments = readPayments(existing.paymentsJson);
    const removed = payments.find((p) => p.id === input.paymentId);
    if (!removed) throw new HttpError(404, "Payment not found");
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        paymentsJson: payments.filter((p) => p.id !== input.paymentId) as unknown as Prisma.InputJsonValue,
        handledByDeviceId: deviceId,
        historyJson: historyWith(existing, {
          kind: "payment_removed",
          amountCents: removed.amountCents,
          method: removed.paymentMethodName,
          by: input.actorName,
        }),
      },
    });
    return toView(row);
  });
}

/**
 * Switches an order between pick-up and delivery (the customer changed their mind) while it's still
 * pending/confirmed. Delivery re-reads the fee from this shop's own delivery option, exactly as
 * checkout does; pick-up drops it. Refused if what's already been paid would exceed the new total.
 */
export async function setOrderFulfilment(tenantId: string, deviceId: string, input: OrderFulfilmentInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockOrder(tx, input.id);
    const number = formatOrderNumber(existing.orderSeq);
    assertOpen(existing, "changing pick-up / delivery");
    if (!ROUTE_EDITABLE.has(existing.status)) {
      throw new HttpError(409, `${number} is already ${STATUS_WORDS[existing.status]} — pick-up / delivery can't change now.`);
    }

    let deliveryMethodId: string | null = null;
    let deliveryMethodName: string | null = null;
    let deliveryFeeCents = 0;
    // Kept while it's a pick-up (only read for delivery orders), so switching back to delivery
    // doesn't lose the address the shopper typed at checkout.
    let deliveryAddress: string | null = existing.deliveryAddress;
    if (input.deliveryType === "delivery") {
      deliveryAddress = input.deliveryAddress?.trim() || existing.deliveryAddress?.trim() || null;
      if (!deliveryAddress) throw new HttpError(400, "Enter the delivery address.");
      if (input.deliveryMethodId) {
        const m = await tx.webDeliveryMethod.findFirst({ where: { id: input.deliveryMethodId, active: true } });
        if (!m) throw new HttpError(409, "That delivery option is no longer available. Choose another.");
        deliveryMethodId = m.id;
        deliveryMethodName = m.name;
        deliveryFeeCents = m.priceCents;
      }
    }

    const totalCents = existing.subtotalCents + deliveryFeeCents;
    const paid = readPayments(existing.paymentsJson).reduce((s, p) => s + p.amountCents, 0);
    if (paid > totalCents) {
      throw new HttpError(
        409,
        `${existing.currency} ${(paid / 100).toFixed(2)} is already paid but the new total would be ${existing.currency} ${(
          totalCents / 100
        ).toFixed(2)}. Remove or refund a payment first.`,
      );
    }

    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        deliveryType: input.deliveryType,
        deliveryAddress,
        deliveryMethodId,
        deliveryMethodName,
        deliveryFeeCents,
        totalCents,
        handledByDeviceId: deviceId,
        historyJson: historyWith(existing, {
          kind: "fulfilment",
          status: input.deliveryType,
          method: deliveryMethodName ?? undefined,
          by: input.actorName,
        }),
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
 * Records that a POS converted this order into a sale, and completes it. Idempotent for the SAME
 * sale (a retry after a dropped response is fine); refuses a second, different sale — one web order
 * becomes at most one sale, even with two tills racing.
 *
 * Deliberately NOT gated on the order's step: by the time this is called the sale already exists on
 * the till, so refusing would only leave a real sale with an open order that another till could sell
 * again. The current POS only completes from picked up / delivered; older builds rang orders up
 * straight from pending/confirmed and must still be able to link.
 */
export async function linkOrderSale(tenantId: string, deviceId: string, input: OrderLinkSaleInput) {
  return withTenantContext(tenantId, async (tx) => {
    const existing = await lockOrder(tx, input.id);
    if (existing.linkedSaleId) {
      if (existing.linkedSaleId === input.saleId) return toView(existing);
      throw new HttpError(
        409,
        `This order was already completed as receipt ${existing.linkedReceiptNumber ?? existing.linkedSaleId}.`,
      );
    }
    const now = new Date();
    const row = await tx.onlineOrder.update({
      where: { id: input.id },
      data: {
        linkedSaleId: input.saleId,
        linkedReceiptNumber: input.receiptNumber ?? null,
        // the POS released the hold inside the sale's own transaction
        stockHoldJson: Prisma.DbNull,
        status: "COMPLETED",
        statusChangedAt: now,
        handledByDeviceId: deviceId,
        seenAt: existing.seenAt ?? now,
        historyJson: historyWith(
          existing,
          { kind: "status", status: "COMPLETED", by: input.actorName, receipt: input.receiptNumber ?? undefined },
          now,
        ),
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
