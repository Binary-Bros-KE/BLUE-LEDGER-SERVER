-- Storefront orders — the POS "Online Orders" inbox (see ECOMMERCE-ARCHITECTURE.md §5, and the
-- OnlineOrder model comment for why it's cloud-only rather than a synced entity).
--
-- RLS'd like every tenant business-data table — only ever touched via withTenantContext().

CREATE TABLE "online_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderSeq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "deliveryMethodId" TEXT,
    "deliveryMethodName" TEXT,
    "deliveryFeeCents" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL DEFAULT 'pay_on_delivery',
    "itemsJson" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "fulfilmentLocationId" TEXT,
    "seenAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3),
    "handledByDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "online_orders_tenantId_orderSeq_key" ON "online_orders"("tenantId", "orderSeq");
CREATE INDEX "online_orders_tenantId_status_createdAt_idx" ON "online_orders"("tenantId", "status", "createdAt");

ALTER TABLE "online_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "online_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "online_orders"
  USING ("tenantId" = current_setting('app.tenant_id', true));
