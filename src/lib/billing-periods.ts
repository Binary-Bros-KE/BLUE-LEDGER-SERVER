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

/** The date billing periods should actually be computed FROM. A trial tenant owes nothing until
 * their trial ends — Subscription.startDate is when they signed up, not when paid billing begins,
 * and computeInitialNextDueDate/computePaymentSchedule have no concept of "trial" on their own. Every
 * caller that seeds or recomputes a due date must resolve this FIRST and pass the result in as
 * `startDate`, rather than the subscription's raw startDate. trialEndsAt is a permanent historical
 * fact once set (when THIS tenant's trial ended) — it must keep anchoring the schedule the same way
 * even after the billing scheduler flips License.status from TRIAL to ACTIVE once that date passes,
 * or the calendar would visibly reshuffle the moment that sweep runs. That's why this only compares
 * dates and never looks at the current license status at all.
 *
 * Returns the day AFTER trialEndsAt, not trialEndsAt itself — computeInitialNextDueDate truncates
 * MONTHLY to the 1st of whatever month it's given, so passing trialEndsAt directly (e.g. July 31)
 * would still resolve to July 1 and show that same month as immediately due, defeating the entire
 * point. Stepping one day past it applies the exact same "no free first month" policy regular
 * (non-trial) subscriptions already use, just re-anchored to whichever month the trial actually
 * ended in — a trial ending July 31 owes nothing for July and first becomes due in August; one
 * ending mid-month (July 15) owes for the rest of that same month, same as a non-trial tenant
 * starting mid-month always has. */
export function resolveBillingAnchorDate(startDate: Date, trialEndsAt: Date | null): Date {
  if (!trialEndsAt || trialEndsAt <= startDate) return startDate;
  const dayAfterTrial = new Date(trialEndsAt);
  dayAfterTrial.setDate(dayAfterTrial.getDate() + 1);
  return dayAfterTrial;
}

/** The very first due date a brand-new subscription gets, computed once at tenant creation (seeds
 * Subscription.nextDueDate) — and ALSO the exact anchor computePaymentSchedule below starts its
 * calendar from, via this same function, so the two can never disagree about which period is the
 * tenant's first real obligation. MONTHLY owes from the calendar month the tenant started in (no
 * free first month) — a tenant with zero trial is expected to be billed from day one. YEARLY stays
 * calendar-aligned to January 1st of the year AFTER start (a mid-year signup owes nothing for the
 * remainder of their start year, covered by the one-time purchase price). */
export function computeInitialNextDueDate(startDate: Date, billingCycle: BillingCycle): Date | null {
  if (billingCycle === "MONTHLY") {
    return new Date(startDate.getFullYear(), startDate.getMonth(), 1);
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

function isPeriodCurrent(periodDate: Date, billingCycle: BillingCycle, now: Date): boolean {
  if (billingCycle === "MONTHLY") {
    return periodDate.getFullYear() === now.getFullYear() && periodDate.getMonth() === now.getMonth();
  }
  return periodDate.getFullYear() === now.getFullYear();
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
  /** "overdue" — unpaid and strictly before the current period (red, genuinely late).
   * "due" — unpaid and IS the current period (amber, due now but not yet late).
   * "future" — after the current period (grey, not applicable yet).
   * "paid" — settled (green). */
  status: "paid" | "overdue" | "due" | "future";
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

  // Same anchor computeInitialNextDueDate uses to seed the real Subscription.nextDueDate — by
  // construction, the calendar's first cell and the tenant's actual first payable period can never
  // disagree (previously they were computed separately and drifted: this used to start the MONTHLY
  // grid at the tenant's own start month while computeInitialNextDueDate seeded nextDueDate one
  // month later, so the calendar showed a period as owed that the real payment-advancement engine
  // had never considered due at all — it could never actually be paid via the STK "pay N periods"
  // flow, which always counts forward from nextDueDate).
  const start = computeInitialNextDueDate(startDate, billingCycle)!;

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
      status: paidPeriods.has(key)
        ? "paid"
        : isPeriodInFuture(cursor, billingCycle, now)
          ? "future"
          : isPeriodCurrent(cursor, billingCycle, now)
            ? "due"
            : "overdue",
    });
    cursor = nextPeriodAfter(cursor, billingCycle);
  }
  return entries;
}

/** The tenant's TRUE next due date — the earliest period (from the same real anchor
 * computeInitialNextDueDate/computePaymentSchedule use) that is NOT yet paid. Call this to
 * RECOMPUTE Subscription.nextDueDate fresh after every payment (both the STK flow and the manual
 * admin entry), instead of incrementally advancing it "N periods past wherever it already was."
 * That incremental approach is what let a payment silently skip over an earlier unpaid gap — pay 3
 * periods starting from an already-advanced nextDueDate and the truly-oldest unpaid period could
 * never be reached again, yet nextDueDate looked perfectly caught up (in the future), so the
 * license never re-locked despite a real gap the calendar still (correctly) showed as overdue. Since
 * this is DERIVED fresh from the full paid-periods set every time, a gap is now structurally
 * impossible to create via either payment path. Returns null for ONCE (nothing recurring) or if
 * every generated period within the horizon is already paid (practically unreachable). */
export function computeTrueNextDueDate(
  startDate: Date,
  billingCycle: BillingCycle,
  paidPeriods: ReadonlySet<string>,
  now: Date = new Date(),
): Date | null {
  if (billingCycle === "ONCE") return null;
  const schedule = computePaymentSchedule(startDate, billingCycle, paidPeriods, now);
  const earliestUnpaid = schedule.find((entry) => entry.status === "overdue" || entry.status === "due");
  if (earliestUnpaid) return parsePeriodKey(earliestUnpaid.key, billingCycle);
  const firstFuture = schedule.find((entry) => entry.status === "future");
  return firstFuture ? parsePeriodKey(firstFuture.key, billingCycle) : null;
}
