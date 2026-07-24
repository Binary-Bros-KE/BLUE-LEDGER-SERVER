-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "movementType" TEXT NOT NULL,
    "quantityChange" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "performedBy" TEXT,
    "notes" TEXT,
    "allocationStorefrontId" TEXT,
    "allocationExplicit" BOOLEAN NOT NULL DEFAULT false,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_idx" ON "stock_movements"("tenantId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — checklist from prior phases (missed pieces of this twice before, see project
-- memory): ENABLE alone is not enough because the app connects as the table-owning role
-- (blueledger_app), which Postgres exempts from RLS by default, so FORCE is required too; and
-- current_setting's second (missing_ok) argument must be true, or any query running outside
-- withTenantContext() hard-ERRORs instead of failing closed with zero rows.
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_movements"
  USING ("tenantId" = current_setting('app.tenant_id', true));
