-- Prepaid subscription balance: top up any amount, due periods are paid from it automatically.
ALTER TABLE "subscriptions" ADD COLUMN "walletBalanceCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "billing_mpesa_transactions" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'periods';
ALTER TABLE "pesapal_transactions" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'periods';

CREATE TABLE "subscription_wallet_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "billingPeriod" TEXT,
    "paymentMethod" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_wallet_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_wallet_entries_tenantId_createdAt_idx" ON "subscription_wallet_entries"("tenantId", "createdAt");

ALTER TABLE "subscription_wallet_entries" ADD CONSTRAINT "subscription_wallet_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
