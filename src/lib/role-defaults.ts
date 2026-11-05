/**
 * SERVER copy of DESKTOP's shared/lib/role-defaults.ts — the two MUST stay identical, so a role
 * means the same thing on a till and on the phone. Fills in permission modules added after a role
 * was saved, computed from what the role already has, every time a role is read for a mobile
 * session (middleware/mobile-auth.ts, /mobile/me).
 *
 * Read-time rather than written into Role.permissionsJson because roles sync from the tills: a
 * server-side rewrite would be overwritten by the next push from any device, and an explicit value
 * saved by an admin in Roles & Permissions (even an empty list) must always win — it does here,
 * since only an ABSENT key gets a default.
 */
export function withLaterModuleDefaults(permissions: Record<string, string[]>): Record<string, string[]> {
  if (permissions.purchase_requisitions !== undefined) return permissions;

  // Client spec: anybody can raise a requisition; only higher roles approve. "Can already approve
  // purchases" stands in for "higher role" (Manager by default — Super Admin passes every check anyway).
  const canApprovePurchases = permissions.purchases?.includes("approve") ?? false;
  return {
    ...permissions,
    purchase_requisitions: canApprovePurchases ? ["view", "create", "approve"] : ["view", "create"],
  };
}

/** Role.permissionsJson → a permissions map with later-module defaults applied. */
export function rolePermissions(permissionsJson: unknown): Record<string, string[]> {
  return withLaterModuleDefaults((permissionsJson as Record<string, string[]> | undefined | null) ?? {});
}
