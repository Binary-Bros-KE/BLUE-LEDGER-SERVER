import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import {
  buildServiceCharges,
  type MobileCartItemInput,
  type MobileServiceChargeInput,
  prepareMobileCart,
  sumServiceChargeFees,
} from "../lib/mobile-cart.js";
import { buildDeliveryJson, createDeliveryCostExpenseIfNeeded } from "../lib/mobile-delivery.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import type { TenantTaxConfig } from "../lib/tax-breakdown.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import {
  type MobileConvertToInvoiceInput,
  mobileConvertToInvoiceSchema,
  type MobileConvertToSaleInput,
  mobileConvertToSaleSchema,
  type MobileQuotationInput,
  mobileQuotationSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID, resolveMobileLocation } from "./mobile-checkout-service.js";
import { createInvoice, type MobileEditableDelivery, type MobileEditableItem } from "./mobile-invoices-service.js";
import { buildSharedDocument, computeQuotationStatus, type SharedDocumentResult } from "./share-service.js";

/** Matches DESKTOP's own quotation-service.ts prefix exactly ("QT", 6 digits). */
const QUOTATION_PREFIX = "QT";
const QUOTATION_DIGITS = 6;

/** Matches DESKTOP's own sale-service.ts prefix exactly ("BL", 7 digits) — see
 * mobile-checkout-service.ts's own RECEIPT_PREFIX. Duplicated here (not imported) because a
 * quotation→sale conversion mints its own receipt independently of a normal checkout. */
const RECEIPT_PREFIX = "BL";
const RECEIPT_DIGITS = 7;

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

export type MobileQuotationResult = { id: string };

/** Creates a new quotation — a non-binding proposal, no stock deducted/checked, no money collected.
 * Mirrors DESKTOP's own quotation-service.ts createQuotation. */
export async function createQuotation(tenantId: string, employeeId: string, input: unknown): Promise<MobileQuotationResult> {
  const parsed: MobileQuotationInput = mobileQuotationSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
      const locationId = await resolveMobileLocation(tx, tenantId, employee.branchId, parsed.locationId);

      if (parsed.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: parsed.customerId } });
        if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } });
      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      // checkStock: false — a quotation never checks or deducts stock at creation time, matching
      // DESKTOP exactly (see checkQuotationStock for the separate, explicit action that does).
      const cart = await prepareMobileCart(tx, tenantId, locationId, parsed.items, tenantTaxConfig, { checkStock: false });
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const serviceChargeFeeCents = sumServiceChargeFees(parsed.serviceCharges);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;

      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
      const quotationNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, QUOTATION_PREFIX, QUOTATION_DIGITS);
      const now = new Date();
      // No delivery-cost expense here — a quotation is a proposal, nothing has been paid for yet,
      // matching DESKTOP's quotation-service.ts (which calls persistCartExtras but never
      // createDeliveryCostExpenseIfNeeded).
      const { json: deliveryJson } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);
      const preparedServiceCharges = buildServiceCharges(parsed.serviceCharges, now);

      const quotationId = `quotation_${randomUUID()}`;
      await tx.quotation.create({
        data: {
          id: quotationId,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          quotationNumber,
          customerId: parsed.customerId ?? null,
          locationId,
          employeeId,
          status: "draft",
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
          grandTotalCents,
          validUntil: parsed.validUntil,
          notes: parsed.notes?.trim() || null,
          includeTaxBreakdown: parsed.includeTaxBreakdown,
          includeBusinessInfo: parsed.includeBusinessInfo,
          convertedSaleId: null,
          convertedAt: null,
          items: cart.items,
          serviceCharges: preparedServiceCharges,
          delivery: deliveryJson ?? Prisma.JsonNull,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });

      return { id: quotationId };
    },
    { timeoutMs: 15_000 },
  );
}

async function requireEditableDraft(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const row = await tx.quotation.findUnique({ where: { id } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError("Quotation not found");
  if (row.status !== "draft") throw new HttpError(400, "Only draft quotations can be edited");
  return row;
}

export type MobileQuotationEditData = {
  customerId: string | null;
  validUntil: string;
  notes: string | null;
  includeTaxBreakdown: boolean;
  includeBusinessInfo: boolean;
  items: MobileEditableItem[];
  delivery: MobileEditableDelivery | null;
  serviceCharges: MobileServiceChargeInput[];
};

/** Raw, re-editable form of a quotation — same reasoning as mobile-invoices-service.ts's
 * getInvoiceEditData: SharedDocument is a display shape, not enough to rebuild items[] for
 * updateQuotation's own mobileQuotationSchema. Only returned for a draft — APP hides its Edit button
 * otherwise, matching requireEditableDraft above. */
export async function getQuotationEditData(tenantId: string, id: string): Promise<MobileQuotationEditData> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await requireEditableDraft(tx, tenantId, id);
    const items = row.items as unknown as MobileEditableItem[];
    const delivery = row.delivery as unknown as MobileEditableDelivery | null;
    const serviceCharges = row.serviceCharges as unknown as Array<MobileServiceChargeInput & { id: string; createdAt: string }>;

    return {
      customerId: row.customerId,
      validUntil: row.validUntil,
      notes: row.notes,
      includeTaxBreakdown: row.includeTaxBreakdown,
      includeBusinessInfo: row.includeBusinessInfo,
      serviceCharges: serviceCharges.map((charge) => ({ name: charge.name, feeCents: charge.feeCents, costCents: charge.costCents })),
      items: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        discountAmountCents: item.discountAmountCents,
        isLocallySourced: item.isLocallySourced,
        localCostCents: item.localCostCents,
        localSupplierId: item.localSupplierId,
      })),
      delivery: delivery
        ? {
            riderId: delivery.riderId,
            recipientName: delivery.recipientName,
            country: delivery.country,
            town: delivery.town,
            physicalAddress: delivery.physicalAddress,
            notes: delivery.notes,
            feeCents: delivery.feeCents,
            costCents: delivery.costCents,
          }
        : null,
    };
  });
}

/** A draft can be freely re-priced from live product data — nothing has been quoted to the customer
 * yet. Matches DESKTOP's own updateQuotation exactly. */
export async function updateQuotation(tenantId: string, id: string, input: unknown): Promise<MobileQuotationResult> {
  const parsed: MobileQuotationInput = mobileQuotationSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const row = await requireEditableDraft(tx, tenantId, id);
      if (parsed.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: parsed.customerId } });
        if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } });
      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const cart = await prepareMobileCart(tx, tenantId, row.locationId, parsed.items, tenantTaxConfig, { checkStock: false });
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const serviceChargeFeeCents = sumServiceChargeFees(parsed.serviceCharges);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;

      const employee = await tx.employee.findUniqueOrThrow({ where: { id: row.employeeId } });
      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, row.employeeId, employee.mobileDeviceSequence);
      const now = new Date();
      const { json: deliveryJson } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);
      const preparedServiceCharges = buildServiceCharges(parsed.serviceCharges, now);

      await tx.quotation.update({
        where: { id },
        data: {
          customerId: parsed.customerId ?? null,
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
          grandTotalCents,
          validUntil: parsed.validUntil,
          notes: parsed.notes?.trim() || null,
          includeTaxBreakdown: parsed.includeTaxBreakdown,
          includeBusinessInfo: parsed.includeBusinessInfo,
          items: cart.items,
          serviceCharges: preparedServiceCharges,
          delivery: deliveryJson ?? Prisma.JsonNull,
          localUpdatedAt: now,
        },
      });

      return { id };
    },
    { timeoutMs: 15_000 },
  );
}

export async function deleteQuotation(tenantId: string, id: string): Promise<MobileQuotationResult> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await requireEditableDraft(tx, tenantId, id);
    // Cloud sync has no delete propagation — a quotation already synced would leave a stale copy on
    // other devices forever if hard-deleted here. A DESKTOP-originated draft rarely reaches here
    // already-synced in practice, but if it has (syncedAt more than a moment old), refuse the same
    // way DESKTOP's own deleteQuotation does.
    if (Date.now() - row.syncedAt.getTime() > 5_000) {
      throw new HttpError(400, "This quotation has already synced to the cloud and can't be deleted — reject it instead.");
    }
    await tx.quotation.delete({ where: { id } });
    return { id };
  });
}

const MANUAL_TARGET_STATUSES = new Set(["draft", "sent", "accepted", "rejected"]);

/** Manual status transitions (Sent/Accepted/Rejected/back-to-Draft). Expired is date-computed and
 * Converted only happens via the convert actions — neither is a valid target here. */
export async function setQuotationStatus(tenantId: string, id: string, status: string): Promise<MobileQuotationResult> {
  if (!MANUAL_TARGET_STATUSES.has(status)) {
    throw new HttpError(400, `Status "${status}" can't be set manually`);
  }
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.quotation.findUnique({ where: { id } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Quotation not found");
    if (row.status === "converted") throw new HttpError(400, "This quotation has already been converted and can't change status");
    await tx.quotation.update({ where: { id }, data: { status, localUpdatedAt: new Date() } });
    return { id };
  });
}

export type MobileQuotationStockCheckItem = {
  productId: string;
  productName: string;
  requestedQuantity: number;
  availableQuantity: number;
  sufficient: boolean;
};

/** Live stock at the quotation's own storefront for each line — lets APP warn before conversion.
 * A locally-sourced line never touched (and never will touch) this shop's own inventory, so it's
 * excluded — matches DESKTOP's own checkQuotationStock exactly. */
export async function checkQuotationStock(tenantId: string, id: string): Promise<MobileQuotationStockCheckItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.quotation.findUnique({ where: { id } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Quotation not found");

    const items = row.items as unknown as Array<{ productId: string; quantity: number; isLocallySourced: boolean }>;
    const trackedItems = items.filter((item) => !item.isLocallySourced);
    if (trackedItems.length === 0) return [];

    const [products, movementSums] = await Promise.all([
      tx.product.findMany({ where: { id: { in: trackedItems.map((i) => i.productId) } }, select: { id: true, name: true } }),
      tx.stockMovement.groupBy({
        by: ["productId"],
        where: { tenantId, locationId: row.locationId, productId: { in: trackedItems.map((i) => i.productId) } },
        _sum: { quantityChange: true },
      }),
    ]);
    const productNameById = new Map(products.map((p) => [p.id, p.name]));
    const stockByProduct = new Map(movementSums.map((m) => [m.productId, m._sum.quantityChange ?? 0]));

    return trackedItems.map((item) => {
      const availableQuantity = stockByProduct.get(item.productId) ?? 0;
      return {
        productId: item.productId,
        productName: productNameById.get(item.productId) ?? "—",
        requestedQuantity: item.quantity,
        availableQuantity,
        sufficient: availableQuantity >= item.quantity,
      };
    });
  });
}

/** Re-derives a quotation's frozen items into cart-item-input shape, applying any quantity overrides
 * the user made after a stock-check warning — the raw material both convert functions feed into
 * prepareMobileCart, which re-validates stock at conversion time regardless of what the quotation
 * itself said (stock can have moved since it was quoted). */
function buildConversionItems(
  quotationItems: Array<{
    productId: string;
    quantity: number;
    unitPriceCents: number;
    discountAmountCents: number;
    isLocallySourced: boolean;
    localCostCents: number | null;
    localSupplierId: string | null;
  }>,
  quantityOverrides: Array<{ productId: string; quantity: number }>,
): MobileCartItemInput[] {
  const overrideByProduct = new Map(quantityOverrides.map((entry) => [entry.productId, entry.quantity]));
  return quotationItems.map((item) => {
    const overriddenQuantity = overrideByProduct.get(item.productId);
    return {
      productId: item.productId,
      quantity: overriddenQuantity ?? item.quantity,
      discountAmountCents: item.discountAmountCents,
      // Frozen price carries over unchanged even under a quantity override — same as DESKTOP's own
      // repriceLineForQuantity keeping the frozen unit price and only re-deriving discount/tax.
      unitPriceCents: item.unitPriceCents,
      isLocallySourced: item.isLocallySourced,
      localCostCents: item.localCostCents ?? undefined,
      localSupplierId: item.localSupplierId ?? undefined,
    };
  });
}

async function requireAcceptedQuotationAtActiveBranch(tx: Prisma.TransactionClient, tenantId: string, employeeId: string, id: string) {
  const quotation = await tx.quotation.findUnique({ where: { id } });
  if (!quotation || quotation.tenantId !== tenantId) throw new NotFoundError("Quotation not found");
  if (quotation.status === "converted") throw new HttpError(400, "This quotation has already been converted");
  const liveStatus = computeQuotationStatus({ storedStatus: quotation.status, validUntil: quotation.validUntil });
  if (liveStatus !== "accepted") throw new HttpError(400, "Only accepted quotations can be converted");

  const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const locationId = await resolveMobileLocation(tx, tenantId, employee.branchId, quotation.locationId);
  if (quotation.locationId !== locationId) {
    throw new HttpError(400, "This quotation belongs to a different storefront");
  }
  return { quotation, employee, locationId };
}

export type MobileConvertResult = { id: string };

/** Converts an accepted quotation into a completed retail sale, preserving its quoted prices while
 * re-validating stock fresh. The quotation itself is never touched inventory-wise — only the new
 * sale is. Matches DESKTOP's own convertQuotationToSale. */
export async function convertQuotationToSale(tenantId: string, employeeId: string, id: string, input: unknown): Promise<MobileConvertResult> {
  const parsed: MobileConvertToSaleInput = mobileConvertToSaleSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const { quotation, employee, locationId } = await requireAcceptedQuotationAtActiveBranch(tx, tenantId, employeeId, id);

      const paymentMethod = await tx.paymentMethod.findUnique({ where: { id: parsed.paymentMethodId } });
      if (!paymentMethod || !paymentMethod.isActive) throw new HttpError(400, "Selected payment method is unavailable");
      if (paymentMethod.requiresReference && !parsed.paymentReference?.trim()) {
        throw new HttpError(400, `${paymentMethod.name} requires a reference`);
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } });
      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const quotationItems = quotation.items as unknown as Parameters<typeof buildConversionItems>[0];
      const conversionItems = buildConversionItems(quotationItems, parsed.quantityOverrides);
      const cart = await prepareMobileCart(tx, tenantId, locationId, conversionItems, tenantTaxConfig, { checkStock: true });

      const deliveryRow = quotation.delivery as unknown as {
        riderId: string | null;
        recipientName: string;
        country: string;
        town: string;
        physicalAddress: string;
        notes: string;
        feeCents: number;
        costCents: number;
      } | null;
      const deliveryFeeCents = deliveryRow?.feeCents ?? 0;
      // The quotation's own service charges carry straight into the resulting sale unchanged — this
      // IS the entire conversion carry-over mechanism for them, same as delivery below (matches
      // DESKTOP's own buildConversionCart, which reads the quotation's stored charges verbatim
      // rather than re-deciding them at conversion time).
      const quotationServiceCharges = quotation.serviceCharges as unknown as Array<{ feeCents: number }>;
      const serviceChargeFeeCents = quotationServiceCharges.reduce((sum, charge) => sum + charge.feeCents, 0);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;
      const amountReceivedCents = parsed.amountReceivedCents ?? grandTotalCents;
      if (amountReceivedCents < grandTotalCents) {
        throw new HttpError(400, "Amount received is less than the total");
      }

      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
      const receiptNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, RECEIPT_PREFIX, RECEIPT_DIGITS);
      const now = new Date();
      const saleId = `sale_${randomUUID()}`;

      await tx.sale.create({
        data: {
          id: saleId,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          receiptNumber,
          locationId,
          employeeId,
          customerId: quotation.customerId,
          saleStatus: "completed",
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
          grandTotalCents,
          paymentMethodId: parsed.paymentMethodId,
          paymentReference: parsed.paymentReference?.trim() || null,
          amountReceivedCents,
          changeGivenCents: amountReceivedCents - grandTotalCents,
          notes: quotation.notes,
          completedAt: now,
          transactionType: "retail_sale",
          paymentStatus: "paid",
          invoiceNumber: null,
          invoiceDate: null,
          dueDate: null,
          amountPaidCents: grandTotalCents,
          balanceDueCents: 0,
          invoiceNotes: null,
          // Carried over, not re-decided — converting shouldn't silently reset the customer's chosen
          // presentation for what is, from their side, the same document going final.
          includeTaxBreakdown: quotation.includeTaxBreakdown,
          includeBusinessInfo: quotation.includeBusinessInfo,
          payments: [],
          items: cart.items,
          serviceCharges: quotation.serviceCharges as Prisma.InputJsonValue,
          delivery: (quotation.delivery ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });

      if (cart.stockMovementRows.length > 0) {
        await tx.stockMovement.createMany({
          data: cart.stockMovementRows.map((movement) => ({
            id: movement.id,
            tenantId,
            deviceId: OWNER_APP_DEVICE_ID,
            productId: movement.productId,
            locationId,
            movementType: "sale",
            quantityChange: movement.quantityChange,
            referenceType: "sale",
            referenceId: saleId,
            performedBy: employeeId,
            allocationExplicit: false,
            localCreatedAt: now,
            localUpdatedAt: now,
          })),
        });
      }

      // Same delivery-cost-expense side effect checkout/invoice have — DESKTOP's own
      // convertQuotationToSale gets this for free by routing through insertCompletedSaleFromCart;
      // mobile doesn't share that exact function, so it's called explicitly here instead (caught
      // live: this was originally missing, verified via a real conversion test before shipping).
      if (deliveryRow && deliveryRow.costCents > 0) {
        const [customer, rider] = await Promise.all([
          quotation.customerId ? tx.customer.findUnique({ where: { id: quotation.customerId } }) : null,
          deliveryRow.riderId ? tx.rider.findUnique({ where: { id: deliveryRow.riderId } }) : null,
        ]);
        await createDeliveryCostExpenseIfNeeded(tx, tenantId, OWNER_APP_DEVICE_ID, mobileDeviceSequence, {
          documentNumber: receiptNumber,
          customerName: customer?.name ?? null,
          delivery: { ...deliveryRow, riderId: deliveryRow.riderId ?? undefined },
          riderName: rider?.name ?? null,
          locationId,
          paymentMethodId: parsed.paymentMethodId,
          now,
        });
      }

      await tx.quotation.update({ where: { id }, data: { status: "converted", convertedSaleId: saleId, convertedAt: now, localUpdatedAt: now } });

      return { id: saleId };
    },
    { timeoutMs: 15_000 },
  );
}

/** Converts an accepted quotation into an invoice (credit sale), preserving its quoted prices while
 * re-validating stock fresh. Unlike converting to a sale (walk-in is fine there), an invoice is a
 * credit document — needs a real customer to bill and track a balance against, matching DESKTOP's
 * own convertQuotationToInvoice exactly (a walk-in quotation can't convert to an invoice). Delegates
 * the actual insert to mobile-invoices-service.ts's createInvoice, reusing everything that function
 * already does (numbering, stock deduction, delivery-cost expense) rather than a third copy of that
 * logic. */
export async function convertQuotationToInvoice(tenantId: string, employeeId: string, id: string, input: unknown): Promise<MobileConvertResult> {
  const parsed: MobileConvertToInvoiceInput = mobileConvertToInvoiceSchema.parse(input);

  const { quotation, locationId } = await withTenantContext(tenantId, (tx) => requireAcceptedQuotationAtActiveBranch(tx, tenantId, employeeId, id));
  if (!quotation.customerId) {
    throw new HttpError(400, "This quotation has no customer — pick a customer before converting it to an invoice.");
  }

  const quotationItems = quotation.items as unknown as Parameters<typeof buildConversionItems>[0];
  const deliveryRow = quotation.delivery as unknown as {
    riderId: string | null;
    recipientName: string;
    country: string;
    town: string;
    physicalAddress: string;
    notes: string;
    feeCents: number;
    costCents: number;
  } | null;

  const result = await createInvoice(tenantId, employeeId, {
    customerId: quotation.customerId,
    transactionType: "invoice",
    dueDate: parsed.dueDate,
    invoiceNotes: quotation.notes ?? undefined,
    includeTaxBreakdown: quotation.includeTaxBreakdown,
    includeBusinessInfo: quotation.includeBusinessInfo,
    items: buildConversionItems(quotationItems, parsed.quantityOverrides),
    initialPayment: null,
    delivery: deliveryRow
      ? {
          riderId: deliveryRow.riderId ?? undefined,
          recipientName: deliveryRow.recipientName,
          country: deliveryRow.country,
          town: deliveryRow.town,
          physicalAddress: deliveryRow.physicalAddress,
          notes: deliveryRow.notes,
          feeCents: deliveryRow.feeCents,
          costCents: deliveryRow.costCents,
        }
      : undefined,
    // Carried over unchanged, same reasoning as delivery above.
    serviceCharges: (quotation.serviceCharges as unknown as MobileServiceChargeInput[]).map((charge) => ({
      name: charge.name,
      feeCents: charge.feeCents,
      costCents: charge.costCents,
    })),
    locationId,
  });

  await withTenantContext(tenantId, (tx) =>
    tx.quotation.update({ where: { id }, data: { status: "converted", convertedSaleId: result.id, convertedAt: new Date(), localUpdatedAt: new Date() } }),
  );

  return result;
}
