-- CreateTable
CREATE TABLE "stock_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "allocationStorefrontId" TEXT,
    "receivedBy" TEXT NOT NULL,
    "notes" TEXT,
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_receipts_tenantId_idx" ON "stock_receipts"("tenantId");

-- AddForeignKey
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — ENABLE + FORCE (the app connects as the table-owning role, which Postgres
-- exempts from RLS by default) + current_setting's missing_ok=true (so a query outside
-- withTenantContext fails closed with zero rows instead of hard-erroring).
ALTER TABLE "stock_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_receipts"
  USING ("tenantId" = current_setting('app.tenant_id', true));
