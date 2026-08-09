-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "pesapalAccountNumber" TEXT,
ADD COLUMN     "pesapalAutoBillingActivatedAt" TIMESTAMP(3),
ADD COLUMN     "pesapalAutoBillingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pesapalRecurringStatus" TEXT;

-- CreateTable
CREATE TABLE "pesapal_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderTrackingId" TEXT NOT NULL,
    "merchantReference" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "periods" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentMethodDetail" TEXT,
    "confirmationCode" TEXT,
    "isRecurringSetup" BOOLEAN NOT NULL DEFAULT false,
    "initiatedByDeviceId" TEXT,
    "lastQueriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pesapal_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pesapal_transactions_orderTrackingId_key" ON "pesapal_transactions"("orderTrackingId");

-- CreateIndex
CREATE INDEX "pesapal_transactions_tenantId_idx" ON "pesapal_transactions"("tenantId");

-- CreateIndex
CREATE INDEX "pesapal_transactions_orderTrackingId_idx" ON "pesapal_transactions"("orderTrackingId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_pesapalAccountNumber_key" ON "subscriptions"("pesapalAccountNumber");

-- AddForeignKey
ALTER TABLE "pesapal_transactions" ADD CONSTRAINT "pesapal_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

