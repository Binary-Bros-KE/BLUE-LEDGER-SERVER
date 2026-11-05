-- AlterTable
ALTER TABLE "mpesa_till_settings" ADD COLUMN "verificationMode" TEXT NOT NULL DEFAULT 'loose';
ALTER TABLE "sales" ADD COLUMN "mpesaVerifications" JSONB;

-- CreateTable: no RLS on either table, same reasoning as mpesa_transactions (Safaricom's callback
-- carries no tenant context); isolation is by explicit tenantId in mpesa-verification-service.ts.
CREATE TABLE "mpesa_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payerName" TEXT,
    "maskedPhone" TEXT,
    "transTime" TEXT,
    "source" TEXT NOT NULL,
    "claimKey" TEXT,
    "reservedAt" TIMESTAMP(3),
    "claimedSaleId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedByEmployeeId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mpesa_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mpesa_c2b_endpoints" (
    "token" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mpesa_c2b_endpoints_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE UNIQUE INDEX "mpesa_payments_tenantId_code_key" ON "mpesa_payments"("tenantId", "code");
CREATE INDEX "mpesa_payments_tenantId_locationId_amountCents_receivedAt_idx" ON "mpesa_payments"("tenantId", "locationId", "amountCents", "receivedAt");
CREATE INDEX "mpesa_payments_claimKey_idx" ON "mpesa_payments"("claimKey");
CREATE UNIQUE INDEX "mpesa_c2b_endpoints_locationId_key" ON "mpesa_c2b_endpoints"("locationId");
CREATE INDEX "mpesa_c2b_endpoints_tenantId_idx" ON "mpesa_c2b_endpoints"("tenantId");

-- AddForeignKey
ALTER TABLE "mpesa_payments" ADD CONSTRAINT "mpesa_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mpesa_c2b_endpoints" ADD CONSTRAINT "mpesa_c2b_endpoints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
