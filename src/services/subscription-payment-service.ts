import type { SubscriptionPayment } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { NotFoundError } from "../lib/http-error.js";
import {
  computePaymentSchedule,
  computeTrueNextDueDate,
  resolveBillingAnchorDate,
  type BillingCycle
} from "../lib/billing-periods.js";
import { prisma } from "../prisma.js";
import { subscriptionPaymentCreateSchema } from "../schemas/subscription-payment.js";
import { reactivateIfPaymentOverdue } from "./license-service.js";
import { getTenant } from "./tenant-service.js";

/** Reuses getTenant's outlet-scoping (throws 404 for a MARKETER viewing another outlet's tenant) —
 * the same boundary, not a separate check. */
export async function listPayments(tenantId: string, actor: AuthenticatedAccount): Promise<SubscriptionPayment[]> {
  await getTenant(tenantId, actor);
  return prisma.subscriptionPayment.findMany({ where: { tenantId }, orderBy: { paymentDate: "desc" } });
}

export type AdminPaymentScheduleResult = {
  billingCycle: BillingCycle;
  pricePerPeriodCents: number | null;
  currency: string;
  periods: ReturnType<typeof computePaymentSchedule>;
  nextDueDate: string | null;
};

/** Admin-dashboard equivalent of activation-service.ts's own getPaymentSchedule (which DESKTOP
 * calls, license-key-authenticated) — same computePaymentSchedule call, same shape, just reached
 * via an admin session + outlet-scoping instead of a license key. One shared function
 * (computePaymentSchedule) means the admin calendar, DESKTOP's own port of it, and the "pay N
 * periods in advance" STK flow can never disagree about which period a given date falls in — this
 * replaces PaymentCalendar.tsx's OWN separate (and buggy — used tenant.createdAt instead of the
 * subscription's real startDate, and had no month-level start gate) calculation. */
export async function getPaymentSchedule(tenantId: string, actor: AuthenticatedAccount): Promise<AdminPaymentScheduleResult> {
  const tenant = await getTenant(tenantId, actor);
  const subscription = tenant.subscription;
  if (!subscription) {
    return { billingCycle: "ONCE", pricePerPeriodCents: null, currency: tenant.currency, periods: [], nextDueDate: null };
  }

  const paidPayments = await prisma.subscriptionPayment.findMany({
    where: { tenantId, status: "PAID" },
    select: { billingPeriod: true },
  });
  const paidPeriods = new Set(paidPayments.map((payment) => payment.billingPeriod));

  const anchorDate = resolveBillingAnchorDate(subscription.startDate, tenant.license?.trialEndsAt ?? null);
  const periods = computePaymentSchedule(anchorDate, subscription.billingCycle as BillingCycle, paidPeriods);
  const pricePerPeriodCents =
    subscription.billingCycle === "MONTHLY"
      ? subscription.priceCents
      : subscription.billingCycle === "YEARLY"
        ? (subscription.maintenanceFeeCents ?? null)
        : null;

  return {
    billingCycle: subscription.billingCycle as BillingCycle,
    pricePerPeriodCents,
    currency: tenant.currency,
    periods,
    nextDueDate: subscription.nextDueDate?.toISOString() ?? null,
  };
}

/** SUPER_ADMIN only — enforced at the route layer (recording a payment affects billing state, a
 * more sensitive action than creating a client). Append-only: this never updates or replaces a
 * prior payment row, a correction is always a new row. `nextDueDateAfter` is still STORED on the
 * payment row as an audit snapshot of what the admin believed at the time, but the live
 * Subscription.nextDueDate is now always RECOMPUTED from the full paid-periods set (see
 * computeTrueNextDueDate) rather than trusted from that client-supplied value — an admin manually
 * recording one out-of-order period (e.g. paying August before May) must not accidentally advance
 * the cursor past a still-unpaid earlier gap, the same bug class this fixed on the STK side. */
export async function recordPayment(
  tenantId: string,
  input: unknown,
  actor: AuthenticatedAccount,
): Promise<SubscriptionPayment> {
  const parsed = subscriptionPaymentCreateSchema.parse(input);
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { subscription: true, license: true }
  });
  if (!tenant) {
    throw new NotFoundError("Tenant not found");
  }

  const payment = await prisma.subscriptionPayment.create({
    data: {
      tenantId,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      paymentMethod: parsed.paymentMethod,
      transactionReference: parsed.transactionReference,
      billingPeriod: parsed.billingPeriod,
      paymentDate: parsed.paymentDate,
      nextDueDateAfter: parsed.nextDueDateAfter ?? null,
      status: parsed.status,
      createdBy: actor.id,
    },
  });

  if (parsed.status === "PAID" && tenant.subscription) {
    const allPaid = await prisma.subscriptionPayment.findMany({
      where: { tenantId, status: "PAID" },
      select: { billingPeriod: true },
    });
    const paidPeriods = new Set(allPaid.map((p) => p.billingPeriod));
    const anchorDate = resolveBillingAnchorDate(tenant.subscription.startDate, tenant.license?.trialEndsAt ?? null);
    const newNextDueDate = computeTrueNextDueDate(
      anchorDate,
      tenant.subscription.billingCycle as BillingCycle,
      paidPeriods,
    );
    await prisma.subscription.update({
      where: { tenantId },
      data: { status: "ACTIVE", nextDueDate: newNextDueDate },
    });
    await reactivateIfPaymentOverdue(tenantId);
  }

  return payment;
}
