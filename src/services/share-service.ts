import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { createShareLinkSchema } from "../schemas/share.js";

/** ~1 year, matching the user's own "expire after about a year" — the link's signature carries
 * its own expiry, so there's nothing to store or clean up server-side (see MobileLoginAttempt's
 * own naming for the contrast: THIS feature deliberately has no equivalent table at all). */
const SHARE_LINK_EXPIRY = "365d";

type ShareEntity = "sale" | "quotation";
type ShareTokenPayload = { tenantId: string; entity: ShareEntity; entityId: string; aud: "share-link" };

export async function createShareLink(input: unknown): Promise<{ url: string }> {
  const parsed = createShareLinkSchema.parse(input);

  const exists = await withTenantContext(parsed.tenantId, (tx) =>
    parsed.entity === "sale"
      ? tx.sale.findUnique({ where: { id: parsed.entityId }, select: { id: true } })
      : tx.quotation.findUnique({ where: { id: parsed.entityId }, select: { id: true } }),
  );
  if (!exists) {
    throw new NotFoundError(`${parsed.entity === "sale" ? "Receipt/invoice" : "Quotation"} not found`);
  }

  const payload: ShareTokenPayload = {
    tenantId: parsed.tenantId,
    entity: parsed.entity,
    entityId: parsed.entityId,
    aud: "share-link",
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: SHARE_LINK_EXPIRY });
  return { url: `${env.SHARE_APP_BASE_URL}/r/${token}` };
}

// ---------------------------------------------------------------------------------------------
// Shared document view model — ported from DESKTOP's shared/lib/receipt.ts (buildReceiptViewModel)
// and printer-service.ts (resolveDocumentBusiness), extended with the small invoice/quotation-only
// fields. Sale.items/Quotation.items are JSON blobs without a productName (see
// mobile-metrics-service.ts's own note on this) — resolved here via a Product lookup, same pattern.
// ---------------------------------------------------------------------------------------------

export type DocumentKind = "receipt" | "invoice" | "quotation";

export type SharedLineItem = { name: string; quantity: number; unitPriceCents: number; lineTotalCents: number };

export type SharedDocumentResult = {
  documentKind: DocumentKind;
  businessName: string;
  physicalAddress: string | null;
  primaryPhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  currency: string;
  documentNumber: string | null;
  dateLabel: string;
  employeeName: string;
  branchName: string;
  customerName: string | null;
  items: SharedLineItem[];
  extraLines: SharedLineItem[];
  subtotalCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  grandTotalCents: number;
  paymentMethodName: string | null;
  paymentReference: string | null;
  amountReceivedCents: number | null;
  changeGivenCents: number | null;
  // invoice-only
  dueDate: string | null;
  balanceDueCents: number | null;
  paymentStatus: string | null;
  // quotation-only
  validUntil: string | null;
  quotationStatus: string | null;
};

type RawItem = { productId: string; quantity: number; unitPriceCents: number; lineTotalCents: number };
type RawServiceCharge = { name: string; feeCents: number };
type RawDelivery = { feeCents: number } | null;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Ports DESKTOP's computePaymentStatus (shared/lib/invoice.ts) — derives live status from the
 * numbers rather than trusting a value that goes stale as the calendar moves past a due date. */
function computePaymentStatus(params: {
  balanceDueCents: number;
  amountPaidCents: number;
  dueDate: string | null;
  cancelled: boolean;
}): string {
  if (params.cancelled) return "cancelled";
  if (params.balanceDueCents <= 0) return "paid";
  if (params.dueDate && new Date(params.dueDate).getTime() < Date.now()) return "overdue";
  if (params.amountPaidCents > 0) return "partially_paid";
  return "unpaid";
}

/** Ports DESKTOP's computeQuotationStatus (shared/lib/quotation.ts) — rejected/converted are
 * terminal, otherwise a date past validUntil means expired regardless of the stored status. */
function computeQuotationStatus(params: { storedStatus: string; validUntil: string }): string {
  if (params.storedStatus === "rejected" || params.storedStatus === "converted") return params.storedStatus;
  if (new Date(params.validUntil).getTime() < Date.now()) return "expired";
  return params.storedStatus;
}

type TenantBusinessDefaults = { name: string; physicalAddress: string | null; contactPhone: string | null; currency: string };

/** Ports printer-service.ts's resolveDocumentBusiness — the document's own storefront overrides
 * the tenant-wide Business Profile defaults, falling back when the storefront hasn't set its own.
 * Tenant-level receiptHeader/receiptFooter don't exist in the synced schema at all (only the
 * Location-level ones do) — a real gap, not something to silently paper over, so those two simply
 * have no tenant-wide fallback here; a document whose storefront hasn't set its own header/footer
 * just shows none, same as it would locally in that same case. */
function resolveBusinessInfo(
  location: { locationName: string; physicalAddress: string | null; phone: string | null; receiptHeader: string | null; receiptFooter: string | null } | null,
  tenant: TenantBusinessDefaults,
): {
  businessName: string;
  physicalAddress: string | null;
  primaryPhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  currency: string;
} {
  return {
    businessName: location?.locationName ?? tenant.name,
    physicalAddress: location?.physicalAddress ?? tenant.physicalAddress,
    primaryPhone: location?.phone ?? tenant.contactPhone,
    receiptHeader: location?.receiptHeader ?? null,
    receiptFooter: location?.receiptFooter ?? null,
    currency: tenant.currency,
  };
}

function buildExtraLines(serviceCharges: unknown, delivery: unknown): SharedLineItem[] {
  const charges = asArray<RawServiceCharge>(serviceCharges).map((charge) => ({
    name: charge.name,
    quantity: 1,
    unitPriceCents: charge.feeCents,
    lineTotalCents: charge.feeCents,
  }));
  const deliveryRow = delivery as RawDelivery;
  const deliveryLine = deliveryRow
    ? [{ name: "Delivery Fee", quantity: 1, unitPriceCents: deliveryRow.feeCents, lineTotalCents: deliveryRow.feeCents }]
    : [];
  return [...charges, ...deliveryLine];
}

export async function getSharedDocument(token: string): Promise<SharedDocumentResult> {
  let payload: ShareTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as ShareTokenPayload;
  } catch {
    throw new HttpError(410, "This link has expired or is no longer valid.");
  }
  if (payload.aud !== "share-link") {
    throw new HttpError(410, "This link has expired or is no longer valid.");
  }
  const { tenantId, entity, entityId } = payload;

  const tenantRow = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, physicalAddress: true, contactPhone: true, currency: true },
  });
  if (!tenantRow) throw new NotFoundError("Document not found");

  return withTenantContext(tenantId, async (tx) => {
    if (entity === "sale") {
      const sale = await tx.sale.findUnique({ where: { id: entityId } });
      if (!sale) throw new NotFoundError("Document not found");

      const items = asArray<RawItem>(sale.items);
      const [location, employee, customer, paymentMethod, products] = await Promise.all([
        tx.location.findUnique({ where: { id: sale.locationId } }),
        tx.employee.findUnique({ where: { id: sale.employeeId } }),
        sale.customerId ? tx.customer.findUnique({ where: { id: sale.customerId } }) : Promise.resolve(null),
        sale.paymentMethodId ? tx.paymentMethod.findUnique({ where: { id: sale.paymentMethodId } }) : Promise.resolve(null),
        tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true } }),
      ]);
      const productNameById = new Map(products.map((p) => [p.id, p.name]));

      const isInvoice = sale.invoiceNumber !== null;
      const business = resolveBusinessInfo(location, tenantRow);

      return {
        documentKind: isInvoice ? "invoice" : "receipt",
        ...business,
        documentNumber: isInvoice ? sale.invoiceNumber : sale.receiptNumber,
        dateLabel: (sale.completedAt ?? sale.localCreatedAt).toISOString(),
        employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "—",
        branchName: location?.locationName ?? "—",
        customerName: customer?.name ?? null,
        items: items.map((item) => ({
          name: productNameById.get(item.productId) ?? "Unknown product",
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          lineTotalCents: item.lineTotalCents,
        })),
        extraLines: buildExtraLines(sale.serviceCharges, sale.delivery),
        subtotalCents: sale.subtotalCents,
        discountAmountCents: sale.discountAmountCents,
        taxAmountCents: sale.taxAmountCents,
        grandTotalCents: sale.grandTotalCents,
        paymentMethodName: paymentMethod?.name ?? null,
        paymentReference: sale.paymentReference,
        amountReceivedCents: sale.amountReceivedCents,
        changeGivenCents: sale.changeGivenCents,
        dueDate: isInvoice ? sale.dueDate : null,
        balanceDueCents: isInvoice ? sale.balanceDueCents : null,
        paymentStatus: isInvoice
          ? computePaymentStatus({
              balanceDueCents: sale.balanceDueCents,
              amountPaidCents: sale.amountPaidCents,
              dueDate: sale.dueDate,
              cancelled: sale.paymentStatus === "cancelled",
            })
          : null,
        validUntil: null,
        quotationStatus: null,
      } satisfies SharedDocumentResult;
    }

    const quotation = await tx.quotation.findUnique({ where: { id: entityId } });
    if (!quotation) throw new NotFoundError("Document not found");

    const items = asArray<RawItem>(quotation.items);
    const [location, employee, customer, products] = await Promise.all([
      tx.location.findUnique({ where: { id: quotation.locationId } }),
      tx.employee.findUnique({ where: { id: quotation.employeeId } }),
      tx.customer.findUnique({ where: { id: quotation.customerId } }),
      tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true } }),
    ]);
    const productNameById = new Map(products.map((p) => [p.id, p.name]));
    const business = resolveBusinessInfo(location, tenantRow);

    return {
      documentKind: "quotation",
      ...business,
      documentNumber: quotation.quotationNumber,
      dateLabel: quotation.localCreatedAt.toISOString(),
      employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "—",
      branchName: location?.locationName ?? "—",
      customerName: customer?.name ?? null,
      items: items.map((item) => ({
        name: productNameById.get(item.productId) ?? "Unknown product",
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      })),
      extraLines: buildExtraLines(quotation.serviceCharges, quotation.delivery),
      subtotalCents: quotation.subtotalCents,
      discountAmountCents: quotation.discountAmountCents,
      taxAmountCents: quotation.taxAmountCents,
      grandTotalCents: quotation.grandTotalCents,
      paymentMethodName: null,
      paymentReference: null,
      amountReceivedCents: null,
      changeGivenCents: null,
      dueDate: null,
      balanceDueCents: null,
      paymentStatus: null,
      validUntil: quotation.validUntil,
      quotationStatus: computeQuotationStatus({ storedStatus: quotation.status, validUntil: quotation.validUntil }),
    } satisfies SharedDocumentResult;
  });
}
