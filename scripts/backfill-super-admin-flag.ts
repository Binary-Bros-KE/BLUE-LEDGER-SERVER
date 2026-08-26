/**
 * One-time backfill: sets Role.isSuperAdmin = true for every tenant's existing seeded "Super Admin"
 * role. Needed because the migration that added this column (20260826091122_working_hours_lockout)
 * couldn't do this itself — "roles" has FORCE ROW LEVEL SECURITY, so a plain UPDATE with no
 * app.tenant_id GUC set silently matches zero rows even for the migration's own privileged DB role.
 * This loops every tenant through withTenantContext instead, so each UPDATE actually sets the GUC
 * RLS checks against.
 *
 * Run once after deploying that migration to any environment (dev, staging, production):
 *   npx tsx scripts/backfill-super-admin-flag.ts
 *
 * Safe to re-run — every UPDATE is already scoped to rows where isSuperAdmin is still false.
 */
import { withTenantContext } from "../src/lib/tenant-context.js";
import { prisma } from "../src/prisma.js";

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let fixed = 0;

  for (const tenant of tenants) {
    const result = await withTenantContext(tenant.id, (tx) =>
      tx.role.updateMany({
        where: { tenantId: tenant.id, roleName: "Super Admin", isSystemRole: true, isSuperAdmin: false },
        data: { isSuperAdmin: true },
      }),
    );
    if (result.count > 0) {
      fixed += result.count;
      console.log(`  ${tenant.name} (${tenant.id}): flagged ${result.count} role row(s)`);
    }
  }

  console.log(`Done — ${fixed} role row(s) backfilled across ${tenants.length} tenant(s).`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
