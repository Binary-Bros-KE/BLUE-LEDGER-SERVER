import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { prepareMobileCart } from "../lib/mobile-cart.js";
import { buildDeliveryJson, createDeliveryCostExpenseIfNeeded } from "../lib/mobile-delivery.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import type { TenantTaxConfig } from "../lib/tax-breakdown.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCheckoutInput, mobileCheckoutSchema } from "../schemas/mobile.js";
import { isStorefrontLocationType } from "./mobile-sales-service.js";

/** Matches DESKTOP's own sale-service.ts prefix exactly ("BL", 7 digits) — the tag is what tells a
 * mobile-minted number apart from a desktop one ("BL-M3-0000012" vs "BL-D1-0000058"), not the
 * prefix itself. */
const RECEIPT_PREFIX = "BL";
const RECEIPT_DIGITS = 7;

/** Same synthetic deviceId already used for Owner-App-originated writes elsewhere (see
 * routes/mobile.ts's share-link creation) — every synced row needs SOME deviceId, and a mobile
 * session was never issued a real one (see mobile-auth.ts's MobileSession doc comment). */
export const OWNER_APP_DEVICE_ID = "owner-app";

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

/** Mirrors DESKTOP's own sale-service.ts requireActiveSession exactly: a branch-scoped employee's
 * own branch is ALWAYS authoritative — `requestedLocationId` is never even looked at in that case
 * (matching DESKTOP's own doc comment verbatim: "explicitLocationId is never even looked at"), not
 * validated-and-rejected. A branch-less employee (Super Admin, typically) has no such default, so
 * APP shows a StorefrontPicker and whatever they pick is validated as a real, active, genuine
 * storefront (never the Main Store/warehouse, which nothing is ever directly sold from). Shared by
 * checkout, invoice create, and quotation create — the identical rule DESKTOP applies to all three
 * via the same function. */
export async function resolveMobileLocation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeBranchId: string | null,
  requestedLocationId: string | undefined,
): Promise<string> {
  if (employeeBranchId) return employeeBranchId;

  if (!requestedLocationId) {
    throw new HttpError(400, "Choose a storefront first — your account has no branch assigned.");
  }
  const location = await tx.location.findUnique({ where: { id: requestedLocationId } });
  if (!location || location.tenantId !== tenantId) throw new NotFoundError("Selected storefront was not found");
  if (!isStorefrontLocationType(location.locationType)) {
    throw new HttpError(400, `"${location.locationName}" isn't a storefront`);
  }
  if (location.status !== "active") {
    throw new HttpError(400, `"${location.locationName}" is not active`);
  }
  return location.id;
}

/**
 * Real, from-scratch checkout — deliberately NOT the generic /sync/push pipeline (see
 * sync-service.ts's own pushRows, which blindly upserts whatever JSON a client already computed,
 * with zero stock deduction or price/tax revalidation; sales isn't even in its ref-field validation
 * list). Every figure here is recomputed server-side from trusted Product/Tenant rows via
 * prepareMobileCart — the client's own line items are just a proposal, never trusted for pricing.
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

      const [tenant, employee, paymentMethod] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true, pricesTaxInclusive: true } }),
        tx.employee.findUniqueOrThrow({ where: { id: employeeId } }),
        tx.paymentMethod.findUnique({ where: { id: parsed.paymentMethodId } }),
      ]);

      const locationId = await resolveMobileLocation(tx, tenantId, employee.branchId, parsed.locationId);

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

      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const cart = await prepareMobileCart(tx, tenantId, locationId, parsed.items, tenantTaxConfig, { checkStock: true });

      // Delivery fee folds straight in (no service charges on mobile yet), matching DESKTOP's own
      // prepareCart extraFeesCents — a cashier who's asked to collect a delivery fee must see and be
      // validated against the SAME total that includes it.
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents;
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
      const now = new Date();
      const { json: deliveryJson, riderName } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);

      await tx.sale.create({
        data: {
          id: parsed.id,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          receiptNumber,
          locationId,
          employeeId,
          customerId: parsed.customerId ?? null,
          saleStatus: "completed",
          subtotalCents: cart.subtotalCents,
          discountAmountCents: cart.discountAmountCents,
          taxAmountCents: cart.taxAmountCents,
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
          items: cart.items,
          serviceCharges: [],
          delivery: deliveryJson ?? Prisma.JsonNull,
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
            referenceId: parsed.id,
            performedBy: employeeId,
            allocationExplicit: false,
            localCreatedAt: now,
            localUpdatedAt: now,
          })),
        });
      }

      if (parsed.delivery) {
        await createDeliveryCostExpenseIfNeeded(tx, tenantId, OWNER_APP_DEVICE_ID, mobileDeviceSequence, {
          documentNumber: receiptNumber,
          customerName,
          delivery: parsed.delivery,
          riderName,
          locationId,
          paymentMethodId: parsed.paymentMethodId,
          now,
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
