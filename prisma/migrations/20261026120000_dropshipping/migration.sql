-- AlterTable
-- Admin-only switch, default off: every existing tenant is untouched.
ALTER TABLE "tenants" ADD COLUMN     "dropshippingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
-- Registry tables spanning two tenants (reseller + supplier) — deliberately NOT RLS-protected, same
-- as licenses/devices. Only SUPER_ADMIN routes and the dropship worker ever touch them; the business
-- rows they point at (products, inventory, stock_movements) stay fully RLS-protected and are only
-- ever read/written through withTenantContext.
CREATE TABLE "dropship_connections" (
    "id" TEXT NOT NULL,
    "resellerTenantId" TEXT NOT NULL,
    "supplierTenantId" TEXT NOT NULL,
    "targetLocationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "autoImport" BOOLEAN NOT NULL DEFAULT true,
    "lastMirroredAt" TIMESTAMP(3),
    "lastCatalogSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dropship_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dropship_product_links" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resellerProductId" TEXT NOT NULL,
    "supplierProductId" TEXT NOT NULL,
    "lastMirroredQty" INTEGER,
    "lastMirroredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dropship_product_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dropship_connections_supplierTenantId_idx" ON "dropship_connections"("supplierTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "dropship_connections_resellerTenantId_supplierTenantId_key" ON "dropship_connections"("resellerTenantId", "supplierTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "dropship_product_links_resellerProductId_key" ON "dropship_product_links"("resellerProductId");

-- CreateIndex
CREATE UNIQUE INDEX "dropship_product_links_connectionId_supplierProductId_key" ON "dropship_product_links"("connectionId", "supplierProductId");

-- AddForeignKey
ALTER TABLE "dropship_connections" ADD CONSTRAINT "dropship_connections_resellerTenantId_fkey" FOREIGN KEY ("resellerTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dropship_connections" ADD CONSTRAINT "dropship_connections_supplierTenantId_fkey" FOREIGN KEY ("supplierTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dropship_product_links" ADD CONSTRAINT "dropship_product_links_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "dropship_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
