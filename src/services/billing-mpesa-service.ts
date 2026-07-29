import { NotFoundError, HttpError } from "../lib/http-error.js";
import {
  friendlyMessageFor,
  getAccessToken,
  initiateStkPush as callInitiateStkPush,
  mapResultCodeToStatus,
  queryStkStatus,
  type TillCredentials,
} from "../lib/mpesa-client.js";
import { computeAdvancePayment, nextPeriodAfter, parsePeriodKey, type BillingCycle } from "../lib/billing-periods.js";
import { prisma } from "../prisma.js";
import {
  billingMpesaAdminStatusSchema,
  billingMpesaAdminStkPushSchema,
  billingMpesaStatusSchema,
  billingMpesaStkPushSchema,
} from "../schemas/billing-mpesa.js";
import { reactivateIfPaymentOverdue } from "./license-service.js";
import { env } from "../env.js";

/** Same throttle constant/purpose as the sales mpesa-service.ts — a cashier/owner double-clicking
 * "Check Status Now" can't turn into hammering Safaricom's API. */
const STATUS_QUERY_MIN_INTERVAL_MS = 5_000;

/** The tenant's own Outlet's Till, not a per-storefront one — this is the tenant paying Blue Ledger
 * (via the marketing team/outlet that onboarded them), not a customer paying the tenant. */
async function requireOutletTillSettings(tenantId: string): Promise<TillCredentials> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { outletId: true } });
  if (!tenant) {
    throw new NotFoundError("Tenant not found");
  }
  const settings = await prisma.outletMpesaSettings.findUnique({ where: { outletId: tenant.outletId } });
  if (!settings) {
    throw new NotFoundError("M-Pesa billing isn't set up for this account yet — contact Blue Ledger support.");
  }
  return settings;
}

export type BillingStkPushResponse = {
  checkoutRequestId: string;
  merchantRequestId: string;
  amountCents: number;
  periods: string[];
};

/** The shared core, called by BOTH the license-key path (a tenant paying from DESKTOP, sometimes
 * pre-login) and the admin-dashboard path (a SUPER_ADMIN triggering a push on a client's behalf,
 * e.g. over a support call) — one implementation so the two can never diverge on how an amount or
 * period list gets computed. `periodCount` periods are computed starting from the subscription's
 * CURRENT nextDueDate and persisted on the transaction row now, at push time — the callback applies
 * exactly that stored list rather than recomputing against whatever nextDueDate happens to be by
 * the time it arrives (see BillingMpesaTransaction's own schema comment). */
async function initiateBillingStkPushForTenant(
  tenantId: string,
  phone: string,
  periodCount: number,
  deviceId: string | null,
): Promise<BillingStkPushResponse> {
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription || !subscription.nextDueDate) {
    throw new HttpError(400, "There is nothing currently due for this account.");
  }

  const advance = computeAdvancePayment(subscription.nextDueDate, subscription.billingCycle, periodCount);
  if (!advance) {
    throw new HttpError(400, "This subscription has no recurring payment to make.");
  }

  const perPeriodCents = subscription.billingCycle === "MONTHLY" ? subscription.priceCents : (subscription.maintenanceFeeCents ?? 0);
  const amountCents = perPeriodCents * periodCount;
  if (amountCents <= 0) {
    throw new HttpError(400, "Nothing is currently owed for this account.");
  }

  const credentials = await requireOutletTillSettings(tenantId);
  const accessToken = await getAccessToken(credentials);
  const callbackUrl = `${env.SERVER_PUBLIC_URL}/billing-mpesa/callback`;
  const amountKes = Math.round(amountCents / 100);

  const result = await callInitiateStkPush({ credentials, accessToken, phone, amountKes, callbackUrl });

  await prisma.billingMpesaTransaction.create({
    data: {
      tenantId,
      merchantRequestId: result.merchantRequestId,
      checkoutRequestId: result.checkoutRequestId,
      phone,
      amountCents,
      periods: advance.periods,
      status: "pending",
      initiatedByDeviceId: deviceId,
    },
  });

  return { ...result, amountCents, periods: advance.periods };
}

/** License-key-authenticated (like activation.ts) — this can legitimately be called before any
 * employee is logged in (Pay Now from the lockout screen itself), so it can't require a device
 * session the way the sales STK flow does. */
export async function initiateBillingStkPush(input: unknown): Promise<BillingStkPushResponse> {
  const parsed = billingMpesaStkPushSchema.parse(input);
  const license = await prisma.license.findUnique({ where: { licenseKey: parsed.licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  return initiateBillingStkPushForTenant(license.tenantId, parsed.phone, parsed.periodCount, parsed.deviceId ?? null);
}

/** Admin-dashboard equivalent — requireSuperAdmin at the route layer is what actually authorizes
 * this; the tenantId comes straight from the admin's already-open tenant page, not a license key. */
export async function initiateBillingStkPushAsAdmin(input: unknown): Promise<BillingStkPushResponse> {
  const parsed = billingMpesaAdminStkPushSchema.parse(input);
  return initiateBillingStkPushForTenant(parsed.tenantId, parsed.phone, parsed.periodCount, null);
}

/** The actual "mark it paid" side effect, applied exactly once per transaction regardless of
 * whether the callback or a manual check is what first observes success (see both call sites'
 * `wasAlreadySuccess` guard) — creates one SubscriptionPayment PAID row per covered period, rolls
 * Subscription.nextDueDate past the last of them, and reactivates the License if it had been
 * auto-suspended for being overdue. This is the "pay and get back in immediately" mechanism the
 * product spec asked for. */
async function applySuccessfulBillingPayment(transaction: {
  tenantId: string;
  periods: string[];
  amountCents: number;
  mpesaReceiptNumber: string | null;
}): Promise<void> {
  const [subscription, tenant] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId: transaction.tenantId } }),
    prisma.tenant.findUnique({ where: { id: transaction.tenantId }, select: { currency: true } }),
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
        paymentMethod: "M-Pesa",
        transactionReference: transaction.mpesaReceiptNumber,
        billingPeriod: period,
        paymentDate,
        status: "PAID",
      },
    });
  }

  const lastPeriodDate = parsePeriodKey(transaction.periods[transaction.periods.length - 1]!, subscription.billingCycle as BillingCycle);
  const newNextDueDate = nextPeriodAfter(lastPeriodDate, subscription.billingCycle as BillingCycle);

  await prisma.subscription.update({
    where: { tenantId: transaction.tenantId },
    data: { status: "ACTIVE", nextDueDate: newNextDueDate },
  });

  await reactivateIfPaymentOverdue(transaction.tenantId);
}

type SafaricomCallbackItem = { Name: string; Value?: string | number };
type SafaricomCallbackBody = {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: SafaricomCallbackItem[] };
    };
  };
};

/** Public endpoint — same "tenant-blind first lookup" shape as the sales mpesa-service.ts's own
 * callback (see BillingMpesaTransaction's schema comment on why this table has no RLS). */
export async function handleBillingMpesaCallback(body: unknown): Promise<void> {
  const callback = (body as SafaricomCallbackBody)?.Body?.stkCallback;
  if (!callback?.CheckoutRequestID || typeof callback.ResultCode !== "number") {
    return;
  }

  const existing = await prisma.billingMpesaTransaction.findUnique({ where: { checkoutRequestId: callback.CheckoutRequestID } });
  if (!existing) return;

  const wasAlreadySuccess = existing.status === "success";
  const status = mapResultCodeToStatus(callback.ResultCode);
  const metadata = callback.CallbackMetadata?.Item ?? [];
  const findMeta = (name: string) => metadata.find((item) => item.Name === name)?.Value;
  const mpesaReceiptNumber =
    status === "success" ? String(findMeta("MpesaReceiptNumber") ?? "") || null : existing.mpesaReceiptNumber;

  await prisma.billingMpesaTransaction.update({
    where: { id: existing.id },
    data: {
      status,
      resultCode: callback.ResultCode,
      resultDescription: callback.ResultDesc ?? null,
      mpesaReceiptNumber,
      transactionDate:
        status === "success" ? String(findMeta("TransactionDate") ?? "") || null : existing.transactionDate,
    },
  });

  if (status === "success" && !wasAlreadySuccess) {
    await applySuccessfulBillingPayment({ ...existing, mpesaReceiptNumber });
  }
}

export type BillingMpesaStatusResponse = {
  status: string;
  message: string;
  mpesaReceiptNumber: string | null;
  amountCents: number;
  phone: string;
};

type BillingTransactionRow = Awaited<ReturnType<typeof prisma.billingMpesaTransaction.findUniqueOrThrow>>;

function toStatusResponse(row: BillingTransactionRow): BillingMpesaStatusResponse {
  return {
    status: row.status,
    message: friendlyMessageFor(row.status),
    mpesaReceiptNumber: row.mpesaReceiptNumber,
    amountCents: row.amountCents,
    phone: row.phone,
  };
}

async function findBillingTransactionForTenant(tenantId: string, checkoutRequestId: string): Promise<BillingTransactionRow> {
  const existing = await prisma.billingMpesaTransaction.findUnique({ where: { checkoutRequestId } });
  if (!existing || existing.tenantId !== tenantId) {
    throw new NotFoundError("No payment found for this request");
  }
  return existing;
}

async function findBillingTransactionOrThrow(licenseKey: string, checkoutRequestId: string): Promise<BillingTransactionRow> {
  const license = await prisma.license.findUnique({ where: { licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  return findBillingTransactionForTenant(license.tenantId, checkoutRequestId);
}

/** Passive — polled automatically while showing "waiting for you to enter your M-Pesa PIN." Reads
 * ONLY this transaction's own current status, as already written by the callback. NEVER calls
 * Safaricom itself — same discipline as the sales flow's own getMpesaStatus, for the same reason. */
export async function getBillingMpesaStatus(input: unknown): Promise<BillingMpesaStatusResponse> {
  const parsed = billingMpesaStatusSchema.parse(input);
  const existing = await findBillingTransactionOrThrow(parsed.licenseKey, parsed.checkoutRequestId);
  return toStatusResponse(existing);
}

/** Admin-dashboard equivalent of getBillingMpesaStatus — same passive read, tenant-scoped by id
 * instead of a license key. */
export async function getBillingMpesaStatusAsAdmin(input: unknown): Promise<BillingMpesaStatusResponse> {
  const parsed = billingMpesaAdminStatusSchema.parse(input);
  const existing = await findBillingTransactionForTenant(parsed.tenantId, parsed.checkoutRequestId);
  return toStatusResponse(existing);
}

/** The MANUAL "Check Status Now" action — only ever called from an explicit user click. Actively
 * asks Safaricom via the STK Query endpoint, throttled by lastQueriedAt. */
export async function checkBillingMpesaStatusManually(input: unknown): Promise<BillingMpesaStatusResponse> {
  const parsed = billingMpesaStatusSchema.parse(input);
  const existing = await findBillingTransactionOrThrow(parsed.licenseKey, parsed.checkoutRequestId);
  return checkBillingMpesaStatusCore(existing);
}

/** Admin-dashboard equivalent of checkBillingMpesaStatusManually. */
export async function checkBillingMpesaStatusManuallyAsAdmin(input: unknown): Promise<BillingMpesaStatusResponse> {
  const parsed = billingMpesaAdminStatusSchema.parse(input);
  const existing = await findBillingTransactionForTenant(parsed.tenantId, parsed.checkoutRequestId);
  return checkBillingMpesaStatusCore(existing);
}

async function checkBillingMpesaStatusCore(existing: BillingTransactionRow): Promise<BillingMpesaStatusResponse> {
  if (existing.status !== "pending") {
    return toStatusResponse(existing);
  }

  const sinceLastQueryMs = existing.lastQueriedAt ? Date.now() - existing.lastQueriedAt.getTime() : Infinity;
  if (sinceLastQueryMs < STATUS_QUERY_MIN_INTERVAL_MS) {
    return toStatusResponse(existing);
  }

  const credentials = await requireOutletTillSettings(existing.tenantId);
  let queryResult: { resultCode: number; resultDescription: string };
  try {
    const accessToken = await getAccessToken(credentials);
    queryResult = await queryStkStatus({ credentials, accessToken, checkoutRequestId: existing.checkoutRequestId });
  } catch (err) {
    console.error("[billing-mpesa] status query failed, treating as still pending:", err instanceof Error ? err.message : err);
    const updated = await prisma.billingMpesaTransaction.update({
      where: { id: existing.id },
      data: { lastQueriedAt: new Date() },
    });
    return toStatusResponse(updated);
  }

  // No wasAlreadySuccess guard needed here (unlike the callback handler below) — the early return
  // at the top of this function already guarantees existing.status is still "pending" at this
  // point, so this branch can never have already applied the payment.
  const status = mapResultCodeToStatus(queryResult.resultCode);
  const updated = await prisma.billingMpesaTransaction.update({
    where: { id: existing.id },
    data: { status, resultCode: queryResult.resultCode, resultDescription: queryResult.resultDescription, lastQueriedAt: new Date() },
  });

  if (status === "success") {
    await applySuccessfulBillingPayment(updated);
  }

  return {
    status,
    message: friendlyMessageFor(status),
    mpesaReceiptNumber: updated.mpesaReceiptNumber,
    amountCents: updated.amountCents,
    phone: updated.phone,
  };
}
