/**
 * Prepaid subscription balance ("wallet") — a tenant tops up any amount, and every billing period
 * that falls due is paid from it automatically before any overdue warning or lock can happen
 * (services/subscription-wallet-service.ts). This file is the pure arithmetic only, kept free of
 * imports so it can be unit-tested directly.
 */

/** Smallest / largest top-up accepted, in whole shillings. */
export const MIN_TOPUP_KES = 50;
export const MAX_TOPUP_KES = 1_000_000;

/** What ONE billing period costs: the monthly price, or the yearly maintenance fee. Null when nothing
 * recurs (a one-off purchase), or no fee is set. */
export function pricePerPeriodCents(subscription: {
  billingCycle: string;
  priceCents: number;
  maintenanceFeeCents: number | null;
}): number | null {
  if (subscription.billingCycle === "MONTHLY") return subscription.priceCents > 0 ? subscription.priceCents : null;
  if (subscription.billingCycle === "YEARLY") return subscription.maintenanceFeeCents && subscription.maintenanceFeeCents > 0 ? subscription.maintenanceFeeCents : null;
  return null;
}

/**
 * Which owed periods the balance pays, oldest first, all-or-nothing per period (a period is never
 * part-paid from the balance). `owedPeriods` must already be in order and exclude paid ones.
 */
export function planWalletDeductions(
  balanceCents: number,
  pricePerPeriod: number | null,
  owedPeriods: readonly string[],
): { periods: string[]; spentCents: number; balanceAfterCents: number } {
  if (!pricePerPeriod || pricePerPeriod <= 0 || balanceCents < pricePerPeriod) {
    return { periods: [], spentCents: 0, balanceAfterCents: balanceCents };
  }
  const affordable = Math.floor(balanceCents / pricePerPeriod);
  const periods = owedPeriods.slice(0, affordable);
  const spentCents = periods.length * pricePerPeriod;
  return { periods, spentCents, balanceAfterCents: balanceCents - spentCents };
}

/** How many whole future periods the balance would cover — "covers 3 more months". */
export function periodsCovered(balanceCents: number, pricePerPeriod: number | null): number {
  if (!pricePerPeriod || pricePerPeriod <= 0 || balanceCents <= 0) return 0;
  return Math.floor(balanceCents / pricePerPeriod);
}

/**
 * A payment that arrives for periods someone already paid (Pay Now while the balance had just paid
 * the same month, or two pushes for the same period): those periods aren't recorded twice — their
 * share of the money goes to the balance instead.
 */
export function splitAlreadyPaid(
  periods: readonly string[],
  amountCents: number,
  alreadyPaid: ReadonlySet<string>,
): { toRecord: string[]; perPeriodCents: number; toBalanceCents: number } {
  if (periods.length === 0) return { toRecord: [], perPeriodCents: 0, toBalanceCents: amountCents };
  const perPeriodCents = Math.round(amountCents / periods.length);
  const toRecord = periods.filter((period) => !alreadyPaid.has(period));
  return { toRecord, perPeriodCents, toBalanceCents: amountCents - perPeriodCents * toRecord.length };
}
