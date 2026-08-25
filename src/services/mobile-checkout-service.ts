import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { computeLineTax, resolveProductTaxConfig, type TenantTaxConfig } from "../lib/tax-breakdown.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCheckoutInput, mobileCheckoutSchema } from "../schemas/mobile.js";

/** Matches DESKTOP's own sale-service.ts prefix exactly ("BL", 7 digits) — the tag is what tells a
 * mobile-minted number apart from a desktop one ("BL-M3-0000012" vs "BL-D1-0000058"), not the
 * prefix itself. */
const RECEIPT_PREFIX = "BL";
const RECEIPT_DIGITS = 7;

/** Same synthetic deviceId already used for Owner-App-originated writes elsewhere (see
 * routes/mobile.ts's share-link creation) — every synced row needs SOME deviceId, and a mobile
 * session was never issued a real one (see mobile-auth.ts's MobileSession doc comment). */
const OWNER_APP_DEVICE_ID = "owner-app";

export type MobileCheckoutResult = { id: string; receiptNumber: string; grandTotalCents: number };

export type MobilePaymentMethodOption = { id: string; name: string; requiresReference: boolean };

/** Backs the Checkout tab's payment method picker — same active/non-system-agnostic list DESKTOP's
 * own Checkout screen shows (no server-side filtering beyond isActive; a tenant's own payment method
 * list is small and not sensitive). */
export async function listPaymentMethods(tenantId: string): Promise<MobilePaymentMethodOption[]> {
  return withTenantContext(tenantId, async (tx) => {
    const methods = await tx.paymentMethod.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, requiresReference: true },
      orderBy: { sortOrder: "asc" },
    });
    return methods;
  });
}

/** Server-side equivalent of DESKTOP's document-number-service.ts generateDocumentNumber — mints
 * the numeric part atomically from MobileDocumentCounter (see that model's own schema comment for
 * why this can't be a local client-side reduce the way DESKTOP does it) and combines it with the
 * employee's own permanent "M{N}" tag. Must run inside the checkout's own transaction so a failed
 * checkout can never "burn" a number that was never actually used. */
async function mintMobileDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeMobileSequence: number,
  prefix: string,
  digits: number,
): Promise<string> {
  const counter = await tx.mobileDocumentCounter.upsert({
    where: { tenantId_prefix: { tenantId, prefix } },
    create: { tenantId, prefix, nextNumber: 2 },
    update: { nextNumber: { increment: 1 } },
  });
  const claimedNumber = counter.nextNumber - 1;
  return `${prefix}-M${employeeMobileSequence}-${String(claimedNumber).padStart(digits, "0")}`;
}

/**
 * Real, from-scratch checkout — deliberately NOT the generic /sync/push pipeline (see
 * sync-service.ts's own pushRows, which blindly upserts whatever JSON a client already computed,
 * with zero stock deduction or price/tax revalidation; sales isn't even in its ref-field validation
 * list). Every figure here is recomputed server-side from trusted Product/Tenant rows — the client's
 * own line items are just (productId, quantity, discountAmountCents), never trusted for pricing.
 *
 * Idempotency: `input.id` is minted CLIENT-SIDE (a UUID, same convention as DESKTOP's own local sale
 * ids) and resent unchanged on any retry. If a Sale with this id already exists, this is a no-op
 * success — no re-validation, no second stock deduction — so a network drop after the write
 * succeeded but before the response arrived can be safely retried by APP with the exact same body.
 *
 * Writes a Sale + StockMovement rows in the EXACT shape DESKTOP's own push already produces (see
 * schema.prisma's Sale/StockMovement doc comments), so DESKTOP's existing, already origin-agnostic
 * pull path (sync-engine.ts's applySalePulledRow / applyStockMovementPulledRow) picks this up with
 * zero DESKTOP-side changes — confirmed by reading both functions before writing this.
 */
export async function checkout(tenantId: string, employeeId: string, input: unknown): Promise<MobileCheckoutResult> {
  const parsed: MobileCheckoutInput = mobileCheckoutSchema.parse(input);

  return withTenantContext(
    tenantId,
    async (tx) => {
      const existing = await tx.sale.findUnique({ where: { id: parsed.id } });
      if (existing) {
        return { id: existing.id, receiptNumber: existing.receiptNumber ?? "", grandTotalCents: existing.grandTotalCents };
      }

      const [tenant, employee, location, paymentMethod, products] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } }),
        tx.employee.findUniqueOrThrow({ where: { id: employeeId } }),
        tx.location.findUnique({ where: { id: parsed.locationId } }),
        tx.paymentMethod.findUnique({ where: { id: parsed.paymentMethodId } }),
        tx.product.findMany({ where: { id: { in: parsed.items.map((i) => i.productId) } } }),
      ]);

      if (!location) throw new NotFoundError("Selected storefront was not found");
      // Mirrors DESKTOP's own requireActiveSession — a branch-scoped employee (every mobile-checkout
      // capable role in this phase) can only ever sell at their own assigned branch, never pick an
      // arbitrary location. No branch-less ("Super Admin") mobile-checkout path exists yet.
      if (employee.branchId !== parsed.locationId) {
        throw new HttpError(403, "You can only sell from your own assigned storefront.");
      }
      if (!paymentMethod || !paymentMethod.isActive) {
        throw new HttpError(400, "Selected payment method is unavailable");
      }
      if (paymentMethod.requiresReference && !parsed.paymentReference?.trim()) {
        throw new HttpError(400, `${paymentMethod.name} requires a reference`);
      }
      if (parsed.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: parsed.customerId } });
        if (!customer) throw new NotFoundError("Selected customer was not found");
      }

      const productById = new Map(products.map((p) => [p.id, p]));
      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };

      // Current stock per product AT THIS LOCATION — same groupBy aggregation
      // mobile-inventory-service.ts already uses for reads, just location-scoped instead of
      // tenant-wide (a sale only ever deducts from the one storefront it happened at).
      const movementSums = await tx.stockMovement.groupBy({
        by: ["productId"],
        where: { tenantId, locationId: parsed.locationId, productId: { in: parsed.items.map((i) => i.productId) } },
        _sum: { quantityChange: true },
      });
      const stockByProduct = new Map(movementSums.map((m) => [m.productId, m._sum.quantityChange ?? 0]));

      let subtotalCents = 0;
      let discountAmountCents = 0;
      let taxAmountCents = 0;
      const preparedItems: Array<{
        id: string;
        productId: string;
        quantity: number;
        unitPriceCents: number;
        discountAmountCents: number;
        taxType: string;
        taxAmountCents: number;
        lineTotalCents: number;
        isLocallySourced: boolean;
        localCostCents: number | null;
        localSupplierId: string | null;
        createdAt: string;
      }> = [];
      const stockMovementRows: Array<{ id: string; productId: string; quantityChange: number }> = [];
      const now = new Date();

      for (const item of parsed.items) {
        const product = productById.get(item.productId);
        if (!product || product.status !== "active") {
          throw new HttpError(400, "One of the selected products is no longer available");
        }

        // Phase 1: no wholesale price-break or cashier price-override on mobile yet — always the
        // product's own listed selling price.
        const unitPriceCents = product.sellingPriceCents;
        const lineSubtotalCents = unitPriceCents * item.quantity;
        if (item.discountAmountCents > lineSubtotalCents) {
          throw new HttpError(400, `Discount for "${product.name}" can't exceed its subtotal`);
        }
        const minLineSubtotalCents = product.minimumPriceCents !== null ? product.minimumPriceCents * item.quantity : 0;
        if (lineSubtotalCents - item.discountAmountCents < minLineSubtotalCents) {
          throw new HttpError(400, `Discount for "${product.name}" would drop it below its minimum price`);
        }

        if (product.trackStock) {
          const available = stockByProduct.get(product.id) ?? 0;
          if (available - item.quantity < 0 && !product.allowNegativeStock) {
            throw new HttpError(400, `"${product.name}" doesn't have enough stock (${available} available)`);
          }
        }

        const taxableCents = lineSubtotalCents - item.discountAmountCents;
        const productTaxConfig = resolveProductTaxConfig({ pricesTaxInclusive: product.pricesTaxInclusive }, tenantTaxConfig);
        const { grossCents, taxCents } = computeLineTax(taxableCents, product.taxType, productTaxConfig);

        subtotalCents += lineSubtotalCents;
        discountAmountCents += item.discountAmountCents;
        taxAmountCents += taxCents;

        preparedItems.push({
          id: randomUUID(),
          productId: product.id,
          quantity: item.quantity,
          unitPriceCents,
          discountAmountCents: item.discountAmountCents,
          taxType: product.taxType,
          taxAmountCents: taxCents,
          lineTotalCents: grossCents,
          isLocallySourced: false,
          localCostCents: null,
          localSupplierId: null,
          createdAt: now.toISOString(),
        });

        if (product.trackStock) {
          stockMovementRows.push({ id: randomUUID(), productId: product.id, quantityChange: -item.quantity });
        }
      }

      // Sums each line's own grossCents rather than branching off one global toggle — a cart can mix
      // inclusive and exclusive products via their own per-product overrides, same reasoning as
      // DESKTOP's own sale-service.ts prepareCart.
      const grandTotalCents = preparedItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
      if (parsed.amountReceivedCents < grandTotalCents) {
        throw new HttpError(400, "Amount received is less than the total");
      }
      const changeGivenCents = parsed.amountReceivedCents - grandTotalCents;

      // Defensive re-lease — covers a 7-day JWT issued before this employee's very first
      // post-feature login (see mobile-auth-service.ts's ensureMobileDeviceSequence, the normal
      // leasing path). Vanishingly rare, cheap to guard here too rather than ever mint a number with
      // no tag.
      let mobileDeviceSequence = employee.mobileDeviceSequence;
      if (mobileDeviceSequence === null) {
        const updatedTenant = await tx.tenant.update({
          where: { id: tenantId },
          data: { nextMobileDeviceSequence: { increment: 1 } },
        });
        mobileDeviceSequence = updatedTenant.nextMobileDeviceSequence - 1;
        await tx.employee.update({ where: { id: employeeId }, data: { mobileDeviceSequence } });
      }

      const receiptNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, RECEIPT_PREFIX, RECEIPT_DIGITS);

      await tx.sale.create({
        data: {
          id: parsed.id,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          receiptNumber,
          locationId: parsed.locationId,
          employeeId,
          customerId: parsed.customerId ?? null,
          saleStatus: "completed",
          subtotalCents,
          discountAmountCents,
          taxAmountCents,
          grandTotalCents,
          paymentMethodId: parsed.paymentMethodId,
          paymentReference: parsed.paymentReference ?? null,
          amountReceivedCents: parsed.amountReceivedCents,
          changeGivenCents,
          notes: null,
          completedAt: now,
          transactionType: "retail_sale",
          paymentStatus: "paid",
          invoiceNumber: null,
          invoiceDate: null,
          dueDate: null,
          amountPaidCents: grandTotalCents,
          balanceDueCents: 0,
          invoiceNotes: null,
          includeTaxBreakdown: true,
          payments: [],
          items: preparedItems,
          serviceCharges: [],
          delivery: Prisma.JsonNull,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });

      if (stockMovementRows.length > 0) {
        await tx.stockMovement.createMany({
          data: stockMovementRows.map((movement) => ({
            id: movement.id,
            tenantId,
            deviceId: OWNER_APP_DEVICE_ID,
            productId: movement.productId,
            locationId: parsed.locationId,
            movementType: "sale",
            quantityChange: movement.quantityChange,
            referenceType: "sale",
            referenceId: parsed.id,
            performedBy: employeeId,
            allocationExplicit: false,
            localCreatedAt: now,
            localUpdatedAt: now,
          })),
        });
      }

      return { id: parsed.id, receiptNumber: receiptNumber ?? "", grandTotalCents };
    },
    // Generous relative to how long a single checkout actually takes — matches sync-service.ts's own
    // reasoning for raising the interactive-transaction timeout past Prisma's 5s default, here for a
    // handful of queries plus one createMany rather than a 200-row batch.
    { timeoutMs: 15_000 },
  );
}
