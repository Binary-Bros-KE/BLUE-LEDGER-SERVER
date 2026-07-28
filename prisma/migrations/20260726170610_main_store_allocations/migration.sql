-- CreateTable
CREATE TABLE "main_store_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storefrontId" TEXT,
    "quantity" INTEGER NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "main_store_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "main_store_allocations_tenantId_idx" ON "main_store_allocations"("tenantId");

-- AddForeignKey
ALTER TABLE "main_store_allocations" ADD CONSTRAINT "main_store_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Natural-key uniqueness (mirrors DESKTOP's own idx_main_store_allocations_bucket_key) — same
-- server-side dedup-at-push-time convention every boot-seeded reference entity already has (see
-- sync-service.ts's NATURAL_KEY_FIELDS): two devices that each first push their own copy of the same
-- real (product, storefront) bucket get reconciled via the "aliased" push result, never two rows.
CREATE UNIQUE INDEX "main_store_allocations_tenantId_bucketKey_key" ON "main_store_allocations"("tenantId", "bucketKey");

-- Row-Level Security — ENABLE + FORCE (the app connects as the table-owning role, which Postgres
-- exempts from RLS by default) + current_setting's missing_ok=true (so a query outside
-- withTenantContext fails closed with zero rows instead of hard-erroring).
ALTER TABLE "main_store_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "main_store_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "main_store_allocations"
  USING ("tenantId" = current_setting('app.tenant_id', true));
