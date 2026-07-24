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
