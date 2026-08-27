import { randomBytes } from "node:crypto";
import { env } from "../env.js";
import { formatDocumentDate, formatDocumentDateTime } from "../lib/document-date.js";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { createShareLinkSchema } from "../schemas/share.js";
import { computeAddedTaxCents, computeTaxBreakdown, taxBreakdownLabel, type TaxBreakdownEntry } from "../lib/tax-breakdown.js";

const SHARE_LINK_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year, matching the user's own ask

type ShareEntity = "sale" | "quotation" | "sale_delivery" | "quotation_delivery" | "customer_statement";
export type SharedResult = SharedDocumentResult | SharedDeliveryNoteResult | SharedStatementResult;

const NOT_FOUND_MESSAGE: Record<ShareEntity, string> = {
  sale: "Receipt/invoice not found",
  quotation: "Quotation not found",
  sale_delivery: "Delivery note not found",
  quotation_delivery: "Delivery note not found",
  customer_statement: "Customer not found",
};

export async function createShareLink(input: unknown): Promise<{ url: string; message: string }> {
  const parsed = createShareLinkSchema.parse(input);

  const { doc, message } = await buildShareable(parsed.entity, parsed.tenantId, parsed.entityId);
  if (!doc) {
    throw new NotFoundError(NOT_FOUND_MESSAGE[parsed.entity]);
  }

  // 12 random bytes -> 16 base64url characters — short, URL-safe, unguessable (96 bits of
  // entropy). This row is the ONLY thing standing between an anonymous visitor and the document —
  // deliberately not RLS-protected (see ShareLink's own schema comment for why).
  const token = randomBytes(12).toString("base64url");
  await prisma.shareLink.create({
    data: {
      id: token,
      tenantId: parsed.tenantId,
      entity: parsed.entity,
      entityId: parsed.entityId,
      expiresAt: new Date(Date.now() + SHARE_LINK_LIFETIME_MS),
    },
  });

  const url = `${env.SHARE_APP_BASE_URL}/r/${token}`;
  return { url, message: message(url, parsed.includePreview) };
}

export async function getSharedDocument(token: string): Promise<SharedResult> {
  const link = await prisma.shareLink.findUnique({ where: { id: token } });
  if (!link || link.expiresAt.getTime() < Date.now()) {
    throw new HttpError(410, "This link has expired or is no longer valid.");
  }

  const { doc } = await buildShareable(link.entity as ShareEntity, link.tenantId, link.entityId);
  if (!doc) throw new NotFoundError("Document not found");
  return doc;
}

/** Single dispatch point shared by both the mint and the resolve path, so a link can never be
 * minted for a document type it can't later be resolved as. `message` is a thunk (not the built
 * string) so getSharedDocument — which never needs the WhatsApp/email text — doesn't pay for it.
 * Takes `includePreview` at CALL time (not build time) since only createShareLink ever needs it —
 * getSharedDocument never calls the thunk at all. */
async function buildShareable(
  entity: ShareEntity,
  tenantId: string,
  entityId: string,
): Promise<{ doc: SharedResult | null; message: (url: string, includePreview: boolean) => string }> {
  if (entity === "sale_delivery" || entity === "quotation_delivery") {
    const doc = await buildSharedDeliveryNote(tenantId, entity === "sale_delivery" ? "sale" : "quotation", entityId);
    return { doc, message: (url, includePreview) => (doc ? buildDeliveryShareMessage(doc, url, includePreview) : "") };
  }
  if (entity === "customer_statement") {
    // entityId is the customerId here, not a Sale/Quotation id — there's no document row to key by,
    // the statement is recomputed live from that customer's own invoices (see buildSharedStatement).
    const doc = await buildSharedStatement(tenantId, entityId);
    return { doc, message: (url, includePreview) => (doc ? buildStatementShareMessage(doc, url, includePreview) : "") };
  }
  const doc = await buildSharedDocument(tenantId, entity, entityId);
  return { doc, message: (url, includePreview) => (doc ? buildShareMessage(doc, url, includePreview) : "") };
}

// ---------------------------------------------------------------------------------------------
// Shared document view model — ported from DESKTOP's shared/lib/receipt.ts (buildReceiptViewModel)
// and printer-service.ts (resolveDocumentBusiness), extended with the small invoice/quotation-only
// fields. Sale.items/Quotation.items are JSON blobs without a productName (see
// mobile-metrics-service.ts's own note on this) — resolved here via a Product lookup, same pattern.
// Used by BOTH createShareLink (to build the WhatsApp/email message) and getSharedDocument (to
// render the public page) — one source of truth, so the two can never disagree on the numbers.
// ---------------------------------------------------------------------------------------------

export type PricedDocumentKind = "receipt" | "invoice" | "quotation";

export type SharedLineItem = {
  name: string;
  /** Null for service-charge/delivery-fee lines (buildExtraLines) — those aren't real products. */
  sku: string | null;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  lineTotalCents: number;
};

export type { TaxBreakdownEntry } from "../lib/tax-breakdown.js";

export type SharedPayment = {
  receivedAt: string;
  paymentMethodName: string;
  reference: string | null;
  receivedByName: string;
  amountCents: number;
};

export type SharedDocumentResult = {
  documentKind: PricedDocumentKind;
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
  /** The tenant's own KRA PIN — shown as "Our VAT No." on the invoice PDF only. See
   * document-html.ts's buildInvoiceDocumentHtml. */
  businessKraPin: string | null;
  /** The customer's own KRA PIN, if on file — shown as "Your VAT No." on the invoice PDF only. */
  customerKraPin: string | null;
  items: SharedLineItem[];
  extraLines: SharedLineItem[];
  subtotalCents: number;
  discountAmountCents: number;
  /** Reporting-only — grandTotalCents is the frozen value DESKTOP already computed correctly for
   * whichever tax mode was active per line at creation time. See taxBreakdown for the printable
   * category breakdown. */
  taxAmountCents: number;
  /** The subset of taxAmountCents that was actually ADDED to reach grandTotalCents (exclusive-priced
   * lines only) — see computeAddedTaxCents' own doc comment. What the "Total Tax" summary row shows. */
  addedTaxCents: number;
  taxBreakdown: TaxBreakdownEntry[];
  /** Whether the Tax Breakdown section should actually render — see the Sale/Quotation Prisma
   * model's own doc comment. taxBreakdown itself is always computed regardless. */
  includeTaxBreakdown: boolean;
  /** Whether this document shows ANY shop OR staff identity — see the Sale/Quotation Prisma model's
   * own doc comment on includeBusinessInfo. Per the client's own explicit correction, cashier/
   * employee name is off-limits here too, not just the shop's ("if we want to see who made the sale
   * we can just look up the sale"). When false, businessName has already been replaced with a
   * generic heading and every other identity field (address/phone/header/footer/KRA PIN) is null —
   * document-html.ts/DocumentView.tsx/DocumentDetailModal.tsx render those with no extra branching.
   * employeeName/branchName are NOT stripped here (kept for whatever internal/admin use might still
   * want them) — each of the four consumers (those three plus the WhatsApp text share) instead
   * checks this flag itself before rendering its own "Served by X [· Branch: Y]" line/column. */
  includeBusinessInfo: boolean;
  /** Whether this sale/quotation has a delivery note attached — the one signal mobile needs to decide
   * whether to show a "View Delivery Note" action, without a separate per-list-type field. See
   * buildSharedDeliveryNote for the actual delivery-note content. */
  hasDeliveryNote: boolean;
  /** Null when hasDeliveryNote is false — otherwise the delivery's own isDelivered flag, so mobile
   * can show a Delivered/Pending pill without a second fetch. */
  deliveryIsDelivered: boolean | null;
  vatRatePercent: number;
  grandTotalCents: number;
  paymentMethodName: string | null;
  paymentReference: string | null;
  amountReceivedCents: number | null;
  changeGivenCents: number | null;
  /** Full payment history — only invoices show this as a table; receipts/quotations leave it empty
   * and keep using the single-payment fields above (paymentMethodName/amountReceivedCents/etc). */
  payments: SharedPayment[];
  /** sale-only (null for quotations) — used by the letterhead PDF's "Transaction Type" field. */
  transactionType: string | null;
  /** invoiceNotes for a sale, notes for a quotation — same free-text field, different column name
   * per source table. */
  notes: string | null;
  // invoice-only
  dueDate: string | null;
  balanceDueCents: number | null;
  paymentStatus: string | null;
  // quotation-only
  validUntil: string | null;
  quotationStatus: string | null;
};

/** Deliberately carries no fee/cost figures — mirrors DESKTOP's own DeliveryNoteViewModel
 * (shared/lib/delivery-note.ts), which excludes pricing on purpose since this is meant to be handed
 * to a rider/recipient, not treated as a financial document. */
export type SharedDeliveryNoteResult = {
  documentKind: "delivery_note";
  businessName: string;
  physicalAddress: string | null;
  primaryPhone: string | null;
  deliveryNoteNumber: string;
  sourceDocumentLabel: string;
  sourceDocumentNumber: string | null;
  dateLabel: string;
  recipientName: string;
  country: string | null;
  town: string | null;
  deliveryAddress: string;
  deliveryNotes: string | null;
  riderName: string | null;
  riderPhone: string | null;
  riderCompany: string | null;
  riderVehicleDescription: string | null;
  isDelivered: boolean;
  deliveredAt: string | null;
};

export type SharedStatementInvoiceLine = {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  grandTotalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  paymentStatus: string;
};

/** A customer's "Statement of Account" — every invoice they haven't fully paid off yet, across every
 * storefront (no single Location to resolve a per-storefront business override from, unlike every
 * other document here — businessName/etc. are always the tenant-wide default). Recomputed live from
 * Sale rows on every view, same as DESKTOP's own statement-service.ts — no table of its own. */
export type SharedStatementResult = {
  documentKind: "statement";
  businessName: string;
  physicalAddress: string | null;
  primaryPhone: string | null;
  currency: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  creditLimitCents: number | null;
  generatedAt: string;
  invoices: SharedStatementInvoiceLine[];
  totalInvoicedCents: number;
  totalPaidCents: number;
  totalOutstandingCents: number;
};

type RawItem = {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number;
  taxType: string;
  taxAmountCents: number;
  lineTotalCents: number;
};
type RawServiceCharge = { name: string; feeCents: number };
type RawPayment = { paymentMethodName: string; reference: string | null; receivedByName: string; receivedAt: string; amountCents: number };
type RawDelivery = {
  id: string;
  deliveryNoteNumber: string;
  riderId: string | null;
  recipientName: string;
  country: string | null;
  town: string | null;
  physicalAddress: string;
  notes: string | null;
  feeCents: number;
  isDelivered: boolean;
  deliveredAt: string | null;
} | null;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Ports DESKTOP's computePaymentStatus (shared/lib/invoice.ts) — derives live status from the
 * numbers rather than trusting a value that goes stale as the calendar moves past a due date.
 * Exported so mobile-sales-service.ts's invoice list doesn't need a third copy of this logic. */
export function computePaymentStatus(params: {
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
 * terminal, otherwise a date past validUntil means expired regardless of the stored status.
 * Exported so mobile-quotations-service.ts's list doesn't need a second copy of this logic. */
export function computeQuotationStatus(params: { storedStatus: string; validUntil: string }): string {
  if (params.storedStatus === "rejected" || params.storedStatus === "converted") return params.storedStatus;
  if (new Date(params.validUntil).getTime() < Date.now()) return "expired";
  return params.storedStatus;
}

type TenantBusinessDefaults = { name: string; physicalAddress: string | null; contactPhone: string | null; currency: string };

/** Ports printer-service.ts's resolveDocumentBusiness — the document's own storefront overrides
 * the tenant-wide Business Profile defaults, falling back when the storefront hasn't set its own.
 * Tenant-level header/footer fields don't exist in the synced schema at all (only the Location-level
 * ones do) — a real gap, not something to silently paper over, so there's no tenant-wide fallback
 * here; a document whose storefront hasn't set its own header/footer just shows none, same as it
 * would locally in that same case.
 *
 * `documentKind` picks WHICH pair of header/footer columns applies — receipts, invoices, and
 * quotations each have their own now (see DESKTOP's printer-service.ts resolveDocumentBusiness for
 * the same three-way split); the returned field names stay receiptHeader/receiptFooter regardless
 * of kind purely because SharedDocumentResult/the WhatsApp message builder were already written
 * against those names before quotations/invoices got their own — they just mean "this document's
 * header/footer" now. */
/** "CASH RECEIPT"/"INVOICE"/"QUOTATION" replaces businessName as the printed heading when
 * Sale/Quotation["includeBusinessInfo"] is false — see that field's own doc comment
 * (schema.prisma). Ports DESKTOP's own GENERIC_RECEIPT_HEADING (shared/lib/receipt.ts) /
 * suppressBusinessInfo (printer-service.ts) — same three labels, same reasoning. */
const GENERIC_DOCUMENT_HEADING: Record<"receipt" | "invoice" | "quotation", string> = {
  receipt: "CASH RECEIPT",
  invoice: "INVOICE",
  quotation: "QUOTATION",
};

function resolveBusinessInfo(
  location: {
    locationName: string;
    physicalAddress: string | null;
    phone: string | null;
    receiptHeader: string | null;
    receiptFooter: string | null;
    invoiceHeader: string | null;
    invoiceFooter: string | null;
    quotationHeader: string | null;
    quotationFooter: string | null;
  } | null,
  tenant: TenantBusinessDefaults,
  documentKind: "receipt" | "invoice" | "quotation",
  includeBusinessInfo: boolean,
): {
  businessName: string;
  physicalAddress: string | null;
  primaryPhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  currency: string;
} {
  if (!includeBusinessInfo) {
    return {
      businessName: GENERIC_DOCUMENT_HEADING[documentKind],
      physicalAddress: null,
      primaryPhone: null,
      receiptHeader: null,
      receiptFooter: null,
      currency: tenant.currency,
    };
  }
  const [header, footer] =
    documentKind === "invoice"
      ? [location?.invoiceHeader, location?.invoiceFooter]
      : documentKind === "quotation"
        ? [location?.quotationHeader, location?.quotationFooter]
        : [location?.receiptHeader, location?.receiptFooter];
  return {
    businessName: location?.locationName ?? tenant.name,
    physicalAddress: location?.physicalAddress ?? tenant.physicalAddress,
    primaryPhone: location?.phone ?? tenant.contactPhone,
    receiptHeader: header ?? null,
    receiptFooter: footer ?? null,
    currency: tenant.currency,
  };
}

function buildExtraLines(serviceCharges: unknown, delivery: unknown): SharedLineItem[] {
  const charges = asArray<RawServiceCharge>(serviceCharges).map((charge) => ({
    name: charge.name,
    sku: null,
    quantity: 1,
    unitPriceCents: charge.feeCents,
    discountAmountCents: 0,
    taxAmountCents: 0,
    lineTotalCents: charge.feeCents,
  }));
  const deliveryRow = delivery as RawDelivery;
  // A seller who absorbs the delivery cost themselves charges the customer nothing for it — skip
  // the line entirely rather than show "Delivery Fee: 0.00" (mirrors DESKTOP's own receipt.ts /
  // printer-service.ts change).
  const deliveryLine = deliveryRow && deliveryRow.feeCents > 0
    ? [
        {
          name: "Delivery Fee",
          sku: null,
          quantity: 1,
          unitPriceCents: deliveryRow.feeCents,
          discountAmountCents: 0,
          taxAmountCents: 0,
          lineTotalCents: deliveryRow.feeCents,
        },
      ]
    : [];
  return [...charges, ...deliveryLine];
}

/** Exported for reuse by the Owner App's mobile-sales-service.ts — the owner viewing their own
 * tenant's own document is a plain authenticated read, not a public-token share, so it calls this
 * directly instead of minting a ShareLink. Same view-model either way — one source of truth. */
export async function buildSharedDocument(tenantId: string, entity: "sale" | "quotation", entityId: string): Promise<SharedDocumentResult | null> {
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, physicalAddress: true, contactPhone: true, currency: true, vatRatePercent: true, kraPin: true },
  });
  if (!tenantRow) return null;

  return withTenantContext(tenantId, async (tx) => {
    if (entity === "sale") {
      const sale = await tx.sale.findUnique({ where: { id: entityId } });
      if (!sale) return null;

      const items = asArray<RawItem>(sale.items);
      const [location, employee, customer, paymentMethod, products] = await Promise.all([
        tx.location.findUnique({ where: { id: sale.locationId } }),
        tx.employee.findUnique({ where: { id: sale.employeeId } }),
        sale.customerId ? tx.customer.findUnique({ where: { id: sale.customerId } }) : Promise.resolve(null),
        sale.paymentMethodId ? tx.paymentMethod.findUnique({ where: { id: sale.paymentMethodId } }) : Promise.resolve(null),
        tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true, sku: true } }),
      ]);
      const productById = new Map(products.map((p) => [p.id, p]));

      const isInvoice = sale.invoiceNumber !== null;
      const business = resolveBusinessInfo(location, tenantRow, isInvoice ? "invoice" : "receipt", sale.includeBusinessInfo);

      return {
        documentKind: isInvoice ? "invoice" : "receipt",
        ...business,
        documentNumber: isInvoice ? sale.invoiceNumber : sale.receiptNumber,
        dateLabel: (sale.completedAt ?? sale.localCreatedAt).toISOString(),
        employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "—",
        branchName: sale.includeBusinessInfo ? (location?.locationName ?? "—") : "",
        customerName: customer?.name ?? null,
        businessKraPin: sale.includeBusinessInfo ? tenantRow.kraPin : null,
        customerKraPin: customer?.kraPin ?? null,
        includeBusinessInfo: sale.includeBusinessInfo,
        hasDeliveryNote: sale.delivery !== null,
        deliveryIsDelivered: (sale.delivery as RawDelivery)?.isDelivered ?? null,
        items: items.map((item) => ({
          name: productById.get(item.productId)?.name ?? "Unknown product",
          sku: productById.get(item.productId)?.sku ?? null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          discountAmountCents: item.discountAmountCents,
          taxAmountCents: item.taxAmountCents,
          lineTotalCents: item.lineTotalCents,
        })),
        extraLines: buildExtraLines(sale.serviceCharges, sale.delivery),
        subtotalCents: sale.subtotalCents,
        discountAmountCents: sale.discountAmountCents,
        taxAmountCents: sale.taxAmountCents,
        addedTaxCents: computeAddedTaxCents(items),
        taxBreakdown: computeTaxBreakdown(items),
        includeTaxBreakdown: sale.includeTaxBreakdown,
        vatRatePercent: tenantRow.vatRatePercent,
        grandTotalCents: sale.grandTotalCents,
        paymentMethodName: paymentMethod?.name ?? null,
        paymentReference: sale.paymentReference,
        amountReceivedCents: sale.amountReceivedCents,
        changeGivenCents: sale.changeGivenCents,
        payments: asArray<RawPayment>(sale.payments).map((payment) => ({
          receivedAt: payment.receivedAt,
          paymentMethodName: payment.paymentMethodName,
          reference: payment.reference,
          receivedByName: payment.receivedByName,
          amountCents: payment.amountCents,
        })),
        transactionType: sale.transactionType,
        notes: sale.invoiceNotes,
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
    if (!quotation) return null;

    const items = asArray<RawItem>(quotation.items);
    // Walk-in quotation — see the model's own doc comment. No customer row to look up at all.
    const customerId = quotation.customerId;
    const [location, employee, customer, products] = await Promise.all([
      tx.location.findUnique({ where: { id: quotation.locationId } }),
      tx.employee.findUnique({ where: { id: quotation.employeeId } }),
      customerId ? tx.customer.findUnique({ where: { id: customerId } }) : Promise.resolve(null),
      tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true, sku: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const business = resolveBusinessInfo(location, tenantRow, "quotation", quotation.includeBusinessInfo);

    return {
      documentKind: "quotation",
      ...business,
      documentNumber: quotation.quotationNumber,
      dateLabel: quotation.localCreatedAt.toISOString(),
      employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : "—",
      branchName: quotation.includeBusinessInfo ? (location?.locationName ?? "—") : "",
      customerName: customer?.name ?? null,
      businessKraPin: quotation.includeBusinessInfo ? tenantRow.kraPin : null,
      customerKraPin: customer?.kraPin ?? null,
      includeBusinessInfo: quotation.includeBusinessInfo,
      hasDeliveryNote: quotation.delivery !== null,
      deliveryIsDelivered: (quotation.delivery as RawDelivery)?.isDelivered ?? null,
      items: items.map((item) => ({
        name: productById.get(item.productId)?.name ?? "Unknown product",
        sku: productById.get(item.productId)?.sku ?? null,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountAmountCents: item.discountAmountCents,
        taxAmountCents: item.taxAmountCents,
        lineTotalCents: item.lineTotalCents,
      })),
      extraLines: buildExtraLines(quotation.serviceCharges, quotation.delivery),
      subtotalCents: quotation.subtotalCents,
      discountAmountCents: quotation.discountAmountCents,
      taxAmountCents: quotation.taxAmountCents,
      addedTaxCents: computeAddedTaxCents(items),
      taxBreakdown: computeTaxBreakdown(items),
      includeTaxBreakdown: quotation.includeTaxBreakdown,
      vatRatePercent: tenantRow.vatRatePercent,
      grandTotalCents: quotation.grandTotalCents,
      paymentMethodName: null,
      paymentReference: null,
      amountReceivedCents: null,
      changeGivenCents: null,
      payments: [],
      transactionType: null,
      notes: quotation.notes,
      dueDate: null,
      balanceDueCents: null,
      paymentStatus: null,
      validUntil: quotation.validUntil,
      quotationStatus: computeQuotationStatus({ storedStatus: quotation.status, validUntil: quotation.validUntil }),
    } satisfies SharedDocumentResult;
  });
}

/** entityId here is the PARENT sale/quotation's own id, not the delivery's — a delivery note has no
 * standalone Postgres table of its own (it travels inside Sale.delivery/Quotation.delivery as a JSON
 * blob, same as service charges), so there's nothing else to key a lookup by. riderId inside that
 * JSON is resolved against the real Rider table here (mirrors the Product-name lookup for items) —
 * DESKTOP's own push payload only embeds riderId, not the rider's name/phone/company. */
export async function buildSharedDeliveryNote(
  tenantId: string,
  parentEntity: "sale" | "quotation",
  parentId: string,
): Promise<SharedDeliveryNoteResult | null> {
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, physicalAddress: true, contactPhone: true, currency: true, vatRatePercent: true },
  });
  if (!tenantRow) return null;

  return withTenantContext(tenantId, async (tx) => {
    const parent =
      parentEntity === "sale"
        ? await tx.sale.findUnique({ where: { id: parentId } })
        : await tx.quotation.findUnique({ where: { id: parentId } });
    if (!parent) return null;

    const delivery = parent.delivery as RawDelivery;
    if (!delivery) return null;

    const [location, rider] = await Promise.all([
      tx.location.findUnique({ where: { id: parent.locationId } }),
      delivery.riderId ? tx.rider.findUnique({ where: { id: delivery.riderId } }) : Promise.resolve(null),
    ]);
    const isInvoice = parentEntity === "sale" && (parent as { invoiceNumber: string | null }).invoiceNumber !== null;
    // Delivery notes have no includeBusinessInfo toggle of their own — out of scope for this
    // feature (only receipts/invoices/quotations), always shows full business identity.
    const business = resolveBusinessInfo(
      location,
      tenantRow,
      parentEntity === "quotation" ? "quotation" : isInvoice ? "invoice" : "receipt",
      true,
    );

    const sourceDocumentLabel = parentEntity === "quotation" ? "Quotation" : isInvoice ? "Invoice" : "Receipt";
    const sourceDocumentNumber =
      parentEntity === "quotation"
        ? (parent as { quotationNumber: string }).quotationNumber
        : ((parent as { invoiceNumber: string | null }).invoiceNumber ?? (parent as { receiptNumber: string | null }).receiptNumber);
    const dateLabel =
      parentEntity === "sale"
        ? ((parent as { completedAt: Date | null; localCreatedAt: Date }).completedAt ?? (parent as { localCreatedAt: Date }).localCreatedAt).toISOString()
        : (parent as { localCreatedAt: Date }).localCreatedAt.toISOString();

    return {
      documentKind: "delivery_note",
      businessName: business.businessName,
      physicalAddress: business.physicalAddress,
      primaryPhone: business.primaryPhone,
      deliveryNoteNumber: delivery.deliveryNoteNumber,
      sourceDocumentLabel,
      sourceDocumentNumber,
      dateLabel,
      recipientName: delivery.recipientName,
      country: delivery.country,
      town: delivery.town,
      deliveryAddress: delivery.physicalAddress,
      deliveryNotes: delivery.notes,
      riderName: rider?.name ?? null,
      riderPhone: rider?.phone ?? null,
      riderCompany: rider?.company ?? null,
      riderVehicleDescription: rider?.vehicleDescription ?? null,
      isDelivered: delivery.isDelivered,
      deliveredAt: delivery.deliveredAt,
    } satisfies SharedDeliveryNoteResult;
  });
}

/** customerId here (not a Sale/Quotation id) — a statement has no document row of its own, it's
 * recomputed live from whichever of the customer's invoices are still outstanding, same query
 * findCustomerOutstandingBalanceRow already runs locally for the credit-limit check, just returning
 * the invoice-by-invoice detail instead of only the sum. Exported for reuse by the Owner App's
 * mobile-customers-service.ts — same "authenticated owner, not a public token" reasoning as
 * buildSharedDocument's own export comment. */
export async function buildSharedStatement(tenantId: string, customerId: string): Promise<SharedStatementResult | null> {
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, physicalAddress: true, contactPhone: true, currency: true, vatRatePercent: true },
  });
  if (!tenantRow) return null;

  return withTenantContext(tenantId, async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId } });
    if (!customer) return null;

    const outstandingInvoices = await tx.sale.findMany({
      where: { customerId, invoiceNumber: { not: null }, paymentStatus: { notIn: ["paid", "cancelled"] } },
      orderBy: { dueDate: "asc" },
    });

    const lines: SharedStatementInvoiceLine[] = outstandingInvoices.map((sale) => ({
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      invoiceDate: sale.invoiceDate,
      dueDate: sale.dueDate,
      grandTotalCents: sale.grandTotalCents,
      amountPaidCents: sale.amountPaidCents,
      balanceDueCents: sale.balanceDueCents,
      paymentStatus: sale.paymentStatus,
    }));

    return {
      documentKind: "statement",
      businessName: tenantRow.name,
      physicalAddress: tenantRow.physicalAddress,
      primaryPhone: tenantRow.contactPhone,
      currency: tenantRow.currency,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      creditLimitCents: customer.creditLimitCents,
      generatedAt: new Date().toISOString(),
      invoices: lines,
      totalInvoicedCents: lines.reduce((sum, line) => sum + line.grandTotalCents, 0),
      totalPaidCents: lines.reduce((sum, line) => sum + line.amountPaidCents, 0),
      totalOutstandingCents: lines.reduce((sum, line) => sum + line.balanceDueCents, 0),
    } satisfies SharedStatementResult;
  });
}

// ---------------------------------------------------------------------------------------------
// WhatsApp/email message formatting — built to mirror the on-screen/print receipt as closely as a
// text message can (same business header, same "qty x price = total" line shape, same dashed
// section rule), per direct user feedback that the first version looked nothing like the actual
// document. Emoji is deliberately minimal: one kind emoji up top, a package per line item, the clip
// on the download link, and the balance-due warning — nothing else, per explicit user feedback that
// a heavier emoji set "made it look like a joke". WhatsApp's own real (limited) markdown: *bold*,
// _italic_, ~strikethrough~. Plain unicode dashes render fine as visual section separators in both
// WhatsApp and any email client. Same message used for both channels (mailto: bodies are plain text
// too, so there's no reason to maintain two versions).
// ---------------------------------------------------------------------------------------------

const SEPARATOR = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄";

const KIND_EMOJI: Record<PricedDocumentKind, string> = { receipt: "🧾", invoice: "📄", quotation: "📋" };
const KIND_LABEL: Record<PricedDocumentKind, string> = { receipt: "Receipt", invoice: "Invoice", quotation: "Quotation" };
const DELIVERY_EMOJI = "🚚";
const STATEMENT_EMOJI = "📊";

export function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `includePreview: false` is the "Include WhatsApp preview" checkbox unchecked — client told the
 * user the full formatted breakdown isn't always wanted, just a short "here's your document" line
 * plus the link. Kept dead simple: kind, number, date, link — same for every document kind. */
function buildCompactShareMessage(kindEmoji: string, kindLabel: string, documentNumber: string, dateLabel: string, url: string): string {
  return [`${kindEmoji} *${kindLabel.toUpperCase()}*`, documentNumber, dateLabel, "", `📎 View & download: ${url}`].join("\n");
}

function buildShareMessage(doc: SharedDocumentResult, url: string, includePreview: boolean): string {
  if (!includePreview) {
    return buildCompactShareMessage(
      KIND_EMOJI[doc.documentKind],
      KIND_LABEL[doc.documentKind],
      doc.documentNumber ?? "-",
      formatDocumentDate(doc.dateLabel),
      url,
    );
  }

  const lines: string[] = [];
  const money = (cents: number) => formatMoney(cents, doc.currency);

  lines.push(`${KIND_EMOJI[doc.documentKind]} *${KIND_LABEL[doc.documentKind].toUpperCase()}*`);
  lines.push("");
  lines.push(`*${doc.businessName}*`);
  if (doc.physicalAddress) lines.push(doc.physicalAddress);
  if (doc.primaryPhone) lines.push(doc.primaryPhone);
  if (doc.receiptHeader) lines.push(`_${doc.receiptHeader}_`);

  lines.push(SEPARATOR);
  lines.push(`${KIND_LABEL[doc.documentKind]}: ${doc.documentNumber ?? "-"}`);
  lines.push(`Date: ${formatDocumentDateTime(doc.dateLabel)}`);
  if (doc.includeBusinessInfo) {
    lines.push(`Served by: ${doc.employeeName}${doc.branchName ? ` · Branch: ${doc.branchName}` : ""}`);
  }
  if (doc.customerName) lines.push(`Customer: ${doc.customerName}`);
  if (doc.dueDate) lines.push(`Due: ${formatDocumentDate(doc.dueDate)}`);
  if (doc.validUntil) lines.push(`Valid until: ${formatDocumentDate(doc.validUntil)}`);

  lines.push(SEPARATOR);
  const allItems = [...doc.items, ...doc.extraLines];
  allItems.forEach((item, index) => {
    lines.push(`📦 ${item.name}`);
    lines.push(`${item.quantity} x ${money(item.unitPriceCents)} = *${money(item.lineTotalCents)}*`);
    if (index < allItems.length - 1) lines.push("");
  });

  lines.push(SEPARATOR);
  lines.push(`Subtotal: ${money(doc.subtotalCents)}`);
  if (doc.discountAmountCents > 0) lines.push(`Discount: -${money(doc.discountAmountCents)}`);
  lines.push(`*TOTAL: ${money(doc.grandTotalCents)}*`);
  if (doc.balanceDueCents !== null && doc.balanceDueCents > 0) {
    lines.push(`⚠️ *Balance Due: ${money(doc.balanceDueCents)}*`);
  }

  // Same "Payments Made" content and Payments-before-Tax-Breakdown ordering as the printed/PDF
  // invoice (document-html.ts's buildInvoiceDocumentHtml) — an invoice's actual payment history,
  // distinct from the single-transaction paymentMethodName/paymentReference/amountReceivedCents
  // block below (which only ever applies to a receipt's one-shot payment, never an invoice's).
  if (doc.payments.length > 0) {
    lines.push(SEPARATOR);
    lines.push("*Payments Made*");
    for (const payment of doc.payments) {
      lines.push(
        `${formatDocumentDate(payment.receivedAt)} · ${payment.paymentMethodName}${payment.reference ? ` (${payment.reference})` : ""}: *${money(payment.amountCents)}*`,
      );
      lines.push(`  Received by ${payment.receivedByName}`);
    }
  }

  if (doc.taxBreakdown.length > 0) {
    lines.push(SEPARATOR);
    lines.push("*Tax Breakdown*");
    for (const entry of doc.taxBreakdown) {
      lines.push(`${taxBreakdownLabel(entry.taxType, doc.vatRatePercent)}: Net ${money(entry.netCents)} / Tax ${money(entry.taxCents)}`);
    }
  }

  if (doc.paymentMethodName || doc.paymentReference || doc.amountReceivedCents !== null) {
    lines.push(SEPARATOR);
    if (doc.paymentMethodName) lines.push(`Payment: ${doc.paymentMethodName}`);
    if (doc.paymentReference) lines.push(`Ref: ${doc.paymentReference}`);
    if (doc.amountReceivedCents !== null) lines.push(`Received: ${money(doc.amountReceivedCents)}`);
    if (doc.changeGivenCents !== null && doc.changeGivenCents > 0) lines.push(`Change: ${money(doc.changeGivenCents)}`);
  }

  lines.push(SEPARATOR);
  lines.push(doc.receiptFooter ?? "Thank you for your business!");
  lines.push("");
  lines.push(`📎 View & download: ${url}`);

  return lines.join("\n");
}

function buildDeliveryShareMessage(doc: SharedDeliveryNoteResult, url: string, includePreview: boolean): string {
  if (!includePreview) {
    return buildCompactShareMessage(DELIVERY_EMOJI, "Delivery Note", doc.deliveryNoteNumber, new Date(doc.dateLabel).toLocaleDateString(), url);
  }

  const lines: string[] = [];

  lines.push(`${DELIVERY_EMOJI} *DELIVERY NOTE*`);
  lines.push("");
  lines.push(`*${doc.businessName}*`);
  if (doc.physicalAddress) lines.push(doc.physicalAddress);
  if (doc.primaryPhone) lines.push(doc.primaryPhone);

  lines.push(SEPARATOR);
  lines.push(`Delivery Note: ${doc.deliveryNoteNumber}`);
  lines.push(`${doc.sourceDocumentLabel}: ${doc.sourceDocumentNumber ?? "-"}`);
  lines.push(`Date: ${new Date(doc.dateLabel).toLocaleString()}`);
  lines.push(`Status: ${doc.isDelivered ? "Delivered" : "Pending"}`);

  lines.push(SEPARATOR);
  lines.push("*Deliver To*");
  lines.push(doc.recipientName);
  lines.push(doc.deliveryAddress);
  const townCountry = [doc.town, doc.country].filter(Boolean).join(", ");
  if (townCountry) lines.push(townCountry);
  if (doc.deliveryNotes) lines.push(`Notes: ${doc.deliveryNotes}`);

  if (doc.riderName) {
    lines.push(SEPARATOR);
    lines.push("*Rider*");
    lines.push(doc.riderName);
    if (doc.riderPhone) lines.push(doc.riderPhone);
    if (doc.riderCompany) lines.push(doc.riderCompany);
    if (doc.riderVehicleDescription) lines.push(doc.riderVehicleDescription);
  }

  lines.push(SEPARATOR);
  lines.push("");
  lines.push(`📎 View & download: ${url}`);

  return lines.join("\n");
}

function buildStatementShareMessage(doc: SharedStatementResult, url: string, includePreview: boolean): string {
  if (!includePreview) {
    // Statements have no document number of their own — the customer's name stands in for it.
    return buildCompactShareMessage(STATEMENT_EMOJI, "Statement", doc.customerName, new Date(doc.generatedAt).toLocaleDateString(), url);
  }

  const lines: string[] = [];
  const money = (cents: number) => formatMoney(cents, doc.currency);

  lines.push(`${STATEMENT_EMOJI} *STATEMENT*`);
  lines.push("");
  lines.push(`*${doc.businessName}*`);
  if (doc.physicalAddress) lines.push(doc.physicalAddress);
  if (doc.primaryPhone) lines.push(doc.primaryPhone);

  lines.push(SEPARATOR);
  lines.push(`Statement For: ${doc.customerName}`);
  lines.push(`Date: ${new Date(doc.generatedAt).toLocaleDateString()}`);
  if (doc.creditLimitCents !== null) {
    const availableCents = Math.max(0, doc.creditLimitCents - doc.totalOutstandingCents);
    lines.push(`Credit Limit: ${money(doc.creditLimitCents)} (Available: ${money(availableCents)})`);
  }

  lines.push(SEPARATOR);
  if (doc.invoices.length === 0) {
    lines.push("No outstanding invoices.");
  } else {
    doc.invoices.forEach((invoice, index) => {
      const due = invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "-";
      lines.push(`${invoice.invoiceNumber ?? "-"} — Due ${due}`);
      lines.push(`Invoice Value: ${money(invoice.grandTotalCents)}`);
      lines.push(`Paid: ${money(invoice.amountPaidCents)}`);
      lines.push(`Balance: *${money(invoice.balanceDueCents)}*`);
      if (index < doc.invoices.length - 1) lines.push("");
    });
  }

  lines.push(SEPARATOR);
  lines.push(`Total Invoiced: ${money(doc.totalInvoicedCents)}`);
  lines.push(`Total Paid: ${money(doc.totalPaidCents)}`);
  lines.push(`*TOTAL OUTSTANDING: ${money(doc.totalOutstandingCents)}*`);
  lines.push("");
  lines.push(`📎 View & download: ${url}`);

  return lines.join("\n");
}
