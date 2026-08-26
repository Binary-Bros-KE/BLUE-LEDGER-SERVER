import { randomUUID } from "node:crypto";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";
import {
  buildSharedDeliveryNote,
  buildSharedDocument,
  computePaymentStatus,
  type SharedDeliveryNoteResult,
  type SharedDocumentResult,
} from "./share-service.js";

export type MobileLocation = { id: string; locationName: string };

/** Backs the Owner App's storefront filter chips — same "All" + per-branch pattern already used for
 * Employees, just a fresh lookup since a Sale's own storefront isn't resolved anywhere else yet. */
export async function listLocations(tenantId: string): Promise<MobileLocation[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true }, orderBy: { locationName: "asc" } }),
  );
}

/** "warehouse" and "distribution_center" are reserved for the Main Store — nothing is ever directly
 * sold from there. Mirrors DESKTOP's own shared/types/location.ts isStorefrontType exactly. */
export function isStorefrontLocationType(locationType: string): boolean {
  return locationType !== "warehouse" && locationType !== "distribution_center";
}

/** Backs Checkout's StorefrontPicker for a branch-less employee (Super Admin, typically) — same
 * active/storefront-type-only filter as DESKTOP's own StorefrontPicker.tsx. A branch-scoped employee
 * never needs this; their own branch is always authoritative regardless of what they'd pick here. */
export async function listActiveStorefronts(tenantId: string): Promise<MobileLocation[]> {
  return withTenantContext(tenantId, async (tx) => {
    const locations = await tx.location.findMany({
      where: { tenantId, status: "active" },
      select: { id: true, locationName: true, locationType: true },
      orderBy: { locationName: "asc" },
    });
    return locations.filter((l) => isStorefrontLocationType(l.locationType)).map((l) => ({ id: l.id, locationName: l.locationName }));
  });
}

export type MobileSaleListItem = {
  id: string;
  receiptNumber: string | null;
  customerName: string | null;
  employeeName: string;
  locationName: string;
  locationId: string;
  paymentMethodName: string | null;
  itemCount: number;
  grandTotalCents: number;
  saleStatus: string;
  completedAt: string | null;
  createdAt: string;
  hasDeliveryNote: boolean;
  currency: string;
};

type RawItem = { productId: string; quantity: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** "Sales" here means receipts specifically (invoiceNumber IS NULL) — DESKTOP's own Receipts tab is
 * exactly this same filter; a separate Invoices tab (invoiceNumber IS NOT NULL) covers the rest, so
 * there's no real "Sales vs Receipts" distinction to preserve here. Capped at the 200 most recent —
 * a simple recency window rather than real pagination, deliberately not built out until an actual
 * need for it shows up (search/infinite-scroll is a bigger, separate piece of work). */
export async function listSales(tenantId: string, locationId: string | null): Promise<MobileSaleListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const sales = await tx.sale.findMany({
      where: { tenantId, invoiceNumber: null, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 200,
    });

    const [locations, employees, customers, paymentMethods] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.employee.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
      tx.customer.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
    const paymentMethodNameById = new Map(paymentMethods.map((p) => [p.id, p.name]));

    return sales.map((sale) => ({
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      customerName: sale.customerId ? (customerNameById.get(sale.customerId) ?? null) : null,
      employeeName: employeeNameById.get(sale.employeeId) ?? "—",
      locationName: locationNameById.get(sale.locationId) ?? "—",
      locationId: sale.locationId,
      paymentMethodName: sale.paymentMethodId ? (paymentMethodNameById.get(sale.paymentMethodId) ?? null) : null,
      itemCount: asArray<RawItem>(sale.items).reduce((sum, item) => sum + item.quantity, 0),
      grandTotalCents: sale.grandTotalCents,
      saleStatus: sale.saleStatus,
      completedAt: sale.completedAt ? sale.completedAt.toISOString() : null,
      createdAt: sale.localCreatedAt.toISOString(),
      hasDeliveryNote: sale.delivery !== null,
      currency: tenant.currency,
    }));
  });
}

/** The owner viewing their own tenant's own sale — a plain authenticated read via the exact same
 * view-model the Share feature renders (buildSharedDocument), not a public-token lookup. */
export async function getSale(tenantId: string, saleId: string): Promise<SharedDocumentResult | null> {
  return buildSharedDocument(tenantId, "sale", saleId);
}

/** Same non-pricing view-model DESKTOP's own DeliveryNotePreview and the public SHARE page render —
 * see buildSharedDeliveryNote's own doc comment for why it carries no fee/cost figures. */
export async function getSaleDeliveryNote(tenantId: string, saleId: string): Promise<SharedDeliveryNoteResult | null> {
  return buildSharedDeliveryNote(tenantId, "sale", saleId);
}

/** Toggles the "Tax Breakdown" section on/off for an already-created sale (receipt or invoice) —
 * mirrors DESKTOP's own setSaleIncludeTaxBreakdown exactly (works regardless of sale status, a
 * historical receipt might need re-sharing without tax info). Covers both receipts and invoices,
 * same as DESKTOP — an invoice is just a Sale row with invoiceNumber set. */
export async function setSaleIncludeTaxBreakdown(tenantId: string, id: string, value: boolean): Promise<{ id: string }> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.sale.findUnique({ where: { id } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    // syncedAt must be set explicitly on every mobile-originated update — see
    // mobile-invoices-service.ts's updateInvoice for the full explanation of this bug class.
    const now = new Date();
    await tx.sale.update({ where: { id }, data: { includeTaxBreakdown: value, localUpdatedAt: now, syncedAt: now } });
    return { id };
  });
}

/** Same as setSaleIncludeTaxBreakdown above, for the independent "Include storefront information"
 * toggle — see Sale["includeBusinessInfo"]'s own doc comment (schema.prisma). */
export async function setSaleIncludeBusinessInfo(tenantId: string, id: string, value: boolean): Promise<{ id: string }> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.sale.findUnique({ where: { id } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    const now = new Date();
    await tx.sale.update({ where: { id }, data: { includeBusinessInfo: value, localUpdatedAt: now, syncedAt: now } });
    return { id };
  });
}

type RawSaleItemFull = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

type RawSaleReturnItem = { saleItemId: string; quantity: number };

export type MobileReturnableItem = {
  saleItemId: string;
  productId: string;
  productName: string;
  quantitySold: number;
  /** Already restocked by an APPROVED return — mirrors DESKTOP's own
   * findApprovedReturnedQuantityForSaleItem (only approved returns count against eligibility;
   * multiple pending requests against the same line aren't blocked outright). */
  alreadyReturnedQuantity: number;
  remainingQuantity: number;
  unitPriceCents: number;
};

/** Backs the mobile "Request Return" form's item/quantity picker — the display-only SharedDocument
 * (buildSharedDocument, used by getSale) has no saleItemId on its line items at all, so this is a
 * separate, raw lookup, same "edit-data is a different shape from the display view" precedent
 * mobile-invoices-service.ts's getInvoiceEditData already established. Receipts only (an invoice
 * has its own separate Request Cancellation flow on both DESKTOP and mobile instead) — the caller
 * decides whether to show the button; this function itself works for any completed sale. */
export async function getSaleReturnableItems(tenantId: string, saleId: string): Promise<MobileReturnableItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale || sale.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    if (sale.saleStatus !== "completed") throw new HttpError(400, "Only completed sales can have returns");

    const items = asArray<RawSaleItemFull>(sale.items);
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
    const productNameById = new Map(products.map((p) => [p.id, p.name]));

    const approvedReturns = await tx.saleReturn.findMany({ where: { tenantId, saleId, status: "approved" }, select: { items: true } });
    const returnedBySaleItemId = new Map<string, number>();
    for (const ret of approvedReturns) {
      for (const item of asArray<RawSaleReturnItem>(ret.items)) {
        returnedBySaleItemId.set(item.saleItemId, (returnedBySaleItemId.get(item.saleItemId) ?? 0) + item.quantity);
      }
    }

    return items.map((item) => {
      const alreadyReturnedQuantity = returnedBySaleItemId.get(item.id) ?? 0;
      return {
        saleItemId: item.id,
        productId: item.productId,
        productName: productNameById.get(item.productId) ?? "Unknown product",
        quantitySold: item.quantity,
        alreadyReturnedQuantity,
        remainingQuantity: Math.max(0, item.quantity - alreadyReturnedQuantity),
        unitPriceCents: item.unitPriceCents,
      };
    });
  });
}

/** A cashier's request to return some or all of the items on a completed sale — gated by
 * "sales":"edit" (the permission a normal Cashier already has), not "approvals":"approve". The
 * original sale is never modified and NOTHING is restocked here — that only happens once a manager
 * approves the request, and approval only ever happens from DESKTOP (see sale-return-service.ts's
 * approveSaleReturn) — mobile deliberately has no approval UI for returns at all, request-only.
 * Mirrors DESKTOP's own requestSaleReturn exactly, including its per-line eligible-quantity check. */
export async function requestSaleReturn(
  tenantId: string,
  employeeId: string,
  saleId: string,
  input: { reason: string; notes?: string; items: Array<{ saleItemId: string; quantity: number }> },
): Promise<{ id: string }> {
  return withTenantContext(tenantId, async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale || sale.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    if (sale.saleStatus !== "completed") throw new HttpError(400, "Only completed sales can have returns");

    const saleItems = asArray<RawSaleItemFull>(sale.items);
    const saleItemById = new Map(saleItems.map((i) => [i.id, i]));

    const approvedReturns = await tx.saleReturn.findMany({ where: { tenantId, saleId, status: "approved" }, select: { items: true } });
    const returnedBySaleItemId = new Map<string, number>();
    for (const ret of approvedReturns) {
      for (const item of asArray<RawSaleReturnItem>(ret.items)) {
        returnedBySaleItemId.set(item.saleItemId, (returnedBySaleItemId.get(item.saleItemId) ?? 0) + item.quantity);
      }
    }

    const preparedItems = input.items.map((requested) => {
      const saleItem = saleItemById.get(requested.saleItemId);
      if (!saleItem) throw new HttpError(400, "One of the selected items does not belong to this sale");
      const alreadyReturned = returnedBySaleItemId.get(saleItem.id) ?? 0;
      const remaining = saleItem.quantity - alreadyReturned;
      if (requested.quantity > remaining) {
        throw new HttpError(400, `Only ${remaining} unit(s) of this item remain eligible for return`);
      }
      return {
        id: `sale_return_item_${randomUUID()}`,
        saleItemId: saleItem.id,
        productId: saleItem.productId,
        quantity: requested.quantity,
        unitPriceCents: saleItem.unitPriceCents,
        lineTotalCents: saleItem.unitPriceCents * requested.quantity,
        createdAt: new Date().toISOString(),
      };
    });

    const now = new Date();
    const id = `sale_return_${randomUUID()}`;
    await tx.saleReturn.create({
      data: {
        id,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        saleId,
        status: "pending_approval",
        reason: input.reason.trim(),
        notes: input.notes?.trim() || null,
        requestedBy: employeeId,
        requestedAt: now,
        approvedBy: null,
        approvedAt: null,
        items: preparedItems,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });

    return { id };
  });
}

export type MobileInvoiceListItem = {
  id: string;
  invoiceNumber: string | null;
  customerName: string | null;
  employeeName: string;
  locationName: string;
  locationId: string;
  grandTotalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  dueDate: string | null;
  paymentStatus: string;
  createdAt: string;
  currency: string;
};

/** Same underlying `sales` table as listSales, just the opposite filter (invoiceNumber IS NOT NULL)
 * — an invoice is a Sale row, not a separate entity, same as everywhere else this project treats
 * them. paymentStatus is recomputed live (computePaymentStatus) rather than trusting the stored
 * column, same reasoning as DESKTOP's own mapInvoiceListRow — a due date can pass without any write
 * happening to flip a stored "unpaid" into "overdue". */
export async function listInvoices(tenantId: string, locationId: string | null): Promise<MobileInvoiceListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const invoices = await tx.sale.findMany({
      where: { tenantId, invoiceNumber: { not: null }, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 200,
    });

    const [locations, employees, customers] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.employee.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
      tx.customer.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

    return invoices.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerId ? (customerNameById.get(invoice.customerId) ?? null) : null,
      employeeName: employeeNameById.get(invoice.employeeId) ?? "—",
      locationName: locationNameById.get(invoice.locationId) ?? "—",
      locationId: invoice.locationId,
      grandTotalCents: invoice.grandTotalCents,
      amountPaidCents: invoice.amountPaidCents,
      balanceDueCents: invoice.balanceDueCents,
      dueDate: invoice.dueDate,
      paymentStatus: computePaymentStatus({
        balanceDueCents: invoice.balanceDueCents,
        amountPaidCents: invoice.amountPaidCents,
        dueDate: invoice.dueDate,
        cancelled: invoice.paymentStatus === "cancelled",
      }),
      createdAt: invoice.localCreatedAt.toISOString(),
      currency: tenant.currency,
    }));
  });
}
