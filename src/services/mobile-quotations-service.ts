import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { buildSharedDocument, computeQuotationStatus, type SharedDocumentResult } from "./share-service.js";

export type MobileQuotationListItem = {
  id: string;
  quotationNumber: string;
  customerName: string | null;
  employeeName: string;
  locationName: string;
  locationId: string;
  grandTotalCents: number;
  validUntil: string;
  status: string;
  createdAt: string;
  currency: string;
};

/** Quotations are their own table (unlike Invoices, which are just Sale rows) — see the Quotation
 * model in schema.prisma. Same recency-cap + batch-join pattern as listSales/listInvoices; status is
 * recomputed live via computeQuotationStatus rather than trusting the stored column, since a
 * validUntil date can pass without any write happening to flip a stored "sent" into "expired". */
export async function listQuotations(tenantId: string, locationId: string | null): Promise<MobileQuotationListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const quotations = await tx.quotation.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
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

    return quotations.map((quotation) => ({
      id: quotation.id,
      quotationNumber: quotation.quotationNumber,
      customerName: quotation.customerId ? (customerNameById.get(quotation.customerId) ?? null) : null,
      employeeName: employeeNameById.get(quotation.employeeId) ?? "—",
      locationName: locationNameById.get(quotation.locationId) ?? "—",
      locationId: quotation.locationId,
      grandTotalCents: quotation.grandTotalCents,
      validUntil: quotation.validUntil,
      status: computeQuotationStatus({ storedStatus: quotation.status, validUntil: quotation.validUntil }),
      createdAt: quotation.localCreatedAt.toISOString(),
      currency: tenant.currency,
    }));
  });
}

/** The owner viewing their own tenant's own quotation — a plain authenticated read via the exact
 * same view-model the Share feature renders (buildSharedDocument), not a public-token lookup. Same
 * reasoning as mobile-sales-service.ts's getSale. */
export async function getQuotation(tenantId: string, quotationId: string): Promise<SharedDocumentResult | null> {
  return buildSharedDocument(tenantId, "quotation", quotationId);
}
