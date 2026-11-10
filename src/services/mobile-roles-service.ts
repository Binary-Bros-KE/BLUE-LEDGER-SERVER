import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import { mobileRoleInputSchema } from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";
import { defaultPermissionsForRole, PERMISSION_MODULES } from "./tenant-defaults-service.js";

/**
 * Roles & Permissions on the phone — DESKTOP's RolesRoute/role-service.ts: list roles, create one,
 * edit a role's name, description and permission toggles, and "Restore defaults" on a built-in role.
 *
 * Same rules as DESKTOP: a built-in (system) role keeps its name; the Super Admin role always has
 * every permission, so it can't be edited. One extra guard DESKTOP doesn't have: nobody but a Super
 * Admin may change the permissions of the role they're signed in with — doing it from a phone could
 * lock them out of the very screen that would undo it. No delete: DESKTOP refuses to delete a role
 * once synced, and every role a phone can see has been.
 *
 * Writes land in DESKTOP's own shape (`role_` id, permissions JSON), stamped deviceId "owner-app" with
 * fresh localUpdatedAt AND syncedAt so every desktop pulls the change.
 */

export type MobileRoleDetail = {
  id: string;
  roleName: string;
  description: string | null;
  permissions: Record<string, string[]>;
  isSystemRole: boolean;
  isSuperAdmin: boolean;
  employeeCount: number;
  /** What "Restore defaults" sets this role back to; null for a custom role. */
  defaultPermissions: Record<string, string[]> | null;
};

/** A role's stored permissions as DESKTOP reads them: a role saved before Purchase Requisitions
 * existed gets that module computed (DESKTOP shared/lib/role-defaults.ts withLaterModuleDefaults),
 * so the phone shows exactly what the role can actually do. */
function asPermissions(raw: Prisma.JsonValue): Record<string, string[]> {
  const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string[]>) : {};
  if (stored.purchase_requisitions !== undefined) return stored;
  return { ...stored, purchase_requisitions: stored.purchases?.includes("approve") ? ["view", "create", "approve"] : ["view", "create"] };
}

/** Drops unknown modules and actions that don't apply to a module — DESKTOP's sanitizePermissions.
 * An empty list is kept: it's an explicit "nothing here", which DESKTOP's read-time defaults respect. */
function sanitizePermissions(input: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, actions] of Object.entries(input)) {
    const allowed = PERMISSION_MODULES[key];
    if (!allowed) continue;
    out[key] = [...new Set(actions.filter((action) => allowed.includes(action)))];
  }
  return out;
}

export async function listRoles(tenantId: string): Promise<MobileRoleDetail[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [roles, counts] = await Promise.all([
      tx.role.findMany({ where: { tenantId }, orderBy: { roleName: "asc" } }),
      tx.employee.groupBy({ by: ["roleId"], where: { tenantId }, _count: { _all: true } }),
    ]);
    const countByRole = new Map(counts.map((c) => [c.roleId, c._count._all]));
    return roles.map((role) => ({
      id: role.id,
      roleName: role.roleName,
      description: role.description,
      permissions: asPermissions(role.permissionsJson),
      isSystemRole: role.isSystemRole,
      isSuperAdmin: role.isSuperAdmin,
      employeeCount: countByRole.get(role.id) ?? 0,
      defaultPermissions: role.isSystemRole && !role.isSuperAdmin ? defaultPermissionsForRole(role.roleName) : null,
    }));
  });
}

async function assertNameFree(tx: Prisma.TransactionClient, tenantId: string, roleName: string, excludeId?: string): Promise<void> {
  const duplicate = await tx.role.findFirst({
    where: { tenantId, roleName: { equals: roleName, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (duplicate) throw new ConflictError(`A role named "${roleName}" already exists`);
}

export async function createRole(session: MobileSession, input: unknown): Promise<{ id: string }> {
  const parsed = mobileRoleInputSchema.parse(input);
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    await assertNameFree(tx, session.tenantId, parsed.roleName);
    const id = `role_${randomUUID()}`;
    await tx.role.create({
      data: {
        id,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        roleName: parsed.roleName,
        description: parsed.description,
        permissionsJson: sanitizePermissions(parsed.permissions),
        isSystemRole: false,
        isSuperAdmin: false,
        localCreatedAt: now,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id };
  });
}

export async function updateRole(session: MobileSession, roleId: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileRoleInputSchema.parse(input);
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId } });
    if (!role || role.tenantId !== session.tenantId) throw new NotFoundError("Role not found");
    if (role.isSuperAdmin) throw new HttpError(400, "The Super Admin role always has every permission, so it can't be edited");
    if (role.isSystemRole && parsed.roleName.trim().toLowerCase() !== role.roleName.toLowerCase()) {
      throw new HttpError(400, "A built-in role keeps its name");
    }
    if (!session.isSuperAdmin) {
      const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId }, select: { roleId: true } });
      if (actor.roleId === role.id) throw new HttpError(403, "You can't change your own role's permissions — ask a Super Admin");
    }
    await assertNameFree(tx, session.tenantId, parsed.roleName, role.id);
    await tx.role.update({
      where: { id: role.id },
      data: {
        roleName: role.isSystemRole ? role.roleName : parsed.roleName,
        description: parsed.description,
        permissionsJson: sanitizePermissions(parsed.permissions),
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id: role.id };
  });
}
