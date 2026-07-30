import { prisma } from "../prisma.js";

/** Hourly is plenty granular against a 30-day grace window — this only needs to notice within an
 * hour or two of the actual deadline, not to the second. Matches the plain setInterval pattern
 * DESKTOP's own bootstrap.ts already uses for its periodic checks — no scheduler dependency
 * (node-cron etc.) needed for "run this sweep periodically," so none was added. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Must match DESKTOP's shared/lib/grace-period.ts GRACE_PERIOD_DAYS exactly — this is the
 * server-side authoritative enforcement of the same 30-day policy DESKTOP already computes locally
 * (offline-safe, off its own clock) to hard-lock a MONTHLY tenant's UI. That local computation was
 * never backed by anything real server-side — License.status stayed ACTIVE forever regardless, so
 * the admin dashboard never reflected reality and a determined user's local clock was the only
 * thing standing between them and a "locked" POS. This sweep is what makes the lock real. */
const GRACE_PERIOD_DAYS = 30;

/**
 * Four-part sweep, all idempotent (safe to re-run every hour forever):
 *
 * 0. Any TRIAL license whose trialEndsAt has passed flips to ACTIVE — without this, a tenant whose
 *    trial genuinely ended stayed in TRIAL forever (License.status never changed on its own), which
 *    also meant DESKTOP's grace-period warnings correctly stayed silent during the trial but would
 *    then ALSO stay silent forever afterward, since nothing ever moved them out of "trial" — billing
 *    enforcement could only ever start if a super admin manually flipped the status by hand.
 * 1. Any ACTIVE subscription whose nextDueDate has passed gets flagged PAST_DUE — pure visibility,
 *    every billing cycle, no enforcement action. Nothing in this codebase ever set this
 *    automatically before; it was purely a value an admin could manually pick.
 * 2. The reverse: a PAST_DUE subscription whose nextDueDate is no longer overdue (a payment landed,
 *    or an admin manually corrected the date) flips back to ACTIVE — keeps the derived status
 *    honest regardless of which path fixed the date.
 * 3. Hard enforcement: a MONTHLY subscription whose 30-day grace has fully lapsed gets its
 *    tenant's License automatically SUSPENDED (reason PAYMENT_OVERDUE). Deliberately scoped to
 *    subscriptionType MONTHLY only and to a currently-ACTIVE license only — LIFETIME/CUSTOM tenants
 *    never get their License touched here at all (per explicit product decision, they only ever
 *    lose cloud sync, never the software itself — see DESKTOP's sync-engine grace gate), and a
 *    license already SUSPENDED/CANCELLED for some other reason is left alone rather than having its
 *    reason silently overwritten.
 */
/** Exported (not just called internally by startBillingScheduler below) so it can be invoked
 * directly and deterministically from a verification script, without pulling in the setInterval
 * side effect. */
export async function runBillingSweep(): Promise<void> {
  const now = new Date();
  const graceExpiryCutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const trialEndedResult = await prisma.license.updateMany({
    where: { status: "TRIAL", trialEndsAt: { lt: now } },
    data: { status: "ACTIVE" },
  });

  // Scoped to an ACTIVE license, same as the auto-suspend step below — a still-in-trial tenant's
  // nextDueDate is already correctly anchored past their trialEndsAt (see resolveBillingAnchorDate),
  // but a defensive gate here too means this can never flag PAST_DUE against a trial tenant even if
  // some other bug ever left an un-anchored nextDueDate in the past.
  const pastDueResult = await prisma.subscription.updateMany({
    where: { nextDueDate: { lt: now }, status: "ACTIVE", tenant: { license: { status: "ACTIVE" } } },
    data: { status: "PAST_DUE" },
  });

  const recoveredResult = await prisma.subscription.updateMany({
    where: { nextDueDate: { gte: now }, status: "PAST_DUE" },
    data: { status: "ACTIVE" },
  });

  const overdueMonthly = await prisma.subscription.findMany({
    where: {
      subscriptionType: "MONTHLY",
      nextDueDate: { lt: graceExpiryCutoff },
      tenant: { license: { status: "ACTIVE" } },
    },
    select: { tenantId: true },
  });

  for (const { tenantId } of overdueMonthly) {
    await prisma.license.update({
      where: { tenantId },
      data: { status: "SUSPENDED", suspensionReason: "PAYMENT_OVERDUE" },
    });
  }

  if (trialEndedResult.count > 0 || pastDueResult.count > 0 || recoveredResult.count > 0 || overdueMonthly.length > 0) {
    console.log(
      `[billing-scheduler] ${trialEndedResult.count} trial(s) ended -> ACTIVE, ${pastDueResult.count} newly PAST_DUE, ${recoveredResult.count} recovered to ACTIVE, ${overdueMonthly.length} MONTHLY license(s) auto-suspended for PAYMENT_OVERDUE.`,
    );
  }
}

/** Called once at server boot (see index.ts). Runs immediately, then on the interval above —
 * matches DESKTOP bootstrap.ts's own "fire immediately, then setInterval" convention. */
export function startBillingScheduler(): void {
  void runBillingSweep();
  setInterval(() => void runBillingSweep(), SWEEP_INTERVAL_MS);
}
