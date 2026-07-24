import { HttpError, NotFoundError } from "../lib/http-error.js";
import { assertLicenseUsable } from "../lib/license-guard.js";
import { verifySecret } from "../lib/password-hash.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { signMobileToken } from "../middleware/mobile-auth.js";
import { prisma } from "../prisma.js";
import { mobileLoginSchema } from "../schemas/mobile.js";

/** Mirrors DESKTOP's own auth-service.ts numbers exactly (MAX_FAILED_ATTEMPTS/LOCKOUT_MINUTES) —
 * see MobileLoginAttempt's own schema comment for why this is a dedicated server-side counter
 * rather than reusing Employee's local-only lockout fields. */
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

async function recordFailedAttempt(tenantId: string, employeeCode: string): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    const existing = await tx.mobileLoginAttempt.findUnique({
      where: { tenantId_employeeCode: { tenantId, employeeCode } },
    });
    const nextAttempts = (existing?.failedAttempts ?? 0) + 1;
    const lockedUntil = nextAttempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
    await tx.mobileLoginAttempt.upsert({
      where: { tenantId_employeeCode: { tenantId, employeeCode } },
      create: { tenantId, employeeCode, failedAttempts: nextAttempts, lockedUntil },
      update: { failedAttempts: nextAttempts, lockedUntil },
    });
  });
}

async function resetFailedAttempts(tenantId: string, employeeCode: string): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    tx.mobileLoginAttempt.upsert({
      where: { tenantId_employeeCode: { tenantId, employeeCode } },
      create: { tenantId, employeeCode, failedAttempts: 0, lockedUntil: null },
      update: { failedAttempts: 0, lockedUntil: null },
    }),
  );
}

export type MobileLoginResult = { token: string };

/** Owner App login — the same employeeCode + PIN an employee already uses on the DESKTOP POS,
 * resolved to a tenant via licenseKey (same credential DESKTOP's own activation already uses, no
 * separate Blue Ledger Account involved). Read-only from here on: this never creates a Device row
 * or consumes the tenant's device quota — see mobile-auth.ts's MobileSession for why this is a
 * categorically different session type. */
export async function loginMobile(input: unknown): Promise<MobileLoginResult> {
  const parsed = mobileLoginSchema.parse(input);
  // Lowercased once and reused as the MobileLoginAttempt key — "emp-001" and "EMP-001" must share
  // the same lockout bucket, or varying case would let someone dodge the attempt counter entirely.
  const employeeCodeKey = parsed.employeeCode.toLowerCase();

  const license = await prisma.license.findUnique({ where: { licenseKey: parsed.licenseKey } });
  if (!license) {
    throw new NotFoundError("Invalid license key");
  }
  assertLicenseUsable(license);
  const { tenantId } = license;

  const lockState = await withTenantContext(tenantId, (tx) =>
    tx.mobileLoginAttempt.findUnique({ where: { tenantId_employeeCode: { tenantId, employeeCode: employeeCodeKey } } }),
  );
  if (lockState?.lockedUntil && lockState.lockedUntil.getTime() > Date.now()) {
    throw new HttpError(
      403,
      `Too many failed attempts. Try again after ${lockState.lockedUntil.toISOString()}.`,
    );
  }

  // Case-insensitive, matching DESKTOP's own findEmployeeByCodeRow (`lower(employee_code) =
  // lower(?)`) — "emp-001" and "EMP-001" must behave identically here too.
  const employee = await withTenantContext(tenantId, (tx) =>
    tx.employee.findFirst({ where: { tenantId, employeeCode: { equals: parsed.employeeCode, mode: "insensitive" } } }),
  );
  if (!employee) {
    throw new HttpError(401, "Invalid employee code or PIN");
  }
  if (employee.status !== "active") {
    throw new HttpError(403, `This account is ${employee.status} and can't sign in. Contact your Super Admin.`);
  }

  const pinValid = employee.pinHash ? verifySecret(parsed.pin, employee.pinHash) : false;
  if (!pinValid) {
    await recordFailedAttempt(tenantId, employeeCodeKey);
    throw new HttpError(401, "Invalid employee code or PIN");
  }

  const role = employee.roleId
    ? await withTenantContext(tenantId, (tx) => tx.role.findUnique({ where: { id: employee.roleId as string } }))
    : null;
  const permissions = (role?.permissionsJson as Record<string, string[]> | undefined) ?? {};
  if (!permissions.owner_app?.includes("view")) {
    throw new HttpError(403, "Your account doesn't have access to the Owner App — ask your Super Admin to grant it.");
  }

  await resetFailedAttempts(tenantId, employeeCodeKey);
  const token = signMobileToken({ employeeId: employee.id, tenantId });
  return { token };
}
