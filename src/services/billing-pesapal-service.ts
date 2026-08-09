import { NotFoundError, HttpError } from "../lib/http-error.js";
import {
  friendlyPesapalMessageFor,
  getTransactionStatus,
  mapPesapalStatus,
  submitOrder,
  type TransactionStatusResult,
} from "../lib/pesapal-client.js";
import {
  computeAdvancePayment,
  computeTrueNextDueDate,
  resolveBillingAnchorDate,
  nextPeriodAfter,
  type BillingCycle,
} from "../lib/billing-periods.js";
import { prisma } from "../prisma.js";
import {
  billingPesapalAdminStatusSchema,
  billingPesapalAdminSubmitOrderSchema,
  billingPesapalStatusSchema,
  billingPesapalSubmitOrderSchema,
} from "../schemas/billing-pesapal.js";
import { reactivateIfPaymentOverdue } from "./license-service.js";
import { env } from "../env.js";

const STATUS_QUERY_MIN_INTERVAL_MS = 5_000;

/** Pesapal requires this to be unique per merchant across ALL orders ever submitted — the tenant's
 * own id slice keeps it human-traceable in Pesapal's own dashboard without needing a lookup. */
function buildMerchantReference(tenantId: string): string {
  return `BLPOS-${tenantId.slice(-8)}-${Date.now()}`;
}

/** The recurring "account_number" a tenant enrolls under — set once, the first time "Setup Auto
 * Billing" is used, then reused for every subsequent enrollment attempt (Pesapal requires this
 * value be unique per merchant, so it can't be regenerated per order the way merchantReference is).
 * Two segments (tenantId + subscriptionId) purely so it visually matches Pesapal's own documented
 * "SUB-xxxxxx-xxxxxx" example — cosmetic, not parsed apart anywhere. */
function buildPesapalAccountNumber(tenantId: string, subscriptionId: string): string {
  return `SUB-${tenantId.slice(-6)}-${subscriptionId.slice(-6)}`;
}

export type BillingPesapalSubmitOrderResponse = {
  orderTrackingId: string;
  merchantReference: string;
  redirectUrl: string;
  amountCents: number;
  periods: string[];
  /** Only set when enrollAutoBilling was true — the account_number to show in the "Setup future
   * recurring payments for account ..." instructions, since it's this tenant's own generated value,
   * not the placeholder from the reference instructions. */
  accountNumber: string | null;
};

/** The shared core, called by BOTH the license-key path (a tenant paying from DESKTOP, sometimes
 * pre-login) and the admin-dashboard path — one implementation so the two can never diverge, exact
 * parallel to billing-mpesa-service.ts's initiateBillingStkPushForTenant.
 *
 * enrollAutoBilling forces periodCount to 1 — its entire purpose is enrolling the recurring checkbox
 * on Pesapal's hosted page, and per the product's own instructions the CURRENT period is deducted
 * immediately on submit while every period after that is Pesapal's own responsibility, so prepaying
 * multiple periods here would be meaningless (there's nothing left for the recurring schedule to
 * cover next). A plain "Pay Now" order, by contrast, never sets account_number/subscriptionDetails at
 * all — see pesapal-client.ts's SubmitOrderParams comment on why the two flows must stay genuinely
 * separate on Pesapal's own side, not just in the UI. */
async function initiateBillingPesapalOrderForTenant(
  tenantId: string,
  periodCountInput: number,
  enrollAutoBilling: boolean,
  deviceId: string | null,
): Promise<BillingPesapalSubmitOrderResponse> {
  const [subscription, tenant] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true, name: true, contactPhone: true, email: true, contactEmail: true } }),
  ]);
  if (!subscription || !subscription.nextDueDate || !tenant) {
    throw new HttpError(400, "There is nothing currently due for this account.");
  }

  const periodCount = enrollAutoBilling ? 1 : periodCountInput;
  const advance = computeAdvancePayment(subscription.nextDueDate, subscription.billingCycle, periodCount);
  if (!advance) {
    throw new HttpError(400, "This subscription has no recurring payment to make.");
  }

  const perPeriodCents = subscription.billingCycle === "MONTHLY" ? subscription.priceCents : (subscription.maintenanceFeeCents ?? 0);
  const amountCents = perPeriodCents * periodCount;
  if (amountCents <= 0) {
    throw new HttpError(400, "Nothing is currently owed for this account.");
  }

  const merchantReference = buildMerchantReference(tenantId);
  const callbackUrl = `${env.SERVER_PUBLIC_URL}/billing-pesapal/callback`;

  let accountNumber: string | undefined;
  let subscriptionDetails: { start_date: string; frequency: "MONTHLY" | "YEARLY" } | undefined;
  if (enrollAutoBilling) {
    accountNumber = subscription.pesapalAccountNumber ?? buildPesapalAccountNumber(tenantId, subscription.id);
    // First execution is the period AFTER the one being paid right now — this same submit already
    // covers the current period immediately, so the recurring schedule should only ever pick up from
    // there, never double-charge the period just paid.
    const firstRecurringDate = nextPeriodAfter(advance.newNextDueDate, subscription.billingCycle as BillingCycle);
    subscriptionDetails = {
      start_date: formatPesapalDate(firstRecurringDate),
      frequency: subscription.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY",
    };
  }

  const [firstName, ...rest] = tenant.name.split(" ");

  const order = await submitOrder({
    merchantReference,
    amountCents,
    currency: tenant.currency,
    description: enrollAutoBilling ? "Blue Ledger POS — subscription + auto-billing setup" : "Blue Ledger POS subscription payment",
    callbackUrl,
    accountNumber,
    subscriptionDetails,
    billingAddress: {
      email_address: tenant.email ?? tenant.contactEmail ?? undefined,
      phone_number: tenant.contactPhone ?? undefined,
      country_code: "KE",
      first_name: firstName || "Blue Ledger",
      last_name: rest.join(" ") || "Tenant",
    },
  });

  await prisma.$transaction([
    prisma.pesapalTransaction.create({
      data: {
        tenantId,
        orderTrackingId: order.order_tracking_id,
        merchantReference: order.merchant_reference,
        amountCents,
        periods: advance.periods,
        status: "pending",
        isRecurringSetup: enrollAutoBilling,
        initiatedByDeviceId: deviceId,
      },
    }),
    ...(enrollAutoBilling && accountNumber && subscription.pesapalAccountNumber !== accountNumber
      ? [prisma.subscription.update({ where: { tenantId }, data: { pesapalAccountNumber: accountNumber } })]
      : []),
  ]);

  return {
    orderTrackingId: order.order_tracking_id,
    merchantReference: order.merchant_reference,
    redirectUrl: order.redirect_url,
    amountCents,
    periods: advance.periods,
    accountNumber: accountNumber ?? null,
  };
}

function formatPesapalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export async function initiateBillingPesapalOrder(input: unknown): Promise<BillingPesapalSubmitOrderResponse> {
  const parsed = billingPesapalSubmitOrderSchema.parse(input);
  const license = await prisma.license.findUnique({ where: { licenseKey: parsed.licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  return initiateBillingPesapalOrderForTenant(license.tenantId, parsed.periodCount, parsed.enrollAutoBilling, parsed.deviceId ?? null);
}

export async function initiateBillingPesapalOrderAsAdmin(input: unknown): Promise<BillingPesapalSubmitOrderResponse> {
  const parsed = billingPesapalAdminSubmitOrderSchema.parse(input);
  return initiateBillingPesapalOrderForTenant(parsed.tenantId, parsed.periodCount, parsed.enrollAutoBilling, null);
}

/** The actual "mark it paid" side effect — exact parallel to billing-mpesa-service.ts's
 * applySuccessfulBillingPayment (see that function's own comment for why nextDueDate is a fresh
 * recompute, never an incremental advance). Additionally flips the auto-billing flags the FIRST time
 * Pesapal's own subscription_transaction_info shows up on a successful transaction — per the user's
 * own noted limitation, there's no way to know enrollment genuinely succeeded until this moment. */
async function applySuccessfulPesapalPayment(transaction: {
  tenantId: string;
  periods: string[];
  amountCents: number;
  confirmationCode: string | null;
  recurringInfo: { correlation_id?: string; status?: string } | null;
}): Promise<void> {
  const [subscription, tenant, license] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId: transaction.tenantId } }),
    prisma.tenant.findUnique({ where: { id: transaction.tenantId }, select: { currency: true } }),
    prisma.license.findUnique({ where: { tenantId: transaction.tenantId }, select: { trialEndsAt: true } }),
  ]);
  if (!subscription || !tenant || transaction.periods.length === 0) return;

  const perPeriodCents = Math.round(transaction.amountCents / transaction.periods.length);
  const paymentDate = new Date();

  for (const period of transaction.periods) {
    await prisma.subscriptionPayment.create({
      data: {
        tenantId: transaction.tenantId,
        amountCents: perPeriodCents,
        currency: tenant.currency,
        paymentMethod: "Pesapal",
        transactionReference: transaction.confirmationCode,
        billingPeriod: period,
        paymentDate,
        status: "PAID",
      },
    });
  }

  const allPaid = await prisma.subscriptionPayment.findMany({
    where: { tenantId: transaction.tenantId, status: "PAID" },
    select: { billingPeriod: true },
  });
  const paidPeriods = new Set(allPaid.map((p) => p.billingPeriod));
  const anchorDate = resolveBillingAnchorDate(subscription.startDate, license?.trialEndsAt ?? null);
  const newNextDueDate = computeTrueNextDueDate(anchorDate, subscription.billingCycle as BillingCycle, paidPeriods);

  await prisma.subscription.update({
    where: { tenantId: transaction.tenantId },
    data: {
      status: "ACTIVE",
      nextDueDate: newNextDueDate,
      ...(transaction.recurringInfo
        ? {
            pesapalAutoBillingEnabled: true,
            pesapalAutoBillingActivatedAt: subscription.pesapalAutoBillingActivatedAt ?? new Date(),
            pesapalRecurringStatus: transaction.recurringInfo.status ?? "active",
          }
        : {}),
    },
  });

  await reactivateIfPaymentOverdue(transaction.tenantId);
}

export type BillingPesapalStatusResponse = {
  status: string;
  message: string;
  confirmationCode: string | null;
  paymentMethodDetail: string | null;
  amountCents: number;
};

type PesapalTransactionRow = Awaited<ReturnType<typeof prisma.pesapalTransaction.findUniqueOrThrow>>;

function toStatusResponse(row: PesapalTransactionRow): BillingPesapalStatusResponse {
  return {
    status: row.status,
    message: friendlyPesapalMessageFor(row.status),
    confirmationCode: row.confirmationCode,
    paymentMethodDetail: row.paymentMethodDetail,
    amountCents: row.amountCents,
  };
}

async function findPesapalTransactionForTenant(tenantId: string, orderTrackingId: string): Promise<PesapalTransactionRow> {
  const existing = await prisma.pesapalTransaction.findUnique({ where: { orderTrackingId } });
  if (!existing || existing.tenantId !== tenantId) {
    throw new NotFoundError("No payment found for this request");
  }
  return existing;
}

async function findPesapalTransactionOrThrow(licenseKey: string, orderTrackingId: string): Promise<PesapalTransactionRow> {
  const license = await prisma.license.findUnique({ where: { licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  return findPesapalTransactionForTenant(license.tenantId, orderTrackingId);
}

/** Passive — polled automatically while DESKTOP shows "waiting for payment." Reads ONLY this
 * transaction's own current status as already written by the IPN handler. NEVER calls Pesapal itself
 * — same discipline as billing-mpesa-service.ts's getBillingMpesaStatus. */
export async function getPesapalStatus(input: unknown): Promise<BillingPesapalStatusResponse> {
  const parsed = billingPesapalStatusSchema.parse(input);
  const existing = await findPesapalTransactionOrThrow(parsed.licenseKey, parsed.orderTrackingId);
  return toStatusResponse(existing);
}

export async function getPesapalStatusAsAdmin(input: unknown): Promise<BillingPesapalStatusResponse> {
  const parsed = billingPesapalAdminStatusSchema.parse(input);
  const existing = await findPesapalTransactionForTenant(parsed.tenantId, parsed.orderTrackingId);
  return toStatusResponse(existing);
}

function extractRecurringInfo(txnStatus: TransactionStatusResult): { correlation_id?: string; status?: string } | null {
  const info = txnStatus.subscription_transaction_info;
  if (!info || (!info.correlation_id && !info.status)) return null;
  return { correlation_id: info.correlation_id, status: info.status };
}

/** Applies a fetched Pesapal transaction status to the local row + (if newly successful) the
 * subscription — shared by the IPN handler and the manual "Check Status Now" path, same
 * wasAlreadySuccess-guard shape as billing-mpesa-service.ts's checkBillingMpesaStatusCore/callback
 * pair, just unified into one function since both callers already have a fetched status in hand here
 * (Pesapal's IPN, unlike Safaricom's callback, carries no status inline — the caller must always
 * fetch it, so there's no separate "apply the inline payload" branch to keep in sync). */
async function applyFetchedStatus(existing: PesapalTransactionRow, txnStatus: TransactionStatusResult): Promise<PesapalTransactionRow> {
  const wasAlreadySuccess = existing.status === "success";
  const status = mapPesapalStatus(txnStatus.status_code);
  const recurringInfo = extractRecurringInfo(txnStatus);

  const updated = await prisma.pesapalTransaction.update({
    where: { id: existing.id },
    data: {
      status,
      paymentMethodDetail: txnStatus.payment_method ?? existing.paymentMethodDetail,
      confirmationCode: status === "success" ? (txnStatus.confirmation_code ?? existing.confirmationCode) : existing.confirmationCode,
      lastQueriedAt: new Date(),
    },
  });

  if (status === "success" && !wasAlreadySuccess) {
    await applySuccessfulPesapalPayment({ ...updated, recurringInfo });
  }

  return updated;
}

/** Public endpoint — Pesapal's own servers call this. Unlike Safaricom's STK callback, the IPN
 * carries NO payment result at all, only an OrderTrackingId/OrderMerchantReference — the handler
 * must always follow up with GetTransactionStatus (see pesapal-client.ts). Tenant-blind first lookup,
 * same reasoning as PesapalTransaction's own schema comment: tries orderTrackingId first (covers Pay
 * Now + the initial auto-billing charge, both of which created their own row at submit time); if
 * nothing matches, this is a Pesapal-INITIATED recurring auto-charge that has no pre-existing row —
 * resolved instead via the account_number stored on Subscription, and a new row is created here so
 * it still shows up in payment history/audit going forward. */
export async function handlePesapalIPN(orderTrackingId: string | undefined, orderMerchantReference: string | undefined): Promise<void> {
  if (!orderTrackingId) return;

  let existing = await prisma.pesapalTransaction.findUnique({ where: { orderTrackingId } });

  if (!existing) {
    if (!orderMerchantReference) return;
    const subscription = await prisma.subscription.findFirst({ where: { pesapalAccountNumber: orderMerchantReference } });
    if (!subscription || !subscription.nextDueDate) {
      console.error(`[pesapal-ipn] Unknown order ${orderTrackingId} — no PesapalTransaction and no Subscription for account_number ${orderMerchantReference}`);
      return;
    }
    const advance = computeAdvancePayment(subscription.nextDueDate, subscription.billingCycle, 1);
    if (!advance) return;
    const perPeriodCents = subscription.billingCycle === "MONTHLY" ? subscription.priceCents : (subscription.maintenanceFeeCents ?? 0);
    existing = await prisma.pesapalTransaction.create({
      data: {
        tenantId: subscription.tenantId,
        orderTrackingId,
        merchantReference: orderMerchantReference,
        amountCents: perPeriodCents,
        periods: advance.periods,
        status: "pending",
        isRecurringSetup: false,
      },
    });
  }

  const txnStatus = await getTransactionStatus(orderTrackingId);
  await applyFetchedStatus(existing, txnStatus);
}

/** The MANUAL "Check Status Now" action — only ever called from an explicit user click. */
export async function checkPesapalStatusManually(input: unknown): Promise<BillingPesapalStatusResponse> {
  const parsed = billingPesapalStatusSchema.parse(input);
  const existing = await findPesapalTransactionOrThrow(parsed.licenseKey, parsed.orderTrackingId);
  return checkPesapalStatusCore(existing);
}

export async function checkPesapalStatusManuallyAsAdmin(input: unknown): Promise<BillingPesapalStatusResponse> {
  const parsed = billingPesapalAdminStatusSchema.parse(input);
  const existing = await findPesapalTransactionForTenant(parsed.tenantId, parsed.orderTrackingId);
  return checkPesapalStatusCore(existing);
}

async function checkPesapalStatusCore(existing: PesapalTransactionRow): Promise<BillingPesapalStatusResponse> {
  if (existing.status !== "pending") {
    return toStatusResponse(existing);
  }

  const sinceLastQueryMs = existing.lastQueriedAt ? Date.now() - existing.lastQueriedAt.getTime() : Infinity;
  if (sinceLastQueryMs < STATUS_QUERY_MIN_INTERVAL_MS) {
    return toStatusResponse(existing);
  }

  let txnStatus: TransactionStatusResult;
  try {
    txnStatus = await getTransactionStatus(existing.orderTrackingId);
  } catch (err) {
    console.error("[billing-pesapal] status query failed, treating as still pending:", err instanceof Error ? err.message : err);
    const updated = await prisma.pesapalTransaction.update({ where: { id: existing.id }, data: { lastQueriedAt: new Date() } });
    return toStatusResponse(updated);
  }

  const updated = await applyFetchedStatus(existing, txnStatus);
  return toStatusResponse(updated);
}
