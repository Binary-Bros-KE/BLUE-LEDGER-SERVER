/**
 * Shared billing-period math for platform subscriptions (Blue Ledger charging its OWN tenants for
 * the software) — used by tenant creation (initial due date), the billing scheduler (PAST_DUE/
 * auto-suspend sweeps), the paid/pending calendar views (admin's PaymentCalendar.tsx and DESKTOP's
 * own port of it), and the platform-billing STK "pay N periods in advance" flow. One source of
 * truth so none of these can ever disagree about what period a given date falls in or what the
 * next due date after a payment should be.
 *
 * MONTHLY periods are keyed "YYYY-MM" and simply step by calendar month — a due date can land on
 * any day of the month (whatever day the tenant originally started on), the grid buckets by
 * calendar month regardless of exact day.
 *
 * YEARLY periods are keyed "YYYY" and are DELIBERATELY calendar-aligned, not anniversary-of-signup
 * — per explicit product decision, the first due date for a YEARLY (LIFETIME/CUSTOM maintenance)
 * subscription is always January 1st of the year AFTER the tenant's start date, and every
 * subsequent one is January 1st of the following year. A tenant starting mid-2026 never owes
 * anything for 2026 itself (that's covered by the one-time purchase price), only from 2027 onward.
 */

export type BillingCycle = "MONTHLY" | "YEARLY" | "ONCE";

/** The very first due date a brand-new subscription gets, computed once at tenant creation. */
export function computeInitialNextDueDate(startDate: Date, billingCycle: BillingCycle): Date | null {
  if (billingCycle === "MONTHLY") {
    const next = new Date(startDate);
    next.setMonth(next.getMonth() + 1);
    return next;
  }
  if (billingCycle === "YEARLY") {
    return new Date(startDate.getFullYear() + 1, 0, 1);
  }
  return null;
}

/** Steps a due date forward exactly one billing period. For YEARLY this assumes `date` is already
 * January 1st (true for every due date this module ever produces) — stepping just adds one year,
 * staying calendar-aligned. */
export function nextPeriodAfter(date: Date, billingCycle: BillingCycle): Date {
  const next = new Date(date);
  if (billingCycle === "MONTHLY") {
    next.setMonth(next.getMonth() + 1);
  } else if (billingCycle === "YEARLY") {
    next.setFullYear(next.getFullYear() + 1);
  }
  return next;
}

/** The reverse of billingPeriodKey — turns a stored period key back into the due date it
 * represents. Used by the platform-billing STK callback to recover `newNextDueDate` from the
 * `periods` array that was already computed and persisted at push time (see
 * BillingMpesaTransaction's own comment on why the callback uses the STORED list rather than
 * recomputing against the subscription's live nextDueDate). */
export function parsePeriodKey(key: string, billingCycle: BillingCycle): Date {
  if (billingCycle === "MONTHLY") {
    const [yearPart, monthPart] = key.split("-");
    return new Date(Number(yearPart), Number(monthPart) - 1, 1);
  }
  return new Date(Number(key), 0, 1);
}

/** The free-form `SubscriptionPayment.billingPeriod` key for a given due date. */
export function billingPeriodKey(date: Date, billingCycle: BillingCycle): string {
  if (billingCycle === "MONTHLY") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  if (billingCycle === "YEARLY") {
    return String(date.getFullYear());
  }
  return "one-time";
}

/** For the platform-billing "pay N periods in advance" STK flow: given the subscription's CURRENT
 * `nextDueDate`, returns the N period keys being paid for (in order) and the due date that should
 * become the new `nextDueDate` once all N are marked paid. Returns null if there's no recurring
 * due date to advance (a ONCE/no-maintenance subscription — nothing to prepay). */
export function computeAdvancePayment(
  currentNextDueDate: Date,
  billingCycle: BillingCycle,
  periodCount: number,
): { periods: string[]; newNextDueDate: Date } | null {
  if (billingCycle === "ONCE" || periodCount < 1) return null;
  const periods: string[] = [];
  let cursor = new Date(currentNextDueDate);
  for (let i = 0; i < periodCount; i += 1) {
    periods.push(billingPeriodKey(cursor, billingCycle));
    cursor = nextPeriodAfter(cursor, billingCycle);
  }
  return { periods, newNextDueDate: cursor };
}

function isPeriodInFuture(periodDate: Date, billingCycle: BillingCycle, now: Date): boolean {
  if (billingCycle === "MONTHLY") {
    return (
      periodDate.getFullYear() > now.getFullYear() ||
      (periodDate.getFullYear() === now.getFullYear() && periodDate.getMonth() > now.getMonth())
    );
  }
  return periodDate.getFullYear() > now.getFullYear();
}

function periodLabel(periodDate: Date, billingCycle: BillingCycle): string {
  if (billingCycle === "MONTHLY") {
    return periodDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return String(periodDate.getFullYear());
}

export type BillingPeriodEntry = {
  key: string;
  label: string;
  status: "paid" | "pending" | "future";
};

/** The "Jan ✅ Feb ✅ Mar ❌" computed grid — same logic the admin dashboard's PaymentCalendar.tsx
 * already uses for MONTHLY tenants, generalized here to also cover YEARLY and to be shared between
 * SERVER (this function) and any client rendering it, plus given a start-date lower bound so a
 * tenant who started in July never sees January of that same year marked "pending" (they weren't a
 * customer yet). Never shows anything for ONCE (nothing recurring to track). Horizon extends a
 * reasonable distance into the future beyond "now" specifically so a "pay in advance" picker has
 * real future periods to offer, not just the immediately-next one. */
export function computePaymentSchedule(
  startDate: Date,
  billingCycle: BillingCycle,
  paidPeriods: ReadonlySet<string>,
  now: Date = new Date(),
): BillingPeriodEntry[] {
  if (billingCycle === "ONCE") return [];

  const start =
    billingCycle === "MONTHLY"
      ? new Date(startDate.getFullYear(), startDate.getMonth(), 1)
      : new Date(startDate.getFullYear() + 1, 0, 1);

  const horizon =
    billingCycle === "MONTHLY"
      ? new Date(now.getFullYear(), now.getMonth() + 12, 1)
      : new Date(Math.max(start.getFullYear() + 4, now.getFullYear() + 2), 0, 1);

  const entries: BillingPeriodEntry[] = [];
  let cursor = new Date(start);
  while (cursor <= horizon) {
    const key = billingPeriodKey(cursor, billingCycle);
    entries.push({
      key,
      label: periodLabel(cursor, billingCycle),
      status: paidPeriods.has(key) ? "paid" : isPeriodInFuture(cursor, billingCycle, now) ? "future" : "pending",
    });
    cursor = nextPeriodAfter(cursor, billingCycle);
  }
  return entries;
}
