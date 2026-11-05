import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "../env.js";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { getAccessToken, registerC2bUrls } from "../lib/mpesa-client.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import {
  mpesaAttachClaimSchema,
  mpesaCheckPaymentSchema,
  mpesaSaveModeSchema,
  mpesaVerifyCodeSchema,
  mpesaVerifySaleCodeSchema,
} from "../schemas/mpesa.js";

/**
 * M-Pesa payment verification. mpesa_payments is the one list of real money received on a till: C2B
 * confirmations (Safaricom tells us about every payment) and successful STK pushes both land here,
 * one row per receipt per tenant. Verifying a code means finding it here and CLAIMING it for exactly
 * one sale, which is what stops a code being invented or reused.
 *
 * Per storefront, and only once till credentials are saved (the "available" check):
 *   off    — nothing shown, nothing recorded
 *   loose  — verification is offered, but a sale can complete without it (the default)
 *   strict — an M-Pesa code must verify before the sale can complete (enforced by the clients for
 *            DESKTOP's offline-first local sale, and on SERVER for mobile checkout)
 */

export type MpesaVerificationMode = "off" | "loose" | "strict";
export type MpesaActor = { tenantId: string; employeeId: string | null; deviceId: string };

/** How long a verified-but-not-yet-completed code stays reserved for the sale being rung up. */
const RESERVATION_MS = 15 * 60 * 1000;
/** Check Payment only offers payments this recent — an older one is almost never this customer's. */
const MATCH_WINDOW_MS = 60 * 60 * 1000;

export type MpesaPaymentMatch = {
  code: string;
  amountCents: number;
  payerName: string | null;
  maskedPhone: string | null;
  receivedAt: string;
};

/** Stored per code on the sale (Sale.mpesaVerifications), so every till can show the indicator offline. */
export type MpesaVerificationRecord = {
  status: "verified" | "unverified";
  verifiedAt: string | null;
  payerName: string | null;
  amountCents: number | null;
};

export type MpesaVerifyOutcome = "verified" | "not_found" | "already_used" | "amount_mismatch" | "wrong_storefront";

export type MpesaVerifyResult = {
  outcome: MpesaVerifyOutcome;
  code: string;
  message: string;
  record: MpesaVerificationRecord | null;
};

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** M-Pesa only moves whole shillings, so a 1,250.50 total is really compared as 1,251 — the same
 * rounding STK push already applies (mpesa-service.ts's requestStkPush). */
function wholeShillingCents(cents: number): number {
  return Math.round(cents / 100) * 100;
}

function joinName(parts: Array<string | null | undefined>): string | null {
  const name = parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

// ---- settings ---------------------------------------------------------------------------------

export type MpesaVerificationState = {
  /** The first check: false until this storefront has saved till credentials. */
  available: boolean;
  mode: MpesaVerificationMode;
  /** Safaricom has accepted our C2B notification URLs for this till. */
  connected: boolean;
  connectError: string | null;
};

export async function getVerificationState(tenantId: string, locationId: string): Promise<MpesaVerificationState> {
  const till = await withTenantContext(tenantId, (tx) =>
    tx.mpesaTillSettings.findUnique({ where: { locationId }, select: { tenantId: true, verificationMode: true } }),
  );
  if (!till || till.tenantId !== tenantId) {
    return { available: false, mode: "off", connected: false, connectError: null };
  }
  const endpoint = await prisma.mpesaC2bEndpoint.findUnique({ where: { locationId } });
  return {
    available: true,
    mode: till.verificationMode as MpesaVerificationMode,
    connected: Boolean(endpoint?.registeredAt) && endpoint?.tenantId === tenantId,
    connectError: endpoint?.tenantId === tenantId ? (endpoint.lastError ?? null) : null,
  };
}

export async function saveVerificationMode(tenantId: string, input: unknown): Promise<MpesaVerificationState> {
  const parsed = mpesaSaveModeSchema.parse(input);
  await withTenantContext(tenantId, async (tx) => {
    const till = await tx.mpesaTillSettings.findUnique({ where: { locationId: parsed.locationId }, select: { tenantId: true } });
    if (!till || till.tenantId !== tenantId) throw new NotFoundError("Save this storefront's M-Pesa till credentials first");
    await tx.mpesaTillSettings.update({ where: { locationId: parsed.locationId }, data: { verificationMode: parsed.mode } });
  });
  return getVerificationState(tenantId, parsed.locationId);
}

/** Registers this till's C2B notification URLs with Safaricom. The secret token in the URL is what
 * authenticates callbacks (they're unsigned). Daraja rejects URLs containing words like "mpesa" or
 * "safaricom", hence /lipa/c2b. In production registration is effectively one-time: re-registering
 * different URLs needs them deleted on the portal first, so the token is kept stable once minted. */
export async function connectC2b(tenantId: string, locationId: string): Promise<MpesaVerificationState> {
  const till = await withTenantContext(tenantId, (tx) => tx.mpesaTillSettings.findUnique({ where: { locationId } }));
  if (!till || till.tenantId !== tenantId) throw new NotFoundError("Save this storefront's M-Pesa till credentials first");

  const existing = await prisma.mpesaC2bEndpoint.findUnique({ where: { locationId } });
  if (existing && existing.tenantId !== tenantId) throw new NotFoundError("Storefront not found");
  const endpoint =
    existing ??
    (await prisma.mpesaC2bEndpoint.create({
      data: { token: randomBytes(24).toString("hex"), tenantId, locationId, shortcode: till.shortcode },
    }));

  const baseUrl = `${env.SERVER_PUBLIC_URL}/lipa/c2b/${endpoint.token}`;
  try {
    const accessToken = await getAccessToken(till);
    await registerC2bUrls({
      credentials: till,
      accessToken,
      confirmationUrl: `${baseUrl}/confirm`,
      validationUrl: `${baseUrl}/validate`,
    });
    await prisma.mpesaC2bEndpoint.update({
      where: { locationId },
      data: { shortcode: till.shortcode, registeredAt: new Date(), lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Safaricom rejected the registration";
    await prisma.mpesaC2bEndpoint.update({ where: { locationId }, data: { lastError: message } });
  }
  return getVerificationState(tenantId, locationId);
}

// ---- recording money received -------------------------------------------------------------------

type C2bBody = {
  TransID?: string;
  TransAmount?: string | number;
  TransTime?: string;
  BusinessShortCode?: string | number;
  MSISDN?: string | number;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
};

/** Public: Safaricom calls this for every payment to the till. An unknown token is ignored, and a
 * repeat of the same receipt is a no-op, so retries can't double-record. Never throws back at
 * Safaricom — a bad payload is logged, not retried forever. */
export async function handleC2bConfirmation(token: string, body: unknown): Promise<void> {
  const endpoint = await prisma.mpesaC2bEndpoint.findUnique({ where: { token } });
  if (!endpoint) return;
  const payload = (body ?? {}) as C2bBody;
  const code = payload.TransID ? normalizeCode(String(payload.TransID)) : "";
  const amount = Number(payload.TransAmount);
  if (!code || !Number.isFinite(amount) || amount <= 0) {
    console.error("[mpesa-c2b] ignoring malformed confirmation for location", endpoint.locationId);
    return;
  }
  await recordPayment({
    tenantId: endpoint.tenantId,
    locationId: endpoint.locationId,
    code,
    amountCents: Math.round(amount * 100),
    payerName: joinName([payload.FirstName, payload.MiddleName, payload.LastName]),
    maskedPhone: payload.MSISDN ? String(payload.MSISDN) : null,
    transTime: payload.TransTime ?? null,
    source: "c2b",
  });
}

/** Idempotent on (tenant, code). A C2B confirmation arriving after the STK callback for the same
 * payment fills in the customer's name, which the STK callback doesn't carry. */
export async function recordPayment(input: {
  tenantId: string;
  locationId: string;
  code: string;
  amountCents: number;
  payerName: string | null;
  maskedPhone: string | null;
  transTime: string | null;
  source: "c2b" | "stk";
}): Promise<void> {
  const code = normalizeCode(input.code);
  await prisma.mpesaPayment.upsert({
    where: { tenantId_code: { tenantId: input.tenantId, code } },
    create: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      code,
      amountCents: input.amountCents,
      payerName: input.payerName,
      maskedPhone: input.maskedPhone,
      transTime: input.transTime,
      source: input.source,
    },
    update: {
      ...(input.payerName ? { payerName: input.payerName } : {}),
      ...(input.maskedPhone ? { maskedPhone: input.maskedPhone } : {}),
    },
  });
}

// ---- finding and claiming -----------------------------------------------------------------------

/** Check Payment: recent, unclaimed payments on this till for exactly this amount. The cashier taps
 * to confirm one — never auto-completed, since two customers can pay the same amount minutes apart. */
export async function checkPayment(tenantId: string, input: unknown): Promise<MpesaPaymentMatch[]> {
  const parsed = mpesaCheckPaymentSchema.parse(input);
  const now = Date.now();
  const rows = await prisma.mpesaPayment.findMany({
    where: {
      tenantId,
      locationId: parsed.locationId,
      amountCents: wholeShillingCents(parsed.amountCents),
      claimedSaleId: null,
      receivedAt: { gte: new Date(now - MATCH_WINDOW_MS) },
      OR: [{ reservedAt: null }, { reservedAt: { lt: new Date(now - RESERVATION_MS) } }, { claimKey: parsed.claimKey }],
    },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    code: row.code,
    amountCents: row.amountCents,
    payerName: row.payerName,
    maskedPhone: row.maskedPhone,
    receivedAt: row.receivedAt.toISOString(),
  }));
}

function failure(outcome: Exclude<MpesaVerifyOutcome, "verified">, code: string, message: string): MpesaVerifyResult {
  return { outcome, code, message, record: null };
}

/** The core rule: a code verifies only if it's a real payment on THIS till, for the expected amount,
 * and isn't on any other sale. `saleId` claims it for good; without one it's reserved under `claimKey`
 * while the sale is being rung up. Atomic (conditional updateMany), so two tills can't both win. */
async function claimCode(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    locationId: string;
    code: string;
    expectedAmountCents: number | null;
    claimKey: string;
    saleId: string | null;
    employeeId: string | null;
  },
): Promise<MpesaVerifyResult> {
  const code = normalizeCode(params.code);
  const payment = await tx.mpesaPayment.findUnique({ where: { tenantId_code: { tenantId: params.tenantId, code } } });
  if (!payment) {
    return failure("not_found", code, `No payment with code ${code} has reached this till yet. Check the code, or try again in a moment.`);
  }
  if (payment.locationId !== params.locationId) {
    return failure("wrong_storefront", code, `${code} was paid to a different storefront's till.`);
  }
  if (params.expectedAmountCents !== null && payment.amountCents !== wholeShillingCents(params.expectedAmountCents)) {
    return failure("amount_mismatch", code, `${code} was for ${(payment.amountCents / 100).toLocaleString()}, not this amount.`);
  }

  // Codes typed before verification existed (or on tills that never claim) are only on the sale itself.
  const usedOnSale = await tx.sale.findFirst({
    where: {
      tenantId: params.tenantId,
      ...(params.saleId ? { id: { not: params.saleId } } : {}),
      OR: [{ paymentReference: code }, { payments: { array_contains: [{ reference: code }] } }],
    },
    select: { id: true },
  });
  if (usedOnSale) return failure("already_used", code, `${code} is already recorded on another sale.`);

  const now = new Date();
  const claimed = await tx.mpesaPayment.updateMany({
    where: {
      id: payment.id,
      AND: [
        { OR: [{ claimedSaleId: null }, ...(params.saleId ? [{ claimedSaleId: params.saleId }] : [])] },
        {
          OR: [
            { reservedAt: null },
            { reservedAt: { lt: new Date(now.getTime() - RESERVATION_MS) } },
            { claimKey: params.claimKey },
            ...(params.saleId ? [{ claimedSaleId: params.saleId }] : []),
          ],
        },
      ],
    },
    data: {
      claimKey: params.claimKey,
      reservedAt: now,
      claimedByEmployeeId: params.employeeId,
      ...(params.saleId ? { claimedSaleId: params.saleId, claimedAt: now } : {}),
    },
  });
  if (claimed.count === 0) return failure("already_used", code, `${code} is already used on another sale.`);

  return {
    outcome: "verified",
    code,
    message: payment.payerName ? `Verified: paid by ${payment.payerName}.` : "Verified.",
    record: { status: "verified", verifiedAt: now.toISOString(), payerName: payment.payerName, amountCents: payment.amountCents },
  };
}

/** Before the sale exists: verify a code (typed, or tapped from Check Payment) and reserve it. */
export async function verifyCode(actor: MpesaActor, input: unknown): Promise<MpesaVerifyResult> {
  const parsed = mpesaVerifyCodeSchema.parse(input);
  return withTenantContext(actor.tenantId, (tx) =>
    claimCode(tx, {
      tenantId: actor.tenantId,
      locationId: parsed.locationId,
      code: parsed.code,
      expectedAmountCents: parsed.amountCents ?? null,
      claimKey: parsed.claimKey,
      saleId: null,
      employeeId: actor.employeeId,
    }),
  );
}

/** After the sale completes: turns its reservations into permanent claims. */
export async function attachClaim(tenantId: string, input: unknown): Promise<{ attached: number }> {
  const parsed = mpesaAttachClaimSchema.parse(input);
  const now = new Date();
  const result = await prisma.mpesaPayment.updateMany({
    where: { tenantId, claimKey: parsed.claimKey, claimedSaleId: null },
    data: { claimedSaleId: parsed.saleId, claimedAt: now },
  });
  return { attached: result.count };
}

/** After a sale exists: verify its recorded code, or (`replacesCode`) try a corrected one. The claim
 * only moves once the new code verified; on any failure nothing changes and the old code stays. The
 * old code is released so it isn't stranded on a payment that was never really this sale's. */
export async function claimForExistingSale(
  tx: Prisma.TransactionClient,
  actor: MpesaActor,
  params: { saleId: string; locationId: string; code: string; replacesCode: string | null; expectedAmountCents: number | null },
): Promise<MpesaVerifyResult> {
  const result = await claimCode(tx, {
    tenantId: actor.tenantId,
    locationId: params.locationId,
    code: params.code,
    expectedAmountCents: params.expectedAmountCents,
    claimKey: `sale:${params.saleId}:${randomUUID()}`,
    saleId: params.saleId,
    employeeId: actor.employeeId,
  });
  if (result.outcome === "verified" && params.replacesCode && normalizeCode(params.replacesCode) !== result.code) {
    await tx.mpesaPayment.updateMany({
      where: { tenantId: actor.tenantId, code: normalizeCode(params.replacesCode), claimedSaleId: params.saleId },
      data: { claimedSaleId: null, claimedAt: null, claimKey: null, reservedAt: null, claimedByEmployeeId: null },
    });
  }
  return result;
}

/** DESKTOP's route: the sale lives in the till's own database, so this only moves the claim; the till
 * updates its local sale after a success and syncs it. */
export async function verifySaleCodeForDevice(actor: MpesaActor, input: unknown): Promise<MpesaVerifyResult> {
  const parsed = mpesaVerifySaleCodeSchema.parse(input);
  return withTenantContext(actor.tenantId, (tx) =>
    claimForExistingSale(tx, actor, {
      saleId: parsed.saleId,
      locationId: parsed.locationId,
      code: parsed.code,
      replacesCode: parsed.replacesCode ?? null,
      expectedAmountCents: parsed.amountCents ?? null,
    }),
  );
}

type StoredPayment = { reference?: string | null } & Record<string, unknown>;

/** Mobile's route: the server holds the sale, so a successful verify/correction updates it here too —
 * same transaction, and localUpdatedAt/syncedAt bumped so every till pulls the change. */
export async function verifySaleCodeOnServer(
  actor: MpesaActor,
  input: unknown,
  options: { canReplaceCode: boolean },
): Promise<MpesaVerifyResult> {
  const parsed = mpesaVerifySaleCodeSchema.parse(input);
  if (parsed.replacesCode && !options.canReplaceCode) {
    throw new HttpError(403, "Only an admin can try a different M-Pesa code on a sale");
  }
  return withTenantContext(actor.tenantId, async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: parsed.saleId } });
    if (!sale || sale.tenantId !== actor.tenantId) throw new NotFoundError("Sale not found");

    const result = await claimForExistingSale(tx, actor, {
      saleId: sale.id,
      locationId: sale.locationId,
      code: parsed.code,
      replacesCode: parsed.replacesCode ?? null,
      expectedAmountCents: parsed.amountCents ?? null,
    });
    if (result.outcome !== "verified" || !result.record) return result;

    const oldCode = parsed.replacesCode ? normalizeCode(parsed.replacesCode) : null;
    const verifications = { ...((sale.mpesaVerifications ?? {}) as Record<string, MpesaVerificationRecord>) };
    if (oldCode) delete verifications[oldCode];
    verifications[result.code] = result.record;

    const now = new Date();
    const payments = Array.isArray(sale.payments) ? (sale.payments as StoredPayment[]) : [];
    await tx.sale.update({
      where: { id: sale.id },
      data: {
        mpesaVerifications: verifications as unknown as Prisma.InputJsonValue,
        ...(oldCode
          ? {
              paymentReference: sale.paymentReference?.trim().toUpperCase() === oldCode ? result.code : sale.paymentReference,
              payments: payments.map((p) =>
                p.reference?.trim().toUpperCase() === oldCode ? { ...p, reference: result.code } : p,
              ) as unknown as Prisma.InputJsonValue,
            }
          : {}),
        // deviceId too: a till holding a stale copy must not treat this as its own version and
        // overwrite it, same rule as every mobile update to a sale.
        deviceId: actor.deviceId,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return result;
  });
}

/** What a mobile sale/invoice records for its M-Pesa codes, and SERVER's own strict enforcement: a
 * code counts as verified only if THIS checkout really reserved it. `enforce` is off for a queued
 * offline sale (it already happened; it's recorded unverified) and for customer debt collection,
 * which has no verify step yet. Returns the existing value when verification isn't in play. */
export async function buildSaleVerifications(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    locationId: string;
    saleId: string;
    claimKey: string | null | undefined;
    entries: Array<{ paymentMethodId: string | null; reference: string | null }>;
    existing: unknown;
    enforce: boolean;
  },
): Promise<Record<string, MpesaVerificationRecord> | null> {
  const existing = (params.existing ?? null) as Record<string, MpesaVerificationRecord> | null;
  const till = await tx.mpesaTillSettings.findUnique({ where: { locationId: params.locationId }, select: { tenantId: true, verificationMode: true } });
  if (!till || till.tenantId !== params.tenantId || till.verificationMode === "off") return existing;

  const methodIds = params.entries.map((e) => e.paymentMethodId).filter((v): v is string => Boolean(v));
  const mpesaMethods = await tx.paymentMethod.findMany({ where: { id: { in: methodIds }, code: "MPESA" }, select: { id: true } });
  const mpesaIds = new Set(mpesaMethods.map((m) => m.id));
  const strict = till.verificationMode === "strict" && params.enforce;

  const records: Record<string, MpesaVerificationRecord> = { ...(existing ?? {}) };
  const now = new Date();
  for (const entry of params.entries) {
    if (!entry.paymentMethodId || !mpesaIds.has(entry.paymentMethodId)) continue;
    const code = entry.reference ? normalizeCode(entry.reference) : "";
    const payment = code ? await tx.mpesaPayment.findUnique({ where: { tenantId_code: { tenantId: params.tenantId, code } } }) : null;
    if (payment && params.claimKey && payment.claimKey === params.claimKey) {
      // The key is spent here: replaying it can't mark the same code verified on another payment.
      await tx.mpesaPayment.update({ where: { id: payment.id }, data: { claimedSaleId: params.saleId, claimedAt: now, claimKey: null } });
      records[code] = { status: "verified", verifiedAt: now.toISOString(), payerName: payment.payerName, amountCents: payment.amountCents };
    } else if (strict) {
      throw new HttpError(400, "This storefront requires verified M-Pesa payments. Verify the M-Pesa code before completing.");
    } else if (code && !records[code]) {
      records[code] = { status: "unverified", verifiedAt: null, payerName: null, amountCents: null };
    }
  }
  return Object.keys(records).length > 0 ? records : existing;
}

/** One code's indicator for a row; null shows nothing. */
export function mpesaStatusOf(verifications: unknown, code: string | null | undefined): "verified" | "unverified" | null {
  if (!verifications || !code) return null;
  return (verifications as Record<string, MpesaVerificationRecord>)[normalizeCode(code)]?.status ?? null;
}

/** A sale's overall indicator: any unverified code makes the sale unverified. */
export function mpesaStatusOfSale(verifications: unknown): "verified" | "unverified" | null {
  const records = Object.values((verifications ?? {}) as Record<string, MpesaVerificationRecord>);
  if (records.length === 0) return null;
  return records.every((r) => r.status === "verified") ? "verified" : "unverified";
}
