import type { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import {
  computePaymentSchedule,
  computeTrueNextDueDate,
  resolveBillingAnchorDate,
  type BillingCycle,
} from "../lib/billing-periods.js";
import { periodsCovered, planWalletDeductions, pricePerPeriodCents } from "../lib/subscription-wallet.js";
import { prisma } from "../prisma.js";
import { reactivateIfPaymentOverdue } from "./license-service.js";

/**
 * Prepaid subscription balance (lib/subscription-wallet.ts has the arithmetic). Every change to a
 * tenant's balance happens inside one transaction holding that tenant's wallet lock, and writes a
 * SubscriptionWalletEntry alongside Subscription.walletBalanceCents — so two payments landing at once
 * can never double-spend, and the ledger always adds up to the balance.
 */

async function lockWallet(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription-wallet:${tenantId}`}))`;
}

export type WalletSource = {
  kind?: "TOPUP" | "ADJUSTMENT";
  paymentMethod: string;
  reference?: string | null;
  note?: string | null;
  createdBy?: string | null;
};

/** Adds money to the balance (a top-up, or a payment's surplus) — or takes it away for a negative
 * ADJUSTMENT, never below zero. Returns the new balance. Callers then run settleDueFromWallet. */
export async function creditWallet(tenantId: string, amountCents: number, source: WalletSource): Promise<number> {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new HttpError(400, "Enter an amount");
  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, tenantId);
    const subscription = await tx.subscription.findUnique({ where: { tenantId }, select: { walletBalanceCents: true } });
    if (!subscription) throw new NotFoundError("This account has no subscription");
    const balanceAfterCents = subscription.walletBalanceCents + amountCents;
    if (balanceAfterCents < 0) throw new HttpError(400, "That would take the balance below zero");
    await tx.subscription.update({ where: { tenantId }, data: { walletBalanceCents: balanceAfterCents } });
    await tx.subscriptionWalletEntry.create({
      data: {
        tenantId,
        kind: source.kind ?? "TOPUP",
        amountCents,
        balanceAfterCents,
        paymentMethod: source.paymentMethod,
        reference: source.reference ?? null,
        note: source.note ?? null,
        createdBy: source.createdBy ?? null,
      },
    });
    return balanceAfterCents;
  });
}

/**
 * Pays every period that is due (or overdue) from the balance, oldest first, as long as the balance
 * covers a whole period — before any overdue warning or lock. Records each one exactly like any other
 * payment (SubscriptionPayment, method "Balance"), recomputes the next due date from the full paid set
 * (same as the M-Pesa/Pesapal paths), and lifts an overdue suspension once nothing is owed. Safe to
 * call any time, as often as wanted: it only ever pays what's owed. Returns the periods it paid.
 */
export async function settleDueFromWallet(tenantId: string, now: Date = new Date()): Promise<string[]> {
  const paid = await prisma.$transaction(async (tx) => {
    await lockWallet(tx, tenantId);
    const subscription = await tx.subscription.findUnique({ where: { tenantId } });
    if (!subscription || subscription.walletBalanceCents <= 0) return [];
    const price = pricePerPeriodCents(subscription);
    if (!price || subscription.walletBalanceCents < price) return [];
    const [license, tenant, paidRows] = await Promise.all([
      tx.license.findUnique({ where: { tenantId }, select: { trialEndsAt: true, status: true } }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } }),
      tx.subscriptionPayment.findMany({ where: { tenantId, status: "PAID" }, select: { billingPeriod: true } }),
    ]);
    if (!license || !tenant || license.status === "CANCELLED") return [];

    const cycle = subscription.billingCycle as BillingCycle;
    const paidPeriods = new Set(paidRows.map((row) => row.billingPeriod));
    const anchor = resolveBillingAnchorDate(subscription.startDate, license.trialEndsAt);
    const owed = computePaymentSchedule(anchor, cycle, paidPeriods, now)
      .filter((entry) => entry.status === "overdue" || entry.status === "due")
      .map((entry) => entry.key);
    const plan = planWalletDeductions(subscription.walletBalanceCents, price, owed);
    if (plan.periods.length === 0) return [];

    let balance = subscription.walletBalanceCents;
    for (const period of plan.periods) {
      balance -= price;
      paidPeriods.add(period);
      await tx.subscriptionPayment.create({
        data: {
          tenantId,
          amountCents: price,
          currency: tenant.currency,
          paymentMethod: "Balance",
          billingPeriod: period,
          paymentDate: now,
          status: "PAID",
        },
      });
      await tx.subscriptionWalletEntry.create({
        data: { tenantId, kind: "DEDUCTION", amountCents: -price, balanceAfterCents: balance, billingPeriod: period, paymentMethod: "Balance" },
      });
    }
    await tx.subscription.update({
      where: { tenantId },
      data: { walletBalanceCents: balance, status: "ACTIVE", nextDueDate: computeTrueNextDueDate(anchor, cycle, paidPeriods, now) },
    });
    return plan.periods;
  });
  if (paid.length > 0) await reactivateIfPaymentOverdue(tenantId);
  return paid;
}

/** The billing sweep's step: every tenant with a balance and something due. Errors are per tenant —
 * one bad row never stops the others. Returns how many periods were paid. */
export async function settleAllDueWallets(now: Date = new Date()): Promise<number> {
  const candidates = await prisma.subscription.findMany({
    where: { walletBalanceCents: { gt: 0 }, nextDueDate: { lte: now }, billingCycle: { not: "ONCE" } },
    select: { tenantId: true },
  });
  let count = 0;
  for (const { tenantId } of candidates) {
    try {
      count += (await settleDueFromWallet(tenantId, now)).length;
    } catch (err) {
      console.error(`[subscription-wallet] couldn't settle tenant ${tenantId}:`, err instanceof Error ? err.message : err);
    }
  }
  return count;
}

export type WalletEntrySummary = {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  billingPeriod: string | null;
  paymentMethod: string | null;
  reference: string | null;
  note: string | null;
  createdAt: string;
};

export type WalletSummary = {
  balanceCents: number;
  currency: string;
  pricePerPeriodCents: number | null;
  billingCycle: string;
  /** Whole future periods the balance covers ("covers 3 more months"). */
  periodsCovered: number;
  nextDueDate: string | null;
  /** True when the next due period is NOT covered — the cue for a "top up before …" reminder. */
  nextDueUncovered: boolean;
  entries: WalletEntrySummary[];
};

export async function getWalletSummary(tenantId: string, entryLimit = 30): Promise<WalletSummary> {
  const [subscription, tenant, entries] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } }),
    prisma.subscriptionWalletEntry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: entryLimit }),
  ]);
  if (!tenant) throw new NotFoundError("Tenant not found");
  const price = subscription ? pricePerPeriodCents(subscription) : null;
  const balance = subscription?.walletBalanceCents ?? 0;
  return {
    balanceCents: balance,
    currency: tenant.currency,
    pricePerPeriodCents: price,
    billingCycle: subscription?.billingCycle ?? "ONCE",
    periodsCovered: periodsCovered(balance, price),
    nextDueDate: subscription?.nextDueDate?.toISOString() ?? null,
    nextDueUncovered: price !== null && subscription?.nextDueDate !== null && balance < price,
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      amountCents: entry.amountCents,
      balanceAfterCents: entry.balanceAfterCents,
      billingPeriod: entry.billingPeriod,
      paymentMethod: entry.paymentMethod,
      reference: entry.reference,
      note: entry.note,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/** Admin dashboard: a cash/bank top-up recorded by hand, or a correction (negative). Then settles. */
export async function adjustWalletAsAdmin(
  tenantId: string,
  input: { amountCents: number; kind: "TOPUP" | "ADJUSTMENT"; paymentMethod: string; reference: string | null; note: string | null },
  actorId: string,
): Promise<WalletSummary> {
  await creditWallet(tenantId, input.amountCents, { ...input, createdBy: actorId });
  await settleDueFromWallet(tenantId);
  return getWalletSummary(tenantId);
}
