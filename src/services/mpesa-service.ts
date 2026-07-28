import { withTenantContext } from "../lib/tenant-context.js";
import { NotFoundError } from "../lib/http-error.js";
import {
  friendlyMessageFor,
  getAccessToken,
  initiateStkPush as callInitiateStkPush,
  mapResultCodeToStatus,
  queryStkStatus,
  type TillCredentials,
} from "../lib/mpesa-client.js";
import { prisma } from "../prisma.js";
import {
  mpesaConfiguredSchema,
  mpesaSettingsGetSchema,
  mpesaSettingsSaveSchema,
  mpesaStatusSchema,
  mpesaStkPushSchema,
} from "../schemas/mpesa.js";
import { env } from "../env.js";

/** Never re-query Safaricom (via the MANUAL "Check Status Now" action) more often than this — a
 * cashier double-clicking the button can't turn into hammering Safaricom's API. The passive
 * auto-poll never consults this at all — it only ever reads the row's own current status. */
const STATUS_QUERY_MIN_INTERVAL_MS = 5_000;

async function requireTillSettings(tenantId: string, locationId: string): Promise<TillCredentials> {
  const row = await withTenantContext(tenantId, (tx) => tx.mpesaTillSettings.findUnique({ where: { locationId } }));
  if (!row || row.tenantId !== tenantId) {
    throw new NotFoundError("M-Pesa Till is not configured for this storefront");
  }
  return row;
}

/** Full settings INCLUDING the secret — only ever called from DESKTOP's Storefronts admin screen,
 * fetched fresh each time it's opened, never cached/persisted locally (see the Prisma model's own
 * comment on why). */
export async function getMpesaSettings(input: unknown) {
  const parsed = mpesaSettingsGetSchema.parse(input);
  const row = await withTenantContext(parsed.tenantId, (tx) => tx.mpesaTillSettings.findUnique({ where: { locationId: parsed.locationId } }));
  if (!row || row.tenantId !== parsed.tenantId) return null;
  return {
    environment: row.environment,
    consumerKey: row.consumerKey,
    consumerSecret: row.consumerSecret,
    passkey: row.passkey,
    shortcode: row.shortcode,
    tillNumber: row.tillNumber,
    accountReference: row.accountReference,
  };
}

export async function saveMpesaSettings(input: unknown): Promise<{ ok: true }> {
  const parsed = mpesaSettingsSaveSchema.parse(input);
  await withTenantContext(parsed.tenantId, (tx) =>
    tx.mpesaTillSettings.upsert({
      where: { locationId: parsed.locationId },
      create: {
        tenantId: parsed.tenantId,
        locationId: parsed.locationId,
        environment: parsed.environment,
        consumerKey: parsed.consumerKey,
        consumerSecret: parsed.consumerSecret,
        passkey: parsed.passkey,
        shortcode: parsed.shortcode,
        tillNumber: parsed.tillNumber,
        accountReference: parsed.accountReference,
      },
      update: {
        environment: parsed.environment,
        consumerKey: parsed.consumerKey,
        consumerSecret: parsed.consumerSecret,
        passkey: parsed.passkey,
        shortcode: parsed.shortcode,
        tillNumber: parsed.tillNumber,
        accountReference: parsed.accountReference,
      },
    }),
  );
  return { ok: true };
}

/** Cheap, secret-free check — safe to call from Checkout on every storefront/payment-method
 * change to decide whether to show the "Send STK Push" flow at all. */
export async function isMpesaConfigured(input: unknown): Promise<{ configured: boolean }> {
  const parsed = mpesaConfiguredSchema.parse(input);
  const row = await withTenantContext(parsed.tenantId, (tx) =>
    tx.mpesaTillSettings.findUnique({ where: { locationId: parsed.locationId }, select: { id: true } }),
  );
  return { configured: Boolean(row) };
}

export type StkPushResponse = { checkoutRequestId: string; merchantRequestId: string };

export async function requestStkPush(input: unknown): Promise<StkPushResponse> {
  const parsed = mpesaStkPushSchema.parse(input);
  const credentials = await requireTillSettings(parsed.tenantId, parsed.locationId);

  const accessToken = await getAccessToken(credentials);
  const callbackUrl = `${env.SERVER_PUBLIC_URL}/mpesa/callback`;
  const amountKes = Math.round(parsed.amountCents / 100);

  const result = await callInitiateStkPush({
    credentials,
    accessToken,
    phone: parsed.phone,
    amountKes,
    callbackUrl,
  });

  await withTenantContext(parsed.tenantId, (tx) =>
    tx.mpesaTransaction.create({
      data: {
        tenantId: parsed.tenantId,
        locationId: parsed.locationId,
        merchantRequestId: result.merchantRequestId,
        checkoutRequestId: result.checkoutRequestId,
        phone: parsed.phone,
        amountCents: parsed.amountCents,
        accountReference: credentials.accountReference || null,
        status: "pending",
        initiatedByEmployeeId: parsed.employeeId ?? null,
        initiatedByDeviceId: parsed.deviceId,
      },
    }),
  );

  return result;
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

/** Public endpoint — Safaricom's own servers call this, no device auth possible. Validated only by
 * requiring the CheckoutRequestID to match a real row already created by requestStkPush (a random/
 * spoofed id simply won't match anything and is silently ignored). */
export async function handleMpesaCallback(body: unknown): Promise<void> {
  const callback = (body as SafaricomCallbackBody)?.Body?.stkCallback;
  if (!callback?.CheckoutRequestID || typeof callback.ResultCode !== "number") {
    return;
  }

  const existing = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: callback.CheckoutRequestID } });
  if (!existing) return; // unknown/foreign checkoutRequestId — nothing to update.

  const status = mapResultCodeToStatus(callback.ResultCode);
  const metadata = callback.CallbackMetadata?.Item ?? [];
  const findMeta = (name: string) => metadata.find((item) => item.Name === name)?.Value;

  await withTenantContext(existing.tenantId, (tx) =>
    tx.mpesaTransaction.update({
      where: { id: existing.id },
      data: {
        status,
        resultCode: callback.ResultCode,
        resultDescription: callback.ResultDesc ?? null,
        mpesaReceiptNumber: status === "success" ? String(findMeta("MpesaReceiptNumber") ?? "") || null : existing.mpesaReceiptNumber,
        transactionDate: status === "success" ? String(findMeta("TransactionDate") ?? "") || null : existing.transactionDate,
      },
    }),
  );
}

export type MpesaStatusResponse = {
  status: string;
  message: string;
  mpesaReceiptNumber: string | null;
  amountCents: number;
  phone: string;
};

type MpesaTransactionRow = Awaited<ReturnType<typeof prisma.mpesaTransaction.findUniqueOrThrow>>;

function toStatusResponse(row: MpesaTransactionRow): MpesaStatusResponse {
  return {
    status: row.status,
    // Always the clean, standardized label — never Safaricom's own raw ResultDesc text (that's
    // stored in resultDescription for audit purposes only, never surfaced to the cashier, since its
    // wording is inconsistent and sometimes quite technical).
    message: friendlyMessageFor(row.status),
    mpesaReceiptNumber: row.mpesaReceiptNumber,
    amountCents: row.amountCents,
    phone: row.phone,
  };
}

/** Bare `prisma` is deliberate — see MpesaTransaction's own schema comment. This table carries no
 * tenant context of its own to consult yet (that's the whole reason a tenant-blind lookup by the
 * opaque checkoutRequestId is needed in the first place), so isolation is this explicit tenantId
 * match instead, same shape as ShareLink's own resolution. */
async function findTransactionOrThrow(tenantId: string, checkoutRequestId: string): Promise<MpesaTransactionRow> {
  const existing = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId } });
  if (!existing || existing.tenantId !== tenantId) {
    throw new NotFoundError("No M-Pesa transaction found for this request");
  }
  return existing;
}

/** Passive read, polled by DESKTOP every few seconds while showing "waiting for customer to enter
 * PIN." Reads ONLY this row's own current status, as already written by handleMpesaCallback —
 * NEVER calls Safaricom itself. Cheap enough to poll indefinitely; the cashier's own explicit
 * "Check Status Now" action (checkMpesaStatusManually below) is the ONLY path that ever actively
 * queries Safaricom. Keeping these separate is deliberate product behavior, not an optimization —
 * the callback is the source of truth; actively querying is a fallback for when it's slow to arrive,
 * not something to do automatically on every poll. */
export async function getMpesaStatus(input: unknown): Promise<MpesaStatusResponse> {
  const parsed = mpesaStatusSchema.parse(input);
  const existing = await findTransactionOrThrow(parsed.tenantId, parsed.checkoutRequestId);
  return toStatusResponse(existing);
}

/** The MANUAL "Check Status Now" action — only ever called from an explicit cashier click (see the
 * route layer), for the "STK is taking a while" recovery case. Actively asks Safaricom what actually
 * happened via the STK Query endpoint, using Till credentials looked up server-side from this row's
 * own stored locationId (never passed in from DESKTOP — the frontend only ever sends the
 * checkoutRequestId + its own device identity). Throttled by lastQueriedAt so a double-click can't
 * turn into hammering Safaricom's API — a throttled call just returns the current DB state instead
 * of erroring. */
export async function checkMpesaStatusManually(input: unknown): Promise<MpesaStatusResponse> {
  const parsed = mpesaStatusSchema.parse(input);
  const existing = await findTransactionOrThrow(parsed.tenantId, parsed.checkoutRequestId);

  if (existing.status !== "pending") {
    return toStatusResponse(existing);
  }

  const sinceLastQueryMs = existing.lastQueriedAt ? Date.now() - existing.lastQueriedAt.getTime() : Infinity;
  if (sinceLastQueryMs < STATUS_QUERY_MIN_INTERVAL_MS) {
    return toStatusResponse(existing);
  }

  const credentials = await requireTillSettings(existing.tenantId, existing.locationId);
  let queryResult: { resultCode: number; resultDescription: string };
  try {
    const accessToken = await getAccessToken(credentials);
    queryResult = await queryStkStatus({ credentials, accessToken, checkoutRequestId: existing.checkoutRequestId });
  } catch (err) {
    // A query failure (including Safaricom's own "request is still being processed" error) just
    // means "still pending" — never surface a transport hiccup as a payment failure.
    console.error("[mpesa] status query failed, treating as still pending:", err instanceof Error ? err.message : err);
    const updated = await withTenantContext(existing.tenantId, (tx) =>
      tx.mpesaTransaction.update({ where: { id: existing.id }, data: { lastQueriedAt: new Date() } }),
    );
    return toStatusResponse(updated);
  }

  const status = mapResultCodeToStatus(queryResult.resultCode);
  const updated = await withTenantContext(existing.tenantId, (tx) =>
    tx.mpesaTransaction.update({
      where: { id: existing.id },
      data: { status, resultCode: queryResult.resultCode, resultDescription: queryResult.resultDescription, lastQueriedAt: new Date() },
    }),
  );

  return {
    status,
    // Clean standardized label, not Safaricom's raw queryResult.resultDescription — same reasoning
    // as toStatusResponse above. The query endpoint alone never returns the receipt number (only the
    // callback's metadata does) — if the callback genuinely never arrives, this can legitimately be
    // "success" with no receipt number yet; the cashier proceeds, entering the reference manually.
    message: friendlyMessageFor(status),
    mpesaReceiptNumber: updated.mpesaReceiptNumber,
    amountCents: updated.amountCents,
    phone: updated.phone,
  };
}
