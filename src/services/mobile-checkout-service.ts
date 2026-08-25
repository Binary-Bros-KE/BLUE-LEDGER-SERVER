import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { computeLineTax, resolveProductTaxConfig, type TenantTaxConfig } from "../lib/tax-breakdown.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCheckoutInput, mobileCheckoutSchema } from "../schemas/mobile.js";
import { isStorefrontLocationType } from "./mobile-sales-service.js";

/** Matches DESKTOP's own sale-service.ts prefix exactly ("BL", 7 digits) — the tag is what tells a
 * mobile-minted number apart from a desktop one ("BL-M3-0000012" vs "BL-D1-0000058"), not the
 * prefix itself. */
const RECEIPT_PREFIX = "BL";
const RECEIPT_DIGITS = 7;

/** Matches DESKTOP's own delivery-note-service.ts generateDeliveryNoteNumber exactly ("DN", 6
 * digits). */
const DELIVERY_NOTE_PREFIX = "DN";
const DELIVERY_NOTE_DIGITS = 6;

/** Matches DESKTOP's own expense-service.ts generateExpenseNumber exactly ("EXP", 6 digits). */
const EXPENSE_PREFIX = "EXP";
const EXPENSE_DIGITS = 6;

/** Deliberately a plain constant, not tenant-configurable — mirrors DESKTOP's own
 * expense-service.ts DELIVERY_COST_CATEGORY_NAME verbatim, so a delivery cost recorded from either
 * device always lands in the SAME category, never two differently-named ones per origin. */
const DELIVERY_COST_CATEGORY_NAME = "Delivery Costs";

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

      if (!location || location.tenantId !== tenantId) throw new NotFoundError("Selected storefront was not found");
      // Mirrors DESKTOP's own sale-service.ts requireActiveSession exactly: a branch-scoped employee
      // can ONLY ever sell at their own assigned branch (parsed.locationId is ignored/rejected if it
      // doesn't match — never trusted as a free choice). A branch-less employee (Super Admin,
      // typically) has no such default, so APP shows a StorefrontPicker and whatever they pick here
      // is validated as a real, active, genuine storefront (never the Main Store/warehouse, which
      // nothing is ever directly sold from) — same two rules, same reasoning, same error shape as
      // DESKTOP used to flatly block this case entirely.
      if (employee.branchId) {
        if (employee.branchId !== parsed.locationId) {
          throw new HttpError(403, "You can only sell from your own assigned storefront.");
        }
      } else {
        if (!isStorefrontLocationType(location.locationType)) {
          throw new HttpError(400, `"${location.locationName}" isn't a storefront`);
        }
        if (location.status !== "active") {
          throw new HttpError(400, `"${location.locationName}" is not active`);
        }
      }
      if (!paymentMethod || !paymentMethod.isActive) {
        throw new HttpError(400, "Selected payment method is unavailable");
      }
      if (paymentMethod.requiresReference && !parsed.paymentReference?.trim()) {
        throw new HttpError(400, `${paymentMethod.name} requires a reference`);
      }
      let customerName: string | null = null;
      if (parsed.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: parsed.customerId } });
        if (!customer) throw new NotFoundError("Selected customer was not found");
        customerName = customer.name;
      }
      let riderName: string | null = null;
      if (parsed.delivery?.riderId) {
        const rider = await tx.rider.findUnique({ where: { id: parsed.delivery.riderId } });
        if (!rider || rider.status !== "active") throw new NotFoundError("Selected rider was not found");
        riderName = rider.name;
      }

      // Batch-validate every distinct local supplier referenced across the cart in one query,
      // same reasoning as the productById/movementSums batching below — a cart line-by-line
      // findUnique here would be one round trip per locally-sourced line instead of one total.
      const localSupplierIds = [
        ...new Set(parsed.items.filter((i) => i.isLocallySourced && i.localSupplierId).map((i) => i.localSupplierId as string)),
      ];
      const validSupplierIds = new Set(
        localSupplierIds.length > 0
          ? (await tx.supplier.findMany({ where: { id: { in: localSupplierIds }, tenantId }, select: { id: true } })).map((s) => s.id)
          : [],
      );
      for (const id of localSupplierIds) {
        if (!validSupplierIds.has(id)) throw new NotFoundError("Selected local supplier was not found");
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

        // A cashier-entered override replaces the derived price outright for this line only — it's
        // never written back to the product's own sellingPriceCents. Mirrors DESKTOP's own
        // sale-service.ts prepareCart exactly, including the two SEPARATE minimum-price checks below
        // (price-itself-below-floor vs discount-pushes-below-floor) — DESKTOP split these from one
        // combined check because a cashier typing a marked-up price straight below the floor, with
        // zero discount involved, used to see a confusing error blaming a discount that was never
        // applied.
        const unitPriceCents = item.unitPriceCents ?? product.sellingPriceCents;
        if (product.minimumPriceCents !== null && unitPriceCents < product.minimumPriceCents) {
          throw new HttpError(400, `Price for "${product.name}" can't be below its minimum price of ${(product.minimumPriceCents / 100).toFixed(2)}`);
        }
        const lineSubtotalCents = unitPriceCents * item.quantity;
        if (item.discountAmountCents > lineSubtotalCents) {
          throw new HttpError(400, `Discount for "${product.name}" can't exceed its subtotal`);
        }
        const minLineSubtotalCents = product.minimumPriceCents !== null ? product.minimumPriceCents * item.quantity : 0;
        if (lineSubtotalCents - item.discountAmountCents < minLineSubtotalCents) {
          throw new HttpError(400, `Discount for "${product.name}" would drop it below its minimum price`);
        }

        // A line bought from another shop on the spot (customer wanted something this shop doesn't
        // carry) was never pulled from this shop's own stock — skip the usual availability check and
        // deduction entirely, same as DESKTOP's own prepareCart/completeSale.
        if (product.trackStock && !item.isLocallySourced) {
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
          isLocallySourced: item.isLocallySourced,
          // The customer is still charged unitPriceCents like any other line — this is purely a cost
          // figure for Reports, never folded into any total, matching DESKTOP's own prepareCart.
          localCostCents: item.isLocallySourced ? (item.localCostCents ?? null) : null,
          localSupplierId: item.isLocallySourced ? (item.localSupplierId ?? null) : null,
          createdAt: now.toISOString(),
        });

        if (product.trackStock && !item.isLocallySourced) {
          stockMovementRows.push({ id: randomUUID(), productId: product.id, quantityChange: -item.quantity });
        }
      }

      // Sums each line's own grossCents rather than branching off one global toggle — a cart can mix
      // inclusive and exclusive products via their own per-product overrides, same reasoning as
      // DESKTOP's own sale-service.ts prepareCart. Delivery fee folds straight in (no service
      // charges on mobile yet), matching prepareCart's own extraFeesCents — a cashier who's asked
      // to collect a delivery fee must see and be validated against the SAME total that includes it.
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const grandTotalCents = preparedItems.reduce((sum, item) => sum + item.lineTotalCents, 0) + deliveryFeeCents;
      if (parsed.amountReceivedCents < grandTotalCents) {
        throw new HttpError(400, "Amount received is less than the total");
      }
      const changeGivenCents = parsed.amountReceivedCents - grandTotalCents;

      // Defensive re-lease — covers a 7-day JWT issued before this employee's very first
      // post-feature login (see mobile-auth-service.ts's ensureMobileDeviceSequence, the normal
      // leasing path). Vanishingly rare, cheap to guard here too rather than ever mint a number with
      // no tag.
      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);

      const receiptNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, RECEIPT_PREFIX, RECEIPT_DIGITS);

      // Embedded JSON snapshot, not a separate synced table — mirrors SERVER's own Sale.delivery
      // column doc comment exactly (the shape DESKTOP's push already flattens its local
      // delivery_notes row into). costCents is internal-only (never shown on the receipt) — see
      // createDeliveryCostExpenseIfNeeded below for the matching "Delivery Costs" expense DESKTOP
      // also auto-creates when costCents > 0.
      const deliveryJson = parsed.delivery
        ? {
            id: randomUUID(),
            deliveryNoteNumber: await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, DELIVERY_NOTE_PREFIX, DELIVERY_NOTE_DIGITS),
            riderId: parsed.delivery.riderId ?? null,
            recipientName: parsed.delivery.recipientName,
            country: parsed.delivery.country,
            town: parsed.delivery.town,
            physicalAddress: parsed.delivery.physicalAddress,
            notes: parsed.delivery.notes,
            feeCents: parsed.delivery.feeCents,
            costCents: parsed.delivery.costCents,
            isDelivered: false,
            deliveredAt: null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          }
        : null;

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
          notes: parsed.notes?.trim() || null,
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
          delivery: deliveryJson ?? Prisma.JsonNull,
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

      // Mirrors DESKTOP's own expense-service.ts createDeliveryCostExpenseIfNeeded verbatim: a
      // delivery's costCents (what THIS shop paid the rider/courier, distinct from feeCents — what
      // the CUSTOMER paid, already folded into grandTotalCents above) auto-creates a real Expense
      // record so it shows up in Reports/Transactions the same way a DESKTOP-originated delivery's
      // cost would. Guarded the same way DESKTOP is: needs a real cost AND a payment method to
      // record it against (mobile checkout always has one, so this only ever skips on a zero cost).
      if (parsed.delivery && parsed.delivery.costCents > 0) {
        let category = await tx.expenseCategory.findFirst({ where: { tenantId, name: DELIVERY_COST_CATEGORY_NAME } });
        if (!category) {
          category = await tx.expenseCategory.create({
            data: {
              id: `expense_category_${randomUUID()}`,
              tenantId,
              deviceId: OWNER_APP_DEVICE_ID,
              name: DELIVERY_COST_CATEGORY_NAME,
              description: null,
              status: "active",
              localCreatedAt: now,
              localUpdatedAt: now,
            },
          });
        }

        const expenseNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, EXPENSE_PREFIX, EXPENSE_DIGITS);
        const descriptionLines = [
          `Sale: ${receiptNumber}`,
          `Customer: ${customerName ?? "Walk-in Customer"}`,
          `Delivered To: ${parsed.delivery.recipientName}`,
        ];
        const addressParts = [parsed.delivery.physicalAddress, parsed.delivery.town, parsed.delivery.country].filter(Boolean);
        if (addressParts.length > 0) descriptionLines.push(`Address: ${addressParts.join(", ")}`);
        if (riderName) descriptionLines.push(`Rider: ${riderName}`);
        if (parsed.delivery.notes) descriptionLines.push(`Notes: ${parsed.delivery.notes}`);

        await tx.expense.create({
          data: {
            id: `expense_${randomUUID()}`,
            tenantId,
            deviceId: OWNER_APP_DEVICE_ID,
            kind: "general",
            expenseNumber,
            expenseDate: now.toISOString().slice(0, 10),
            categoryId: category.id,
            amountCents: parsed.delivery.costCents,
            paidBy: null,
            paymentMethodId: parsed.paymentMethodId,
            storefrontId: parsed.locationId,
            reference: null,
            description: descriptionLines.join("\n"),
            status: "active",
            isRecurring: false,
            recurrenceFrequency: null,
            nextDueDate: null,
            lastReminderSent: null,
            localCreatedAt: now,
            localUpdatedAt: now,
          },
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
