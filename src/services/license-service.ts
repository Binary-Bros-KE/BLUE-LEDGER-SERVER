import type { License } from "@prisma/client";
import { NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { licenseSuspendSchema, licenseUpdateSchema } from "../schemas/license.js";

async function getLicenseByTenant(tenantId: string): Promise<License> {
  const license = await prisma.license.findUnique({ where: { tenantId } });
  if (!license) {
    throw new NotFoundError("This tenant has no license");
  }
  return license;
}

/** SUPER_ADMIN only — enforced at the route layer. Independent of Subscription.status: a license
 * can be suspended for reasons that have nothing to do with billing (fraud, a manual hold). */
export async function suspendLicense(tenantId: string, input: unknown): Promise<License> {
  const parsed = licenseSuspendSchema.parse(input);
  await getLicenseByTenant(tenantId);
  return prisma.license.update({
    where: { tenantId },
    data: { status: "SUSPENDED", suspensionReason: parsed.reason },
  });
}

export async function reactivateLicense(tenantId: string): Promise<License> {
  await getLicenseByTenant(tenantId);
  return prisma.license.update({
    where: { tenantId },
    data: { status: "ACTIVE", suspensionReason: null },
  });
}

/** Called after ANY payment lands PAID — the manual admin "Record Payment" flow and the self-serve
 * platform-billing STK flow both funnel through this, so "pay and get back in immediately" works
 * identically no matter which path collected the money. Deliberately narrow: only reactivates a
 * license the automatic billing scheduler suspended for being overdue (suspensionReason ===
 * PAYMENT_OVERDUE) — a license an admin suspended for FRAUD/MANUAL/CUSTOMER_REQUESTED must stay
 * suspended even if a payment somehow comes in; a payment should never silently undo a deliberate
 * human decision to lock someone out for a different reason. No-op (not an error) if the license
 * isn't currently suspended for that reason at all — the common case for most payments.
 *
 * CRITICAL: only actually reactivates if the subscription's nextDueDate is now genuinely caught up
 * (>= today). Previously this reactivated on ANY successful payment regardless of how much backlog
 * remained — a tenant who owed 3 months and paid only 1 got fully unlocked anyway, even though the
 * payment calendar still showed the other 2 as overdue. This is the actual enforcement point for
 * "you must clear everything owed to get back in," not just a courtesy check. */
export async function reactivateIfPaymentOverdue(tenantId: string): Promise<void> {
  const license = await prisma.license.findUnique({
    where: { tenantId },
    include: { tenant: { include: { subscription: true } } },
  });
  if (!license || license.status !== "SUSPENDED" || license.suspensionReason !== "PAYMENT_OVERDUE") {
    return;
  }
  const nextDueDate = license.tenant.subscription?.nextDueDate ?? null;
  if (nextDueDate && nextDueDate < new Date()) {
    return; // Still behind — a payment came in, but it didn't clear the whole backlog.
  }
  await prisma.license.update({
    where: { tenantId },
    data: { status: "ACTIVE", suspensionReason: null },
  });
}

/** General-purpose edit for cases suspend/reactivate don't cover — e.g. moving TRIAL → ACTIVE
 * directly (no payment-driven trigger for that exists yet), setting CANCELLED outright, or
 * setting/clearing a trial end date. suspensionReason only persists when status is SUSPENDED. */
export async function updateLicense(tenantId: string, input: unknown): Promise<License> {
  const parsed = licenseUpdateSchema.parse(input);
  await getLicenseByTenant(tenantId);
  return prisma.license.update({
    where: { tenantId },
    data: {
      status: parsed.status,
      suspensionReason: parsed.status === "SUSPENDED" ? parsed.suspensionReason : null,
      trialEndsAt: parsed.trialEndsAt,
    },
  });
}
