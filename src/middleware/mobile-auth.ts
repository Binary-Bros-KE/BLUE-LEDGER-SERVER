import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { computeWorkingHoursLockStatus, type WorkingHoursConfig } from "../lib/working-hours-lock.js";

/** The Owner App's session identity — a tenant Employee, never a Blue Ledger Account. Deliberately
 * a different shape from AuthenticatedAccount (middleware/auth.ts): no role/outletId, has tenantId
 * (which an Account token never carries), so the two token systems can never be confused for one
 * another even before the `aud` check below. `permissions`/`isSuperAdmin` are populated by
 * requireOwnerAppAccess so later middleware/routes on the same request chain can reuse them instead
 * of re-fetching. */
export type MobileSession = { employeeId: string; tenantId: string; permissions?: Record<string, string[]>; isSuperAdmin?: boolean };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mobileSession?: MobileSession;
    }
  }
}

type MobileTokenPayload = { sub: string; tenantId: string; aud: "owner-app" };

const MOBILE_TOKEN_EXPIRY = "7d";

/** 7 days is generous — long enough an owner isn't re-entering their PIN often — but this only
 * governs "how often you log back in", never "how long a revoked credential stays valid": every
 * request also runs requireOwnerAppAccess below, which re-checks the employee's live status and
 * permission on every call, so a suspension or a revoked owner_app grant takes effect immediately,
 * regardless of how much of the 7 days is left. */
export function signMobileToken(session: MobileSession): string {
  return jwt.sign({ sub: session.employeeId, tenantId: session.tenantId, aud: "owner-app" }, env.JWT_SECRET, {
    expiresIn: MOBILE_TOKEN_EXPIRY,
  });
}

/** Verifies the Bearer JWT and attaches req.mobileSession. Does NOT check permissions or employee
 * status — see requireOwnerAppAccess for the live recheck that must always run alongside this. */
export function requireMobileAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    throw new HttpError(401, "Missing or invalid Authorization header");
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as MobileTokenPayload;
    if (payload.aud !== "owner-app") {
      throw new Error("Wrong token audience");
    }
    req.mobileSession = { employeeId: payload.sub, tenantId: payload.tenantId };
    next();
  } catch {
    throw new HttpError(401, "Invalid or expired session — log in again");
  }
}

/** Must run after requireMobileAuth. Re-fetches the Employee + their Role live on every request
 * (same withTenantContext discipline as every other RLS-protected read) rather than trusting
 * whatever the JWT said at login time — a suspended employee is locked out on their very next
 * request, not whenever the 7-day token happens to expire. Any active employee may open the app;
 * there is no separate "owner_app" gate any more (removed 2026-08-25) — per-tab/per-action scoping
 * (visibleNavGroups in APP, requireMobilePermission below) already controls what they can see or
 * do once inside, so a second all-or-nothing gate on top of that was redundant. Still populates
 * session.permissions so requireMobilePermission can reuse it instead of re-fetching.
 *
 * Also enforces the Working Hours lockout — a Super Admin (role.isSuperAdmin) always passes
 * regardless of the storefront's schedule/manual-lock state; every other employee assigned to a
 * storefront (employee.branchId) gets 403'd here the moment it's locked, on their very next request,
 * same "checked live every time, not just at login" discipline as the active-employee check above.
 * This single insertion point covers every one of this router's ~40+ protected routes for free —
 * every one of them already chains requireOwnerAppAccess right after requireMobileAuth. A
 * branch-less employee has no storefront to check against and is never locked by this. */
export async function requireOwnerAppAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const session = req.mobileSession;
  if (!session) {
    throw new HttpError(401, "Not authenticated");
  }

  await withTenantContext(session.tenantId, async (tx) => {
    const employee = await tx.employee.findUnique({ where: { id: session.employeeId } });
    if (!employee || employee.status !== "active") {
      throw new HttpError(403, "This account is no longer active. Contact your Super Admin.");
    }

    const role = employee.roleId ? await tx.role.findUnique({ where: { id: employee.roleId } }) : null;
    session.permissions = (role?.permissionsJson as Record<string, string[]> | undefined) ?? {};
    session.isSuperAdmin = role?.isSuperAdmin ?? false;

    if (!session.isSuperAdmin && employee.branchId) {
      const workingHours = await tx.workingHours.findFirst({ where: { locationId: employee.branchId } });
      const status = computeWorkingHoursLockStatus(workingHours as unknown as WorkingHoursConfig | null);
      if (status.locked) {
        throw new HttpError(403, "This system is locked outside working hours. Contact your Super Admin.", "WORKING_HOURS_LOCKED");
      }
    }
  });

  next();
}

/** Gates a specific action (e.g. "sales"/"create" for mobile checkout) beyond the base
 * owner_app.view an employee needs just to open the app — same module+action vocabulary DESKTOP's
 * own requirePermission uses, so granting a role mobile-checkout access is just a normal Roles &
 * Permissions edit, nothing mobile-specific to configure. Must run after requireMobileAuth; reuses
 * req.mobileSession.permissions when requireOwnerAppAccess already populated it earlier in the same
 * chain (the normal case — see routes/mobile.ts), otherwise does its own live re-fetch so this is
 * still safe to use standalone. */
export function requireMobilePermission(module: string, action: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const session = req.mobileSession;
    if (!session) {
      throw new HttpError(401, "Not authenticated");
    }

    let permissions = session.permissions;
    if (!permissions) {
      permissions = await withTenantContext(session.tenantId, async (tx) => {
        const employee = await tx.employee.findUnique({ where: { id: session.employeeId } });
        if (!employee || employee.status !== "active") {
          throw new HttpError(403, "This account is no longer active. Contact your Super Admin.");
        }
        const role = employee.roleId ? await tx.role.findUnique({ where: { id: employee.roleId } }) : null;
        return (role?.permissionsJson as Record<string, string[]> | undefined) ?? {};
      });
      session.permissions = permissions;
    }

    if (!permissions[module]?.includes(action)) {
      throw new HttpError(403, `Your account doesn't have "${action}" access to ${module} — ask your Super Admin to grant it.`);
    }
    next();
  };
}

/** Gates the Working Hours configuration routes — deliberately NOT a module/action permission like
 * requireMobilePermission above (see the feature's own design notes: this is inherently a
 * Super-Admin-exclusive control, not something a tenant should be able to delegate via the normal
 * Roles & Permissions grid). Must run after requireOwnerAppAccess, whose session.isSuperAdmin this
 * reuses — zero extra queries. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.mobileSession?.isSuperAdmin) {
    throw new HttpError(403, "Only your Super Admin can access this.");
  }
  next();
}
