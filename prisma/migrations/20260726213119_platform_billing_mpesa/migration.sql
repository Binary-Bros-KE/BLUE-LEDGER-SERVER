-- CreateTable
CREATE TABLE "outlet_mpesa_settings" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "consumerKey" TEXT NOT NULL,
    "consumerSecret" TEXT NOT NULL,
    "passkey" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "tillNumber" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_mpesa_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_mpesa_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "merchantRequestId" TEXT NOT NULL,
    "checkoutRequestId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "periods" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultCode" INTEGER,
    "resultDescription" TEXT,
    "mpesaReceiptNumber" TEXT,
    "transactionDate" TEXT,
    "initiatedByDeviceId" TEXT,
    "lastQueriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outlet_mpesa_settings_outletId_key" ON "outlet_mpesa_settings"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_mpesa_transactions_checkoutRequestId_key" ON "billing_mpesa_transactions"("checkoutRequestId");

-- CreateIndex
CREATE INDEX "billing_mpesa_transactions_tenantId_idx" ON "billing_mpesa_transactions"("tenantId");

-- CreateIndex
CREATE INDEX "billing_mpesa_transactions_checkoutRequestId_idx" ON "billing_mpesa_transactions"("checkoutRequestId");

-- AddForeignKey
ALTER TABLE "outlet_mpesa_settings" ADD CONSTRAINT "outlet_mpesa_settings_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_mpesa_transactions" ADD CONSTRAINT "billing_mpesa_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
