-- CreateTable
CREATE TABLE "invoice_cancellations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_cancellations_tenantId_idx" ON "invoice_cancellations"("tenantId");

-- AddForeignKey
ALTER TABLE "invoice_cancellations" ADD CONSTRAINT "invoice_cancellations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity
ALTER TABLE "invoice_cancellations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_cancellations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoice_cancellations"
  USING ("tenantId" = current_setting('app.tenant_id', true));
