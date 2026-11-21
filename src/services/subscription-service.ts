import type { Plan, Subscription } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { billingPeriodKey, type BillingCycle, computePaymentSchedule, resolveBillingAnchorDate } from "../lib/billing-periods.js";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { subscriptionUpdateSchema } from "../schemas/subscription.js";
import { reactivateIfPaymentOverdue } from "./license-service.js";

/** SUPER_ADMIN only — enforced at the route layer. Changes the commercial arrangement in place;
 * SubscriptionPayment is the append-only ledger that preserves history, not this row.
 *
 * The calendar, "Pay Now" and every payment path count periods from the billing anchor (start date
 * / trial end), never from nextDueDate — so moving nextDueDate past an unpaid period on its own
 * would leave that period owed forever while Pay Now charged the later one. Instead, the skipped
 * periods are settled as KES 0 "WAIVED" payments, which every path already treats as paid. That
 * needs `waiveUnpaidBefore: true`; without it the edit is refused and names the periods. */
export async function updateSubscription(
  tenantId: string,
  input: unknown,
  actor: AuthenticatedAccount,
): Promise<Subscription & { plan: Plan }> {
  const { waiveUnpaidBefore, ...parsed } = subscriptionUpdateSchema.parse(input);
  const existing = await prisma.subscription.findUnique({ where: { tenantId }, include: { tenant: { include: { license: true } } } });
  if (!existing) {
    throw new NotFoundError("This tenant has no subscription");
  }

  if (parsed.planId) {
    const plan = await prisma.plan.findUnique({ where: { id: parsed.planId } });
    if (!plan) {
      throw new HttpError(400, "Selected plan was not found");
    }
  }

  const skipped = parsed.nextDueDate ? await unpaidPeriodsBefore(existing, parsed.billingCycle, parsed.nextDueDate) : [];
  if (skipped.length > 0 && !waiveUnpaidBefore) {
    throw new HttpError(
      409,
      `The new due date skips unpaid ${skipped.map((p) => p.label).join(", ")}. Waive ${skipped.length === 1 ? "it" : "them"} or record the payment first.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (skipped.length > 0) {
      const now = new Date();
      await tx.subscriptionPayment.createMany({
        data: skipped.map((period) => ({
          tenantId,
          amountCents: 0,
          currency: existing.tenant.currency,
          paymentMethod: "WAIVED",
          transactionReference: null,
          billingPeriod: period.key,
          paymentDate: now,
          nextDueDateAfter: parsed.nextDueDate ?? null,
          status: "PAID" as const,
          createdBy: actor.id,
        })),
      });
    }
    return tx.subscription.update({
      where: { tenantId },
      data: skipped.length > 0 ? { ...parsed, status: parsed.status ?? "ACTIVE" } : parsed,
      include: { plan: true },
    });
  });

  if (skipped.length > 0) await reactivateIfPaymentOverdue(tenantId);
  return updated;
}

/** Unpaid periods (overdue, due or future) that fall before `nextDueDate`'s own period. */
async function unpaidPeriodsBefore(
  subscription: Subscription & { tenant: { license: { trialEndsAt: Date | null } | null } },
  billingCycleOverride: BillingCycle | undefined,
  nextDueDate: Date,
): Promise<{ key: string; label: string }[]> {
  const billingCycle = billingCycleOverride ?? (subscription.billingCycle as BillingCycle);
  if (billingCycle === "ONCE") return [];
  const paid = await prisma.subscriptionPayment.findMany({
    where: { tenantId: subscription.tenantId, status: "PAID" },
    select: { billingPeriod: true },
  });
  const anchor = resolveBillingAnchorDate(subscription.startDate, subscription.tenant.license?.trialEndsAt ?? null);
  const cutoff = billingPeriodKey(nextDueDate, billingCycle);
  return computePaymentSchedule(anchor, billingCycle, new Set(paid.map((p) => p.billingPeriod)))
    .filter((entry) => entry.status !== "paid" && entry.key < cutoff)
    .map(({ key, label }) => ({ key, label }));
}
