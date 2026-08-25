import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { buildSharedDocument, computePaymentStatus, type SharedDocumentResult } from "./share-service.js";

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
