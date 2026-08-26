-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "working_hours" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "lockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lockMode" TEXT NOT NULL DEFAULT 'auto',
    "manuallyLocked" BOOLEAN NOT NULL DEFAULT false,
    "timezoneOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "schedule" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "working_hours_tenantId_idx" ON "working_hours"("tenantId");

-- CreateIndex
CREATE INDEX "working_hours_locationId_idx" ON "working_hours"("locationId");

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity (both ENABLE and FORCE are required — a prior migration once forgot FORCE and
-- silently no-op'd RLS on that table; see the locations migration's own corrective-fix comment)
ALTER TABLE "working_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "working_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "working_hours"
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- NOTE: the isSuperAdmin backfill for existing tenants is NOT done here — "roles" has
-- FORCE ROW LEVEL SECURITY (see the locations migration), so a plain UPDATE with no
-- app.tenant_id GUC set matches zero rows silently, even for the migration's own privileged DB
-- role. Run scripts/backfill-super-admin-flag.ts once after this migration instead — it loops
-- every tenant through withTenantContext so each UPDATE actually sets the GUC RLS checks against.
