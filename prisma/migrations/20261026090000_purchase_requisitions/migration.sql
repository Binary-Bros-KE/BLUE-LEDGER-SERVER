-- CreateTable
CREATE TABLE "purchase_requisitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "requisitionNumber" TEXT NOT NULL,
    "storefrontId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "rejectionReason" TEXT,
    "purchaseId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "items" JSONB NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_requisitions_tenantId_idx" ON "purchase_requisitions"("tenantId");

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — same as every other synced table (see 20260806140000_stock_receipts).
ALTER TABLE "purchase_requisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_requisitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_requisitions"
  USING ("tenantId" = current_setting('app.tenant_id', true));
