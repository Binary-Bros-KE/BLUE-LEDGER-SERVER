-- E-commerce P0 (see ECOMMERCE-ARCHITECTURE.md). Adds:
--   * plans.featureEcommerce            — the paid gate for the client-website add-on
--   * products.publishedOnline / onlineDescription / onlinePriceCents / onlineImageUrls
--   * web_stores                        — 1:1 storefront routing + config per tenant
--
-- web_stores deliberately has NO Row-Level Security. Unlike every synced business-data table, this
-- one is looked up BY DOMAIN before any tenant context exists (resolveLiveStore in
-- middleware/shop-tenant.ts, exactly like requireDevice looks up a Device by id pre-context in
-- middleware/device-auth.ts). It holds only storefront config, never a tenant's own
-- products/customers/orders — those stay RLS'd and are read via withTenantContext() once this row
-- has resolved the tenantId. Every query against this table filters by tenantId in application
-- code, the same discipline License / Subscription / Device already follow.

-- CreateEnum
CREATE TYPE "WebStoreStatus" AS ENUM ('DRAFT', 'LIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('NONE', 'PENDING_DNS', 'VERIFYING_TLS', 'LIVE');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "featureEcommerce" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable — per-tenant e-commerce add-on flag (à la carte; OR'd with the plan flag).
ALTER TABLE "tenants" ADD COLUMN "ecommerceEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "products"
    ADD COLUMN "publishedOnline" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "onlineDescription" TEXT,
    ADD COLUMN "onlinePriceCents" INTEGER,
    ADD COLUMN "onlineImageUrls" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "web_stores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "customDomain" TEXT,
    "domainStatus" "DomainStatus" NOT NULL DEFAULT 'NONE',
    "status" "WebStoreStatus" NOT NULL DEFAULT 'DRAFT',
    "fulfilmentLocationId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "themeJson" JSONB NOT NULL DEFAULT '{}',
    "deliveryJson" JSONB NOT NULL DEFAULT '{}',
    "paymentOptionsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_stores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_stores_tenantId_key" ON "web_stores"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "web_stores_subdomain_key" ON "web_stores"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "web_stores_customDomain_key" ON "web_stores"("customDomain");

-- CreateIndex
CREATE INDEX "web_stores_customDomain_idx" ON "web_stores"("customDomain");

-- AddForeignKey
ALTER TABLE "web_stores" ADD CONSTRAINT "web_stores_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
