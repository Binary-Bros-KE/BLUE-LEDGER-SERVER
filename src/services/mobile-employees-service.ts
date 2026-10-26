import { randomUUID } from "node:crypto";
import type { Employee, Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { hashSecret } from "../lib/password-hash.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import {
  type MobileCreateEmployeeInput,
  type MobileEmployeeAccessInput,
  mobileCreateEmployeeSchema,
  mobileEmployeeAccessSchema,
  mobileEmployeePinResetSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

/** System-access management for the Owner App's Employees tab — add a staff member, change their
 * PIN, suspend/reactivate/terminate them, move them to another role or storefront. Everything
 * HR-shaped (DOB, department, salary defaults, photo) deliberately stays on DESKTOP's full form.
 *
 * Every write here lands in the EXACT shape DESKTOP's own employees push already produces (same
 * `employee_` id prefix, same uppercased employeeCode, same `cost:salt:derived` pinHash), stamped
 * deviceId "owner-app" with a fresh localUpdatedAt AND syncedAt — syncedAt is what DESKTOP's pull
 * cursor reads (see sync-service.ts's pullRows), so leaving it at its create-time default would mean
 * a suspension never reaches any desktop. A desktop holding its own unsynced edit to the same
 * employee gets a normal "conflict" on its next push (employees are conflict-aware via
 * baseUpdatedAt) instead of silently overwriting this change.
 *
 * Suspending takes effect on the Owner App immediately (requireOwnerAppAccess re-checks status on
 * every request) and on each DESKTOP at its next pull. */

export type MobileRole = { id: string; roleName: string; isSuperAdmin: boolean };

export async function listRoles(tenantId: string): Promise<MobileRole[]> {
  return withTenantContext(tenantId, (tx) =>
    tx.role.findMany({
      where: { tenantId },
      select: { id: true, roleName: true, isSuperAdmin: true },
      orderBy: { roleName: "asc" },
    }),
  );
}

/** Mirrors DESKTOP's own getCurrentBranchScope rule (employee-service.ts's
 * assertBranchAssignmentAllowed): a branch-scoped actor only ever manages their own branch's staff,
 * and can only assign people TO that branch — never elsewhere, never "no branch" (which would grant
 * cross-storefront visibility). A Super Admin is never branch-scoped for this purpose, even if they
 * happen to have a branchId set. */
function branchScopeOf(actor: Employee, actorIsSuperAdmin: boolean): string | null {
  return actorIsSuperAdmin ? null : actor.branchId;
}

async function isSuperAdminRole(tx: Prisma.TransactionClient, roleId: string | null): Promise<boolean> {
  if (!roleId) return false;
  const role = await tx.role.findUnique({ where: { id: roleId }, select: { isSuperAdmin: true } });
  return role?.isSuperAdmin ?? false;
}

async function assertRoleBelongsToTenant(tx: Prisma.TransactionClient, tenantId: string, roleId: string): Promise<{ isSuperAdmin: boolean }> {
  const role = await tx.role.findUnique({ where: { id: roleId } });
  if (!role || role.tenantId !== tenantId) throw new NotFoundError("Selected role was not found");
  return { isSuperAdmin: role.isSuperAdmin };
}

async function assertBranchBelongsToTenant(tx: Prisma.TransactionClient, tenantId: string, branchId: string | null): Promise<void> {
  if (!branchId) return;
  const location = await tx.location.findUnique({ where: { id: branchId } });
  if (!location || location.tenantId !== tenantId) throw new NotFoundError("Selected storefront was not found");
}

function assertBranchAssignmentAllowed(branchId: string | null, branchScope: string | null): void {
  if (!branchScope) return;
  if (branchId !== branchScope) throw new HttpError(403, "You can only assign employees to your own storefront");
}

/** Loads the target employee and applies the rules every mutation here shares: same tenant, inside
 * the actor's branch scope, and a Super Admin can only ever be managed by another Super Admin (a
 * Manager with employees.edit must never be able to lock the owner out of their own business). */
async function loadManageableEmployee(
  tx: Prisma.TransactionClient,
  session: MobileSession,
  actor: Employee,
  targetId: string,
): Promise<Employee> {
  const target = await tx.employee.findUnique({ where: { id: targetId } });
  if (!target || target.tenantId !== session.tenantId) throw new NotFoundError("Employee not found");

  const scope = branchScopeOf(actor, session.isSuperAdmin ?? false);
  if (scope && target.branchId !== scope) throw new HttpError(403, "You can only manage employees in your own storefront");

  if (!session.isSuperAdmin && (await isSuperAdminRole(tx, target.roleId))) {
    throw new HttpError(403, "Only a Super Admin can change a Super Admin's access");
  }
  return target;
}

export async function createEmployee(session: MobileSession, input: unknown): Promise<{ id: string }> {
  const parsed: MobileCreateEmployeeInput = mobileCreateEmployeeSchema.parse(input);
  // Hashed before opening the transaction — scrypt at cost 32768 takes ~150ms, no reason to hold a
  // tenant-scoped transaction open for it.
  const pinHash = hashSecret(parsed.pin);
  const now = new Date();

  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
    const role = await assertRoleBelongsToTenant(tx, session.tenantId, parsed.roleId);
    if (role.isSuperAdmin && !session.isSuperAdmin) throw new HttpError(403, "Only a Super Admin can create another Super Admin");
    await assertBranchBelongsToTenant(tx, session.tenantId, parsed.branchId);
    assertBranchAssignmentAllowed(parsed.branchId, branchScopeOf(actor, session.isSuperAdmin ?? false));

    const duplicate = await tx.employee.findFirst({
      where: { tenantId: session.tenantId, employeeCode: parsed.employeeCode },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`Employee code "${parsed.employeeCode}" is already in use`);

    const created = await tx.employee.create({
      data: {
        id: `employee_${randomUUID()}`,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        employeeCode: parsed.employeeCode,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        phone: parsed.phone,
        roleId: parsed.roleId,
        branchId: parsed.branchId,
        status: "active",
        pinHash,
        defaultAllowancesJson: [],
        defaultDeductionsJson: [],
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: { id: true },
    });
    return created;
  });
}

export async function updateEmployeeAccess(session: MobileSession, targetId: string, input: unknown): Promise<{ id: string }> {
  const parsed: MobileEmployeeAccessInput = mobileEmployeeAccessSchema.parse(input);
  const now = new Date();

  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
    const target = await loadManageableEmployee(tx, session, actor, targetId);

    // Self-lockout guard: suspending yourself or dropping your own role would end this very session
    // with no way back in from the phone.
    if (target.id === actor.id && (parsed.status !== undefined || parsed.roleId !== undefined)) {
      throw new HttpError(400, "You can't change your own status or role — ask another admin");
    }

    if (parsed.roleId !== undefined) {
      const role = await assertRoleBelongsToTenant(tx, session.tenantId, parsed.roleId);
      if (role.isSuperAdmin && !session.isSuperAdmin) throw new HttpError(403, "Only a Super Admin can grant the Super Admin role");
    }
    if (parsed.branchId !== undefined) {
      await assertBranchBelongsToTenant(tx, session.tenantId, parsed.branchId);
      assertBranchAssignmentAllowed(parsed.branchId, branchScopeOf(actor, session.isSuperAdmin ?? false));
    }

    await tx.employee.update({
      where: { id: target.id },
      data: {
        ...(parsed.roleId !== undefined ? { roleId: parsed.roleId } : {}),
        ...(parsed.branchId !== undefined ? { branchId: parsed.branchId } : {}),
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id: target.id };
  });
}

/** Also clears this employee's Owner App login lockout (MobileLoginAttempt) — the usual reason an
 * owner resets a PIN is that the staff member forgot it and has already locked themselves out. Any
 * employee may reset their OWN PIN through this same route (see routes/mobile.ts). */
export async function resetEmployeePin(session: MobileSession, targetId: string, input: unknown): Promise<{ id: string }> {
  const { pin } = mobileEmployeePinResetSchema.parse(input);
  const pinHash = hashSecret(pin);
  const now = new Date();

  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
    const target = targetId === actor.id ? actor : await loadManageableEmployee(tx, session, actor, targetId);

    await tx.employee.update({
      where: { id: target.id },
      data: { pinHash, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    // Same lowercased key mobile-auth-service.ts's loginMobile uses for this counter.
    await tx.mobileLoginAttempt.updateMany({
      where: { tenantId: session.tenantId, employeeCode: target.employeeCode.toLowerCase() },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return { id: target.id };
  });
}
