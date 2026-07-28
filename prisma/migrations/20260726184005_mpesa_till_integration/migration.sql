-- CreateTable
CREATE TABLE "mpesa_till_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "consumerKey" TEXT NOT NULL,
    "consumerSecret" TEXT NOT NULL,
    "passkey" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "tillNumber" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mpesa_till_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mpesa_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "merchantRequestId" TEXT NOT NULL,
    "checkoutRequestId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "accountReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultCode" INTEGER,
    "resultDescription" TEXT,
    "mpesaReceiptNumber" TEXT,
    "transactionDate" TEXT,
    "initiatedByEmployeeId" TEXT,
    "initiatedByDeviceId" TEXT,
    "lastQueriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_till_settings_locationId_key" ON "mpesa_till_settings"("locationId");

-- CreateIndex
CREATE INDEX "mpesa_till_settings_tenantId_idx" ON "mpesa_till_settings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_transactions_checkoutRequestId_key" ON "mpesa_transactions"("checkoutRequestId");

-- CreateIndex
CREATE INDEX "mpesa_transactions_tenantId_idx" ON "mpesa_transactions"("tenantId");

-- CreateIndex
CREATE INDEX "mpesa_transactions_checkoutRequestId_idx" ON "mpesa_transactions"("checkoutRequestId");

-- AddForeignKey
ALTER TABLE "mpesa_till_settings" ADD CONSTRAINT "mpesa_till_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — ENABLE + FORCE (the app connects as the table-owning role, which Postgres
-- exempts from RLS by default) + current_setting's missing_ok=true (so a query outside
-- withTenantContext fails closed with zero rows instead of hard-erroring).
ALTER TABLE "mpesa_till_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mpesa_till_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mpesa_till_settings"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "mpesa_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mpesa_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mpesa_transactions"
  USING ("tenantId" = current_setting('app.tenant_id', true));
