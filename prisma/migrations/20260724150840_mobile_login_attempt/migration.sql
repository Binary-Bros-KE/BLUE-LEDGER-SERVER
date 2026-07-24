-- CreateTable
CREATE TABLE "mobile_login_attempts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mobile_login_attempts_tenantId_employeeCode_key" ON "mobile_login_attempts"("tenantId", "employeeCode");

-- AddForeignKey
ALTER TABLE "mobile_login_attempts" ADD CONSTRAINT "mobile_login_attempts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity
-- Hand-added, same convention as every other tenant-scoped table (see the sync_phase1_reference_data
-- migration's own comment for the full FORCE-vs-ENABLE reasoning). This table isn't a synced entity,
-- but it's still queried by tenantId inside mobile-auth-service.ts, so it gets the exact same
-- fail-closed policy as everything else rather than being an unguarded exception.
ALTER TABLE "mobile_login_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mobile_login_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mobile_login_attempts"
  USING ("tenantId" = current_setting('app.tenant_id', true));
