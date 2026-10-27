import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import { prisma } from "../prisma.js";
import { computeLineTax, computeTaxBreakdown, resolveProductTaxConfig, type TaxBreakdownEntry } from "../lib/tax-breakdown.js";
import {
  type MobileCreatePurchaseInput,
  mobileCreatePurchaseSchema,
  mobilePurchasePaymentSchema,
  mobileReceivePurchaseSchema,
  mobileUpdatePurchaseSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

export type MobilePurchaseListItem = {
  id: string;
  purchaseNumber: string;
  supplierName: string;
  locationName: string;
  locationId: string;
  status: string;
  paymentStatus: string;
  grandTotalCents: number;
  amountPaidCents: number;
  orderedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  currency: string;
};

type RawPurchaseItem = {
  id: string;
  productId: string;
  sellingPriceCents?: number | null;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCostCents: number;
  discountAmountCents: number;
  taxType: string;
  taxAmountCents: number;
  lineTotalCents: number;
};

type RawPurchasePayment = {
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  paidByName: string;
  paidAt: string;
};

export type MobilePurchaseItem = {
  /** purchase_items id — what Receive Goods sends back per line. */
  id: string;
  productId: string;
  productName: string;
  /** Re-opening a draft for editing needs these two back. */
  taxType: string;
  sellingPriceCents: number | null;
  sku: string | null;
  orderedQuantity: number;
  receivedQuantity: number;
  unitCostCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  lineTotalCents: number;
};

export type MobilePurchasePayment = {
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  paidByName: string;
  paidAt: string;
};

export type MobilePurchaseDetail = {
  id: string;
  purchaseNumber: string;
  supplierId: string;
  locationId: string;
  /** "Shipping Fee" — owed to the supplier once anything is received. */
  shippingCostCents: number;
  /** "Shipping Cost" — the business's own expense, never owed. */
  shippingExpenseCents: number;
  /** Item value actually received so far — what payments are made against. */
  receivedValueCents: number;
  /** What can be paid right now: received value (+ shipping fee once anything arrived) − paid. */
  balanceDueCents: number;
  supplierName: string;
  supplierPhone: string | null;
  locationName: string;
  supplierInvoiceNumber: string | null;
  status: string;
  taxType: string;
  paymentStatus: string;
  orderedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  items: MobilePurchaseItem[];
  subtotalCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  taxBreakdown: TaxBreakdownEntry[];
  vatRatePercent: number;
  grandTotalCents: number;
  amountPaidCents: number;
  payments: MobilePurchasePayment[];
  currency: string;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** DESKTOP's shared/lib/purchase.ts computePurchasePayableCents — what's owed right now: item value
 * received so far, plus the whole shipping fee once anything at all has arrived. */
function computePurchasePayableCents(receivedValueCents: number, shippingFeeCents: number): number {
  return receivedValueCents + (receivedValueCents > 0 ? shippingFeeCents : 0);
}

/** No PDF/download/share capability exists for Purchases anywhere in this app (confirmed against
 * DESKTOP — a Purchase Order's only "document" is a locally-attached file, not a generated one), so
 * unlike Sales/Invoices/Quotations this is view-only: a lightweight list plus a full-detail fetch on
 * tap, no share-link minting. */
export async function listPurchases(tenantId: string, locationId: string | null): Promise<MobilePurchaseListItem[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const purchases = await tx.purchase.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 200,
    });

    const [locations, suppliers] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.supplier.findMany({ where: { tenantId }, select: { id: true, businessName: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const supplierNameById = new Map(suppliers.map((s) => [s.id, s.businessName]));

    return purchases.map((purchase) => ({
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      supplierName: supplierNameById.get(purchase.supplierId) ?? "—",
      locationName: locationNameById.get(purchase.locationId) ?? "—",
      locationId: purchase.locationId,
      status: purchase.status,
      paymentStatus: purchase.paymentStatus,
      grandTotalCents: purchase.grandTotalCents,
      amountPaidCents: purchase.amountPaidCents,
      orderedAt: purchase.orderedAt ? purchase.orderedAt.toISOString() : null,
      receivedAt: purchase.receivedAt ? purchase.receivedAt.toISOString() : null,
      createdAt: purchase.localCreatedAt.toISOString(),
      currency: tenant.currency,
    }));
  });
}

export async function getPurchase(tenantId: string, purchaseId: string): Promise<MobilePurchaseDetail | null> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true, vatRatePercent: true } });

  return withTenantContext(tenantId, async (tx) => {
    const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return null;

    const items = asArray<RawPurchaseItem>(purchase.items);
    const [location, supplier, products] = await Promise.all([
      tx.location.findUnique({ where: { id: purchase.locationId }, select: { locationName: true } }),
      tx.supplier.findUnique({ where: { id: purchase.supplierId }, select: { businessName: true, phone1: true } }),
      tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, name: true, sku: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      supplierId: purchase.supplierId,
      locationId: purchase.locationId,
      shippingCostCents: purchase.shippingCostCents,
      shippingExpenseCents: purchase.shippingExpenseCents,
      receivedValueCents: purchase.receivedValueCents,
      balanceDueCents: Math.max(0, computePurchasePayableCents(purchase.receivedValueCents, purchase.shippingCostCents) - purchase.amountPaidCents),
      supplierName: supplier?.businessName ?? "—",
      supplierPhone: supplier?.phone1 ?? null,
      locationName: location?.locationName ?? "—",
      supplierInvoiceNumber: purchase.supplierInvoiceNumber,
      status: purchase.status,
      taxType: purchase.taxType,
      paymentStatus: purchase.paymentStatus,
      orderedAt: purchase.orderedAt ? purchase.orderedAt.toISOString() : null,
      receivedAt: purchase.receivedAt ? purchase.receivedAt.toISOString() : null,
      notes: purchase.notes,
      items: items.map((item) => ({
        id: item.id,
        productId: item.productId,
        taxType: item.taxType,
        sellingPriceCents: item.sellingPriceCents ?? null,
        productName: productById.get(item.productId)?.name ?? "Unknown product",
        sku: productById.get(item.productId)?.sku ?? null,
        orderedQuantity: item.orderedQuantity,
        receivedQuantity: item.receivedQuantity,
        unitCostCents: item.unitCostCents,
        discountAmountCents: item.discountAmountCents,
        taxAmountCents: item.taxAmountCents,
        lineTotalCents: item.lineTotalCents,
      })),
      subtotalCents: purchase.subtotalCents,
      discountAmountCents: purchase.discountAmountCents,
      taxAmountCents: purchase.taxAmountCents,
      taxBreakdown: computeTaxBreakdown(
        items.map((item) => ({
          unitPriceCents: item.unitCostCents,
          quantity: item.orderedQuantity,
          discountAmountCents: item.discountAmountCents,
          taxType: item.taxType,
          taxAmountCents: item.taxAmountCents,
          lineTotalCents: item.lineTotalCents,
        })),
      ),
      vatRatePercent: tenant.vatRatePercent,
      grandTotalCents: purchase.grandTotalCents,
      amountPaidCents: purchase.amountPaidCents,
      payments: asArray<RawPurchasePayment>(purchase.payments).map((payment) => ({
        paymentMethodName: payment.paymentMethodName,
        amountCents: payment.amountCents,
        reference: payment.reference,
        paidByName: payment.paidByName,
        paidAt: payment.paidAt,
      })),
      currency: tenant.currency,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Write actions — create / place order / cancel / receive goods / record payment. A faithful port
// of DESKTOP's own purchase-service.ts (same statuses, same money rules, same side effects), writing
// rows in the exact shapes DESKTOP's push produces so its bespoke applyPurchasePulledRow, stock
// movement pull and supplier-balance-entry pull all apply them unchanged:
//  - placing an order re-prices the products (syncProductPricingFromOrder) and books the business's
//    own shipping cost as an Expense ("Shipping Costs" category, sourceType "purchase");
//  - stock only moves on Receive Goods ("purchase" movements at the destination), and the supplier
//    balance only grows then, by exactly what that batch is worth (+ the whole shipping fee on the
//    FIRST batch);
//  - payments are only ever against what's been received (computePurchasePayableCents), and each
//    one writes a negative "payment" balance entry.
// Every purchase write stamps deviceId "owner-app" + fresh localUpdatedAt/syncedAt so DESKTOP's
// pull cursor sees it; purchases are conflict-aware on DESKTOP, so a desktop's own unsynced edit to
// the same PO surfaces as a normal conflict rather than silently overwriting.
// ---------------------------------------------------------------------------------------------

/** Matches DESKTOP's own generatePurchaseNumber ("PO", 6 digits) — "PO-M3-000012" vs "PO-D1-…". */
const PURCHASE_PREFIX = "PO";
const PURCHASE_DIGITS = 6;
/** Same as mobile-delivery.ts's EXPENSE_PREFIX — DESKTOP's own generateExpenseNumber. */
const EXPENSE_PREFIX = "EXP";
const EXPENSE_DIGITS = 6;
/** DESKTOP's own expense-service.ts SHIPPING_COST_CATEGORY_NAME, verbatim. */
const SHIPPING_COST_CATEGORY_NAME = "Shipping Costs";
/** DESKTOP's LEGACY_PURCHASE_TAX_TYPE — the whole-order column is unused going forward. */
const LEGACY_PURCHASE_TAX_TYPE = "no_vat";

type StoredPurchaseItem = RawPurchaseItem & { sellingPriceCents: number | null; createdAt: string; updatedAt: string };

type StoredPurchasePayment = {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  paidBy: string;
  paidByName: string;
  paidAt: string;
  notes: string | null;
};

type ReceivingEventItem = {
  purchaseItemId: string;
  productId: string;
  productName: string;
  sku: string;
  receivingQuantity: number;
  previousQuantity: number;
  newQuantity: number;
};

/** DESKTOP's computePurchasePaymentStatus (shared/lib/purchase.ts). */
function computePurchasePaymentStatus(receivedValueCents: number, shippingFeeCents: number, amountPaidCents: number): string {
  const payable = computePurchasePayableCents(receivedValueCents, shippingFeeCents);
  if (amountPaidCents <= 0) return "unpaid";
  if (amountPaidCents >= payable) return "paid";
  return "partially_paid";
}

/** DESKTOP's computePurchaseReceivingStatus. */
function computePurchaseReceivingStatus(items: Array<{ orderedQuantity: number; receivedQuantity: number }>): string {
  const ordered = items.reduce((sum, i) => sum + i.orderedQuantity, 0);
  const received = items.reduce((sum, i) => sum + i.receivedQuantity, 0);
  if (received <= 0) return "ordered";
  if (received >= ordered) return "received";
  return "partially_received";
}

async function loadActor(tx: Prisma.TransactionClient, session: MobileSession) {
  const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
  return {
    id: actor.id,
    name: `${actor.firstName} ${actor.lastName}`.trim(),
    branchScope: session.isSuperAdmin ? null : actor.branchId,
    mobileDeviceSequence: actor.mobileDeviceSequence,
  };
}

async function loadPurchase(tx: Prisma.TransactionClient, tenantId: string, purchaseId: string) {
  const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
  if (!purchase || purchase.tenantId !== tenantId) throw new NotFoundError("Purchase not found");
  return purchase;
}

/** DESKTOP's syncProductPricingFromOrder / updatePricingFromPurchaseRow: buying price ← unit cost,
 * minimum price pinned to the new buying price, selling price only when the line gave one. */
async function syncProductPricingFromOrder(
  tx: Prisma.TransactionClient,
  items: Array<{ productId: string; unitCostCents: number; sellingPriceCents: number | null }>,
  now: Date,
): Promise<void> {
  for (const item of items) {
    await tx.product.update({
      where: { id: item.productId },
      data: {
        buyingPriceCents: item.unitCostCents,
        minimumPriceCents: item.unitCostCents,
        ...(item.sellingPriceCents !== null ? { sellingPriceCents: item.sellingPriceCents } : {}),
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
  }
}

/** DESKTOP's createShippingCostExpenseIfNeeded, create-only (mobile never edits a placed order, so
 * there's never an existing expense to update). Same Cash-first payment method fallback as
 * mobile-delivery.ts. */
async function createShippingCostExpense(
  tx: Prisma.TransactionClient,
  tenantId: string,
  mobileDeviceSequence: number,
  purchase: { id: string; purchaseNumber: string; supplierName: string; locationId: string; shippingExpenseCents: number },
  now: Date,
): Promise<void> {
  if (purchase.shippingExpenseCents <= 0) return;
  const paymentMethod =
    (await tx.paymentMethod.findFirst({ where: { tenantId, code: "CASH", isActive: true } })) ??
    (await tx.paymentMethod.findFirst({ where: { tenantId, isActive: true }, orderBy: { sortOrder: "asc" } }));
  if (!paymentMethod) return;

  let category = await tx.expenseCategory.findFirst({ where: { tenantId, name: SHIPPING_COST_CATEGORY_NAME } });
  if (!category) {
    category = await tx.expenseCategory.create({
      data: {
        id: `expense_category_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        name: SHIPPING_COST_CATEGORY_NAME,
        description: null,
        status: "active",
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
  }

  await tx.expense.create({
    data: {
      id: `expense_${randomUUID()}`,
      tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      kind: "general",
      expenseNumber: await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, EXPENSE_PREFIX, EXPENSE_DIGITS),
      expenseDate: now.toISOString().slice(0, 10),
      categoryId: category.id,
      amountCents: purchase.shippingExpenseCents,
      paidBy: null,
      paymentMethodId: paymentMethod.id,
      storefrontId: purchase.locationId,
      reference: null,
      description: `Purchase: ${purchase.purchaseNumber}\nSupplier: ${purchase.supplierName}`,
      sourceType: "purchase",
      sourceId: purchase.id,
      status: "active",
      isRecurring: false,
      localCreatedAt: now,
      localUpdatedAt: now,
    },
  });
}

async function recordSupplierBalanceEntry(
  tx: Prisma.TransactionClient,
  entry: { tenantId: string; supplierId: string; entryType: string; amountCents: number; referenceId: string; notes: string | null; performedBy: string; now: Date },
): Promise<void> {
  if (entry.amountCents === 0) return;
  await tx.supplierBalanceEntry.create({
    data: {
      id: `supplier_balance_${randomUUID()}`,
      tenantId: entry.tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      supplierId: entry.supplierId,
      entryType: entry.entryType,
      amountCents: entry.amountCents,
      referenceType: "purchase",
      referenceId: entry.referenceId,
      notes: entry.notes,
      performedBy: entry.performedBy,
      // Immutable row — same localCreatedAt-for-both convention as StockMovement.
      localCreatedAt: entry.now,
      localUpdatedAt: entry.now,
    },
  });
}

type PurchaseHeaderInput = { supplierId: string; locationId: string; supplierInvoiceNumber: string | null };
type PurchaseLineInput = MobileCreatePurchaseInput["items"][number];

/** The header checks DESKTOP's createPurchase/updatePurchase share: supplier + destination belong to
 * the tenant, the branch-scope boundary, and the supplier invoice number is unique per supplier
 * (ignoring the purchase being edited). */
async function validatePurchaseHeader(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchScope: string | null,
  header: PurchaseHeaderInput,
  excludePurchaseId?: string,
) {
  const [supplier, location] = await Promise.all([
    tx.supplier.findUnique({ where: { id: header.supplierId } }),
    tx.location.findUnique({ where: { id: header.locationId } }),
  ]);
  if (!supplier || supplier.tenantId !== tenantId) throw new NotFoundError("Supplier not found");
  if (!location || location.tenantId !== tenantId) throw new NotFoundError("Destination location not found");
  // Same boundary as mobile stock changes: a branch-scoped employee receives into their own
  // storefront or the Main Store only.
  if (branchScope && location.id !== branchScope && location.locationType !== "distribution_center") {
    throw new HttpError(403, "You can only receive purchases into your own storefront or the Main Store");
  }
  if (header.supplierInvoiceNumber) {
    const duplicate = await tx.purchase.findFirst({
      where: {
        tenantId,
        supplierId: supplier.id,
        supplierInvoiceNumber: header.supplierInvoiceNumber,
        ...(excludePurchaseId ? { id: { not: excludePurchaseId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`Supplier invoice number "${header.supplierInvoiceNumber}" is already recorded for this supplier`);
  }
  return { supplier, location };
}

/** DESKTOP's prepareCart, line for line — tax computed here from each line's own taxType + the
 * product's inclusive/exclusive setting, never taken from the client. */
async function preparePurchaseLines(tx: Prisma.TransactionClient, tenantId: string, lines: PurchaseLineInput[], shippingCostCents: number, now: Date) {
  const [products, tenant] = await Promise.all([
    tx.product.findMany({ where: { tenantId, id: { in: lines.map((i) => i.productId) } }, select: { id: true, pricesTaxInclusive: true } }),
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const tenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
  const nowIso = now.toISOString();

  const items: StoredPurchaseItem[] = lines.map((item) => {
    const product = productById.get(item.productId);
    if (!product) throw new NotFoundError("One of the selected products was not found");
    const taxableCents = item.orderedQuantity * item.unitCostCents - item.discountAmountCents;
    const { grossCents, taxCents } = computeLineTax(taxableCents, item.taxType, resolveProductTaxConfig(product, tenantTaxConfig));
    return {
      id: `purchase_item_${randomUUID()}`,
      productId: product.id,
      orderedQuantity: item.orderedQuantity,
      receivedQuantity: 0,
      unitCostCents: item.unitCostCents,
      sellingPriceCents: item.sellingPriceCents,
      discountAmountCents: item.discountAmountCents,
      taxType: item.taxType,
      taxAmountCents: taxCents,
      lineTotalCents: grossCents,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  });
  return {
    items,
    subtotalCents: items.reduce((sum, i) => sum + i.orderedQuantity * i.unitCostCents, 0),
    discountAmountCents: items.reduce((sum, i) => sum + i.discountAmountCents, 0),
    taxAmountCents: items.reduce((sum, i) => sum + i.taxAmountCents, 0),
    grandTotalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0) + shippingCostCents,
  };
}

export async function createPurchase(session: MobileSession, input: unknown): Promise<{ id: string; purchaseNumber: string }> {
  const parsed: MobileCreatePurchaseInput = mobileCreatePurchaseSchema.parse(input);
  const purchaseId = parsed.id.startsWith("purchase_") ? parsed.id : `purchase_${parsed.id}`;
  const { tenantId } = session;
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.purchase.findUnique({ where: { id: purchaseId }, select: { id: true, purchaseNumber: true } });
    if (existing) return existing;

    const actor = await loadActor(tx, session);
    const { supplier, location } = await validatePurchaseHeader(tx, tenantId, actor.branchScope, parsed);
    const cart = await preparePurchaseLines(tx, tenantId, parsed.items, parsed.shippingCostCents, now);

    const sequence = await ensureEmployeeMobileSequence(tx, tenantId, actor.id, actor.mobileDeviceSequence);
    const purchaseNumber = await mintMobileDocumentNumber(tx, tenantId, sequence, PURCHASE_PREFIX, PURCHASE_DIGITS);
    const ordered = parsed.intent === "ordered";

    await tx.purchase.create({
      data: {
        id: purchaseId,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        purchaseNumber,
        supplierId: supplier.id,
        supplierInvoiceNumber: parsed.supplierInvoiceNumber,
        locationId: location.id,
        status: parsed.intent,
        taxType: LEGACY_PURCHASE_TAX_TYPE,
        subtotalCents: cart.subtotalCents,
        discountAmountCents: cart.discountAmountCents,
        taxAmountCents: cart.taxAmountCents,
        shippingCostCents: parsed.shippingCostCents,
        shippingExpenseCents: parsed.shippingExpenseCents,
        grandTotalCents: cart.grandTotalCents,
        receivedValueCents: 0,
        paymentStatus: "unpaid",
        amountPaidCents: 0,
        payments: [],
        receivingEvents: [],
        notes: parsed.notes,
        orderedAt: ordered ? now : null,
        items: cart.items as unknown as Prisma.InputJsonValue,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });

    if (ordered) {
      await syncProductPricingFromOrder(tx, cart.items, now);
      await createShippingCostExpense(
        tx,
        tenantId,
        sequence,
        { id: purchaseId, purchaseNumber, supplierName: supplier.businessName, locationId: location.id, shippingExpenseCents: parsed.shippingExpenseCents },
        now,
      );
    }
    return { id: purchaseId, purchaseNumber };
  });
}

/**
 * Rewrites a DRAFT purchase — supplier, destination, lines, shipping, notes — and optionally places
 * it in the same save (intent "ordered": then exactly markPurchaseOrdered's side effects run —
 * product re-pricing and the shipping-cost expense). Draft-only on purpose: a draft has had no side
 * effects yet, so a rewrite can't leave anything stale behind. DESKTOP also lets an ordered purchase
 * with nothing received or paid be edited; that path (undoing/redoing its re-pricing and expense)
 * stays DESKTOP-only.
 */
export async function updateDraftPurchase(session: MobileSession, purchaseId: string, input: unknown): Promise<{ id: string; status: string }> {
  const parsed = mobileUpdatePurchaseSchema.parse(input);
  const { tenantId } = session;
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const purchase = await loadPurchase(tx, tenantId, purchaseId);
    if (purchase.status !== "draft") throw new HttpError(400, "Only a draft purchase can be edited here — this one has already been placed");

    const actor = await loadActor(tx, session);
    const { supplier, location } = await validatePurchaseHeader(tx, tenantId, actor.branchScope, parsed, purchaseId);
    const cart = await preparePurchaseLines(tx, tenantId, parsed.items, parsed.shippingCostCents, now);
    const ordered = parsed.intent === "ordered";

    await tx.purchase.update({
      where: { id: purchaseId },
      data: {
        supplierId: supplier.id,
        supplierInvoiceNumber: parsed.supplierInvoiceNumber,
        locationId: location.id,
        status: parsed.intent,
        subtotalCents: cart.subtotalCents,
        discountAmountCents: cart.discountAmountCents,
        taxAmountCents: cart.taxAmountCents,
        shippingCostCents: parsed.shippingCostCents,
        shippingExpenseCents: parsed.shippingExpenseCents,
        grandTotalCents: cart.grandTotalCents,
        notes: parsed.notes,
        orderedAt: ordered ? now : null,
        items: cart.items as unknown as Prisma.InputJsonValue,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });

    if (ordered) {
      await syncProductPricingFromOrder(tx, cart.items, now);
      const sequence = await ensureEmployeeMobileSequence(tx, tenantId, actor.id, actor.mobileDeviceSequence);
      await createShippingCostExpense(
        tx,
        tenantId,
        sequence,
        { id: purchaseId, purchaseNumber: purchase.purchaseNumber, supplierName: supplier.businessName, locationId: location.id, shippingExpenseCents: parsed.shippingExpenseCents },
        now,
      );
    }
    return { id: purchaseId, status: parsed.intent };
  });
}

/** Last buying price per product — pre-fills a new purchase line's unit cost. A separate lookup (not
 * part of the product list every cashier loads) so cost prices only reach people who buy stock or
 * manage products. */
export async function listProductCosts(tenantId: string): Promise<Record<string, number>> {
  return withTenantContext(tenantId, async (tx) => {
    const rows = await tx.product.findMany({ where: { tenantId, status: "active", trackStock: true }, select: { id: true, buyingPriceCents: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r.buyingPriceCents]));
  });
}

/** Draft → ordered (DESKTOP's markPurchaseOrdered). */
export async function markPurchaseOrdered(session: MobileSession, purchaseId: string): Promise<{ id: string }> {
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const purchase = await loadPurchase(tx, session.tenantId, purchaseId);
    if (purchase.status !== "draft") throw new HttpError(400, "Only draft purchases can be marked as ordered");
    const actor = await loadActor(tx, session);

    await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: "ordered", orderedAt: now, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    await syncProductPricingFromOrder(
      tx,
      asArray<StoredPurchaseItem>(purchase.items).map((i) => ({ productId: i.productId, unitCostCents: i.unitCostCents, sellingPriceCents: i.sellingPriceCents ?? null })),
      now,
    );

    const supplier = await tx.supplier.findUnique({ where: { id: purchase.supplierId }, select: { businessName: true } });
    const sequence = await ensureEmployeeMobileSequence(tx, session.tenantId, actor.id, actor.mobileDeviceSequence);
    await createShippingCostExpense(
      tx,
      session.tenantId,
      sequence,
      {
        id: purchase.id,
        purchaseNumber: purchase.purchaseNumber,
        supplierName: supplier?.businessName ?? "—",
        locationId: purchase.locationId,
        shippingExpenseCents: purchase.shippingExpenseCents,
      },
      now,
    );
    return { id: purchaseId };
  });
}

/** DESKTOP's cancelPurchase — only before anything is received. Its linked shipping-cost expense is
 * archived (never hard-deleted — DESKTOP's removeSystemExpense rule for a synced expense). */
export async function cancelPurchase(session: MobileSession, purchaseId: string): Promise<{ id: string }> {
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const purchase = await loadPurchase(tx, session.tenantId, purchaseId);
    if (purchase.status === "cancelled") throw new HttpError(400, "This purchase is already cancelled");
    if (purchase.status === "partially_received" || purchase.status === "received") {
      throw new HttpError(400, "This purchase already has received stock and can't be cancelled");
    }

    await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: "cancelled", deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    await tx.expense.updateMany({
      where: { tenantId: session.tenantId, sourceType: "purchase", sourceId: purchaseId, status: { not: "archived" } },
      data: { status: "archived", deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: purchaseId };
  });
}

/** DESKTOP's receivePurchaseGoods: partial or full, repeatable until every line is in. */
export async function receivePurchaseGoods(session: MobileSession, purchaseId: string, input: unknown): Promise<{ id: string; status: string }> {
  const parsed = mobileReceivePurchaseSchema.parse(input);
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const purchase = await loadPurchase(tx, tenantId, purchaseId);
    if (purchase.status !== "ordered" && purchase.status !== "partially_received") {
      throw new HttpError(400, "Only ordered or partially received purchases can receive stock");
    }
    const actor = await loadActor(tx, session);

    const items = asArray<StoredPurchaseItem>(purchase.items);
    const itemById = new Map(items.map((i) => [i.id, i]));
    for (const entry of parsed.items) {
      const item = itemById.get(entry.purchaseItemId);
      if (!item) throw new NotFoundError("One of the selected purchase lines was not found");
      const remaining = item.orderedQuantity - item.receivedQuantity;
      if (entry.receivingQuantity > remaining) {
        throw new HttpError(400, `Can't receive ${entry.receivingQuantity} units — only ${remaining} remain outstanding`);
      }
    }

    const products = await tx.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } },
      select: { id: true, name: true, sku: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));
    const nowIso = now.toISOString();
    const eventItems: ReceivingEventItem[] = [];
    let batchValueCents = 0;

    for (const entry of parsed.items) {
      const item = itemById.get(entry.purchaseItemId)!;
      const balance = await tx.inventory.findUnique({
        where: { productId_locationId: { productId: item.productId, locationId: purchase.locationId } },
        select: { quantity: true },
      });
      const previousQuantity = balance?.quantity ?? 0;
      const newQuantity = previousQuantity + entry.receivingQuantity;

      item.receivedQuantity += entry.receivingQuantity;
      item.updatedAt = nowIso;
      batchValueCents += Math.round((item.lineTotalCents * entry.receivingQuantity) / item.orderedQuantity);

      await tx.stockMovement.create({
        data: {
          id: `movement_${randomUUID()}`,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          productId: item.productId,
          locationId: purchase.locationId,
          movementType: "purchase",
          quantityChange: entry.receivingQuantity,
          referenceType: "purchase",
          referenceId: purchase.id,
          performedBy: actor.id,
          notes: null,
          allocationExplicit: false,
          previousQuantity,
          newQuantity,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });

      const product = productById.get(item.productId);
      eventItems.push({
        purchaseItemId: item.id,
        productId: item.productId,
        productName: product?.name ?? "Unknown product",
        sku: product?.sku ?? "",
        receivingQuantity: entry.receivingQuantity,
        previousQuantity,
        newQuantity,
      });
    }

    const receivingEvents = [
      ...asArray<unknown>(purchase.receivingEvents),
      { id: `purchase_receiving_${randomUUID()}`, receivedBy: actor.id, receivedByName: actor.name, receivedAt: nowIso, items: eventItems },
    ];
    const receivedValueCents = purchase.receivedValueCents + batchValueCents;
    const status = computePurchaseReceivingStatus(items);

    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        items: items as unknown as Prisma.InputJsonValue,
        receivingEvents: receivingEvents as Prisma.InputJsonValue,
        receivedValueCents,
        paymentStatus: computePurchasePaymentStatus(receivedValueCents, purchase.shippingCostCents, purchase.amountPaidCents),
        status,
        ...(status === "received" ? { receivedAt: now } : {}),
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });

    if (batchValueCents > 0) {
      // The whole shipping fee becomes due with the FIRST batch (DESKTOP's feeNowDueCents rule).
      const feeNowDueCents = purchase.receivedValueCents === 0 ? purchase.shippingCostCents : 0;
      await recordSupplierBalanceEntry(tx, {
        tenantId,
        supplierId: purchase.supplierId,
        entryType: "purchase_received",
        amountCents: batchValueCents + feeNowDueCents,
        referenceId: purchase.id,
        notes: null,
        performedBy: actor.id,
        now,
      });
    }
    return { id: purchase.id, status };
  });
}

/** DESKTOP's recordPurchasePayment / markPurchasePaid (amount omitted = pay off what's due now). */
export async function recordPurchasePayment(
  session: MobileSession,
  purchaseId: string,
  input: unknown,
): Promise<{ id: string; paymentStatus: string }> {
  const parsed = mobilePurchasePaymentSchema.parse(input);
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const purchase = await loadPurchase(tx, tenantId, purchaseId);
    if (purchase.status === "cancelled") throw new HttpError(400, "This purchase has been cancelled");
    if (purchase.status === "draft") throw new HttpError(400, "This purchase hasn't been ordered yet — place the order before recording a payment");

    const balanceDueCents = computePurchasePayableCents(purchase.receivedValueCents, purchase.shippingCostCents) - purchase.amountPaidCents;
    if (balanceDueCents <= 0) {
      throw new HttpError(
        400,
        purchase.receivedValueCents === 0
          ? "Nothing has been received on this purchase yet — receive some or all of it before recording a payment"
          : "This purchase is already fully paid for what's been received",
      );
    }
    const amountCents = parsed.amountCents ?? balanceDueCents;
    if (amountCents > balanceDueCents) {
      throw new HttpError(400, `Amount exceeds the outstanding balance of ${(balanceDueCents / 100).toFixed(2)}`);
    }

    const method = await tx.paymentMethod.findUnique({ where: { id: parsed.paymentMethodId } });
    if (!method || method.tenantId !== tenantId) throw new NotFoundError("Payment method not found");
    if (!method.isActive) throw new HttpError(400, `"${method.name}" is not active`);
    if (method.requiresReference && !parsed.reference) throw new HttpError(400, `${method.name} requires a reference number`);

    const actor = await loadActor(tx, session);
    const payments: StoredPurchasePayment[] = [
      ...asArray<StoredPurchasePayment>(purchase.payments),
      {
        id: `purchase_payment_${randomUUID()}`,
        paymentMethodId: method.id,
        paymentMethodName: method.name,
        amountCents,
        reference: parsed.reference,
        paidBy: actor.id,
        paidByName: actor.name,
        paidAt: now.toISOString(),
        notes: parsed.notes,
      },
    ];
    const amountPaidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    const paymentStatus = computePurchasePaymentStatus(purchase.receivedValueCents, purchase.shippingCostCents, amountPaidCents);

    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        payments: payments as unknown as Prisma.InputJsonValue,
        amountPaidCents,
        paymentStatus,
        paymentMethodId: method.id,
        paymentReference: parsed.reference,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    await recordSupplierBalanceEntry(tx, {
      tenantId,
      supplierId: purchase.supplierId,
      entryType: "payment",
      amountCents: -amountCents,
      referenceId: purchase.id,
      notes: parsed.notes,
      performedBy: actor.id,
      now,
    });
    return { id: purchase.id, paymentStatus };
  });
}
