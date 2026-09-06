-- Storefront delivery/shipping options (see ECOMMERCE-ARCHITECTURE.md). A shopper picks one at
-- checkout; its fee is added to the order total. Edited by the tenant from the POS "Online Store"
-- tab (device-authed /shop-admin/delivery/*), read by the storefront (public /shop/delivery).
--
-- RLS'd like every synced business-data table — it holds a tenant's own config and is only ever
-- touched via withTenantContext(). Not a synced entity (no desktop SQLite mirror): the tenant
-- must be online to edit it, same as the theme config.

CREATE TABLE "web_delivery_methods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_delivery_methods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "web_delivery_methods_tenantId_idx" ON "web_delivery_methods"("tenantId");

ALTER TABLE "web_delivery_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "web_delivery_methods" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_delivery_methods"
  USING ("tenantId" = current_setting('app.tenant_id', true));
