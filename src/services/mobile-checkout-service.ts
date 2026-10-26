import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { buildServiceCharges, prepareMobileCart, sumServiceChargeFees } from "../lib/mobile-cart.js";
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

/** `code` lets Checkout recognise M-Pesa ("MPESA", DESKTOP's own seeded code) to offer an STK push. */
export type MobilePaymentMethodOption = { id: string; name: string; code: string; requiresReference: boolean };

/** One entry of Sale.payments — the same shape DESKTOP's own SalePayment uses. */
type SalePayment = {
  id: string;
  paymentMethodId: string;
  paymentMethodName: string;
  amountCents: number;
  reference: string | null;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  notes: string | null;
};

/**
 * Ported from DESKTOP's own sale-service.ts buildSplitPayments, rule for rule: every method must exist,
 * be active and carry a reference if it needs one; together they must cover the grand total; anything
 * tendered above the total is change, which can only come back out of a payment whose method needs no
 * reference (cash) — so the stored amounts always add up to EXACTLY the total, which is what revenue
 * reports, receipts and the Transactions tab read. Largest payment first (it becomes the sale's
 * primary paymentMethodId for anything still reading that column).
 */
async function buildSplitPayments(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employee: { id: string; firstName: string; lastName: string },
  requested: Array<{ paymentMethodId: string; amountCents: number; reference?: string }>,
  grandTotalCents: number,
  now: Date,
): Promise<{ payments: SalePayment[]; tenderedCents: number }> {
  const methods = await tx.paymentMethod.findMany({ where: { tenantId, id: { in: requested.map((r) => r.paymentMethodId) } } });
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const rows = requested.map((entry) => {
    const method = methodById.get(entry.paymentMethodId);
    if (!method) throw new NotFoundError("Payment method not found");
    if (!method.isActive) throw new HttpError(400, `"${method.name}" is not active`);
    const reference = entry.reference?.trim() || null;
    if (method.requiresReference && !reference) throw new HttpError(400, `${method.name} requires a reference number`);
    return { method, amountCents: entry.amountCents, reference };
  });

  const tenderedCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
  if (tenderedCents < grandTotalCents) {
    throw new HttpError(400, `Payments add up to ${(tenderedCents / 100).toFixed(2)} but the total is ${(grandTotalCents / 100).toFixed(2)}`);
  }
  const changeCents = tenderedCents - grandTotalCents;
  if (changeCents > 0) {
    const cashLike = rows.filter((row) => !row.method.requiresReference).sort((a, b) => b.amountCents - a.amountCents)[0];
    if (!cashLike || cashLike.amountCents < changeCents) {
      throw new HttpError(400, "Payments add up to more than the total, and the extra can only be given back as change from a cash-type payment");
    }
    cashLike.amountCents -= changeCents;
  }

  const receivedByName = `${employee.firstName} ${employee.lastName}`.trim();
  const payments = rows
    .filter((row) => row.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents)
    .map((row) => ({
      id: `payment_${randomUUID()}`,
      paymentMethodId: row.method.id,
      paymentMethodName: row.method.name,
      amountCents: row.amountCents,
      reference: row.reference,
      receivedBy: employee.id,
      receivedByName,
      receivedAt: now.toISOString(),
      notes: null,
    }));
  return { payments, tenderedCents };
}

/** Backs the Checkout tab's payment method picker — same active/non-system-agnostic list DESKTOP's
 * own Checkout screen shows (no server-side filtering beyond isActive; a tenant's own payment method
 * list is small and not sensitive). */
export async function listPaymentMethods(tenantId: string): Promise<MobilePaymentMethodOption[]> {
  return withTenantContext(tenantId, async (tx) => {
    const methods = await tx.paymentMethod.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, code: true, requiresReference: true },
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
      const isSplit = (parsed.payments?.length ?? 0) > 1;

      // A split payment validates each of its own methods in buildSplitPayments below instead.
      if (!isSplit) {
        if (!paymentMethod || !paymentMethod.isActive) {
          throw new HttpError(400, "Selected payment method is unavailable");
        }
        if (paymentMethod.requiresReference && !parsed.paymentReference?.trim()) {
          throw new HttpError(400, `${paymentMethod.name} requires a reference`);
        }
      }
      let customerName: string | null = null;
      if (parsed.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: parsed.customerId } });
        if (!customer) throw new NotFoundError("Selected customer was not found");
        customerName = customer.name;
      }

      const tenantTaxConfig: TenantTaxConfig = { vatRatePercent: tenant.vatRatePercent, pricesTaxInclusive: tenant.pricesTaxInclusive };
      const cart = await prepareMobileCart(tx, tenantId, locationId, parsed.items, tenantTaxConfig, { checkStock: true });

      // Delivery fee + service charge fees fold straight in, matching DESKTOP's own prepareCart
      // extraFeesCents — a cashier who's asked to collect either must see and be validated against
      // the SAME total that includes them.
      const deliveryFeeCents = parsed.delivery?.feeCents ?? 0;
      const serviceChargeFeeCents = sumServiceChargeFees(parsed.serviceCharges);
      const grandTotalCents = cart.grandTotalCents + deliveryFeeCents + serviceChargeFeeCents;
      const now = new Date();

      // Split: the payments list decides the primary method, what was tendered and the change.
      const split = isSplit ? await buildSplitPayments(tx, tenantId, employee, parsed.payments!, grandTotalCents, now) : null;
      const primaryMethodId = split ? split.payments[0]!.paymentMethodId : parsed.paymentMethodId;
      const primaryReference = split ? split.payments[0]!.reference : (parsed.paymentReference ?? null);
      const amountReceivedCents = split ? split.tenderedCents : parsed.amountReceivedCents;
      if (amountReceivedCents < grandTotalCents) {
        throw new HttpError(400, "Amount received is less than the total");
      }
      const changeGivenCents = amountReceivedCents - grandTotalCents;

      // Defensive re-lease — covers a 7-day JWT issued before this employee's very first
      // post-feature login (see mobile-auth-service.ts's ensureMobileDeviceSequence, the normal
      // leasing path). Vanishingly rare, cheap to guard here too rather than ever mint a number with
      // no tag.
      const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);

      const receiptNumber = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, RECEIPT_PREFIX, RECEIPT_DIGITS);
      const { json: deliveryJson, riderName } = await buildDeliveryJson(tx, tenantId, mobileDeviceSequence, parsed.delivery, now);
      const preparedServiceCharges = buildServiceCharges(parsed.serviceCharges, now);

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
          paymentMethodId: primaryMethodId,
          paymentReference: primaryReference,
          amountReceivedCents,
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
          includeTaxBreakdown: parsed.includeTaxBreakdown,
          includeBusinessInfo: parsed.includeBusinessInfo,
          payments: (split?.payments ?? []) as unknown as Prisma.InputJsonValue,
          items: cart.items,
          serviceCharges: preparedServiceCharges,
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
          paymentMethodId: primaryMethodId,
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
