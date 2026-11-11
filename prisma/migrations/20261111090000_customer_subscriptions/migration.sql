-- Customer subscriptions (DStv, GOtv...) synced from DESKTOP's tables of the same names (desktop migration 111).
-- Not "subscriptions": that table is Blue Ledger's own billing of each tenant (model Subscription).
CREATE TABLE "customer_subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT,
    "serviceName" TEXT NOT NULL,
    "accountNumber" TEXT,
    "startDate" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "endDate" TEXT NOT NULL,
    "amountCents" INTEGER,
    "status" TEXT NOT NULL,
    "renewedFromId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_subscription_notices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT,
    "sentBy" TEXT,
    "sentAt" TEXT NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_subscription_notices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_subscriptions_tenantId_status_endDate_idx" ON "customer_subscriptions"("tenantId", "status", "endDate");
CREATE INDEX "customer_subscriptions_customerId_idx" ON "customer_subscriptions"("customerId");
CREATE INDEX "customer_subscription_notices_tenantId_idx" ON "customer_subscription_notices"("tenantId");
CREATE INDEX "customer_subscription_notices_subscriptionId_idx" ON "customer_subscription_notices"("subscriptionId");

ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_subscription_notices" ADD CONSTRAINT "customer_subscription_notices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same tenant isolation as every other synced table.
ALTER TABLE "customer_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_subscriptions"
  USING ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "customer_subscription_notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_subscription_notices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_subscription_notices"
  USING ("tenantId" = current_setting('app.tenant_id', true));
