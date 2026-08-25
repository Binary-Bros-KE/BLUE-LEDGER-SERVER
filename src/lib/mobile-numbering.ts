import type { Prisma } from "@prisma/client";

/** Server-side equivalent of DESKTOP's document-number-service.ts generateDocumentNumber — mints
 * the numeric part atomically from MobileDocumentCounter (see that model's own schema comment for
 * why this can't be a local client-side reduce the way DESKTOP does it) and combines it with the
 * employee's own permanent "M{N}" tag. Must run inside the caller's own transaction so a failed
 * write can never "burn" a number that was never actually used. Shared by every mobile-minted
 * number scheme (sale receipts "BL", delivery notes "DN", customer codes "CUST") — one counter row
 * per (tenantId, prefix), same as DESKTOP's own per-prefix numbering never collides across prefixes. */
export async function mintMobileDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeMobileSequence: number,
  prefix: string,
  digits: number,
): Promise<string> {
  const counter = await tx.mobileDocumentCounter.upsert({
    where: { tenantId_prefix: { tenantId, prefix } },
    create: { tenantId, prefix, nextNumber: 2 },
    update: { nextNumber: { increment: 1 } },
  });
  const claimedNumber = counter.nextNumber - 1;
  return `${prefix}-M${employeeMobileSequence}-${String(claimedNumber).padStart(digits, "0")}`;
}

/** Every mobile-minted number needs the calling employee's own permanent M-tag first — normally
 * already leased at login (mobile-auth-service.ts's ensureMobileDeviceSequence), this is the
 * defensive re-lease for a 7-day JWT issued before that existed, shared by every write path that
 * mints a number (checkout, quick-create customer). */
export async function ensureEmployeeMobileSequence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  existingSequence: number | null,
): Promise<number> {
  if (existingSequence !== null) return existingSequence;
  const updatedTenant = await tx.tenant.update({
    where: { id: tenantId },
    data: { nextMobileDeviceSequence: { increment: 1 } },
  });
  const mobileDeviceSequence = updatedTenant.nextMobileDeviceSequence - 1;
  await tx.employee.update({ where: { id: employeeId }, data: { mobileDeviceSequence } });
  return mobileDeviceSequence;
}
