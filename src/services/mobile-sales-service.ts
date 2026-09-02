import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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

/** Mirrors DESKTOP's own walkInAwareCustomerName (sale-repository.ts) — bakes a walk-in sale's
 * free-text label ("Scott") into the same customerName field every consumer already reads, so the
 * Owner App shows "Walk-in - Scott" without any caller needing to separately check walkInName. */
function walkInAwareCustomerName(realCustomerName: string | null, walkInName: string | null): string | null {
  if (realCustomerName) return realCustomerName;
  return walkInName ? `Walk-in - ${walkInName}` : null;
}

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

/** Mirrors DESKTOP's own ReceiptsRoute.tsx saleStatusInfo map exactly (approved/pending/rejected per
 * request type) — a completed sale can independently have a void request and a return request, each
 * with its own lifecycle, so this is 6 flags, not one status string. Void applies only to a completed
 * retail sale (receipts) in this system, same as DESKTOP; quotations have no equivalent. */
export type SaleStatusFlags = {
  approvedVoid: boolean;
  pendingVoid: boolean;
  rejectedVoid: boolean;
  approvedReturn: boolean;
  pendingReturn: boolean;
  rejectedReturn: boolean;
};

function emptyStatusFlags(): SaleStatusFlags {
  return {
    approvedVoid: false,
    pendingVoid: false,
    rejectedVoid: false,
    approvedReturn: false,
    pendingReturn: false,
    rejectedReturn: false,
  };
}

/** Batch-builds a saleId -> status-flags map for a whole list, same reasoning as DESKTOP's own
 * useMemo'd map: one query per request-type for however many sales are being listed, not N+1. */
async function getSaleStatusFlagsMap(
  tx: Prisma.TransactionClient,
  tenantId: string,
  saleIds: string[],
): Promise<Map<string, SaleStatusFlags>> {
  const map = new Map<string, SaleStatusFlags>();
  if (saleIds.length === 0) return map;

  const [voids, returns] = await Promise.all([
    tx.saleVoid.findMany({ where: { tenantId, saleId: { in: saleIds } }, select: { saleId: true, status: true } }),
    tx.saleReturn.findMany({ where: { tenantId, saleId: { in: saleIds } }, select: { saleId: true, status: true } }),
  ]);
  for (const voidRequest of voids) {
    const entry = map.get(voidRequest.saleId) ?? emptyStatusFlags();
    if (voidRequest.status === "approved") entry.approvedVoid = true;
    if (voidRequest.status === "pending_approval") entry.pendingVoid = true;
    if (voidRequest.status === "rejected") entry.rejectedVoid = true;
    map.set(voidRequest.saleId, entry);
  }
  for (const returnRequest of returns) {
    const entry = map.get(returnRequest.saleId) ?? emptyStatusFlags();
    if (returnRequest.status === "approved") entry.approvedReturn = true;
    if (returnRequest.status === "pending_approval") entry.pendingReturn = true;
    if (returnRequest.status === "rejected") entry.rejectedReturn = true;
    map.set(returnRequest.saleId, entry);
  }
  return map;
}

export type MobileSaleListItem = SaleStatusFlags & {
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
  deliveryIsDelivered: boolean | null;
  currency: string;
};

type RawItem = { productId: string; quantity: number };
type RawDeliveryFlag = { isDelivered: boolean } | null;

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
    const statusFlagsById = await getSaleStatusFlagsMap(tx, tenantId, sales.map((s) => s.id));

    return sales.map((sale) => ({
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      customerName: walkInAwareCustomerName(
        sale.customerId ? (customerNameById.get(sale.customerId) ?? null) : null,
        sale.walkInName,
      ),
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
      deliveryIsDelivered: (sale.delivery as RawDeliveryFlag)?.isDelivered ?? null,
      currency: tenant.currency,
      ...(statusFlagsById.get(sale.id) ?? emptyStatusFlags()),
    }));
  });
}

/** The owner viewing their own tenant's own sale — a plain authenticated read via the exact same
 * view-model the Share feature renders (buildSharedDocument), not a public-token lookup. Merges in
 * the same void/return status flags listSales exposes (mobile-only concern — kept off
 * SharedDocumentResult itself since SHARE/document-html.ts have no use for it). */
export async function getSale(tenantId: string, saleId: string): Promise<(SharedDocumentResult & SaleStatusFlags) | null> {
  const doc = await buildSharedDocument(tenantId, "sale", saleId);
  if (!doc) return null;
  const flags = await withTenantContext(tenantId, (tx) => getSaleStatusFlagsMap(tx, tenantId, [saleId]));
  return { ...doc, ...(flags.get(saleId) ?? emptyStatusFlags()) };
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

/** Mirrors DESKTOP's own setDeliveryNoteDelivered exactly — same "sales":"edit" permission gate
 * regardless of whether the delivery belongs to a sale or a quotation (see the route's own comment).
 * Delivery lives inline in Sale.delivery JSON on SERVER (unlike DESKTOP's own delivery_notes table),
 * so this is a partial-field update preserving every other key in that JSON untouched. */
export async function setSaleDeliveryDelivered(tenantId: string, id: string, delivered: boolean): Promise<{ id: string }> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.sale.findUnique({ where: { id } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    if (!row.delivery) throw new HttpError(400, "This sale has no delivery attached");
    const now = new Date();
    const delivery = {
      ...(row.delivery as Record<string, unknown>),
      isDelivered: delivered,
      deliveredAt: delivered ? now.toISOString() : null,
    };
    // syncedAt must be set explicitly on every mobile-originated update — see
    // mobile-invoices-service.ts's updateInvoice for the full explanation of this bug class.
    await tx.sale.update({ where: { id }, data: { delivery, localUpdatedAt: now, syncedAt: now } });
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
