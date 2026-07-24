-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "currentBalanceCents" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "supplierSku" TEXT,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "description" TEXT,
    "categoryId" TEXT,
    "storefrontId" TEXT,
    "buyingPriceCents" INTEGER NOT NULL,
    "sellingPriceCents" INTEGER NOT NULL,
    "wholesalePriceCents" INTEGER,
    "wholesaleMinQuantity" INTEGER NOT NULL,
    "minimumPriceCents" INTEGER,
    "taxRate" DOUBLE PRECISION NOT NULL,
    "reorderLevel" INTEGER NOT NULL,
    "trackStock" BOOLEAN NOT NULL,
    "allowNegativeStock" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity (hand-added, Prisma has no native support — same pattern as every Phase 1 table).
-- current_setting(..., true) is missing_ok=true: an unset session var compares false against every
-- row rather than throwing, so a query that forgets to go through withTenantContext() fails CLOSED
-- (empty result), not with an error — same deliberate Phase 1 design, restored here after a real
-- gap (this migration originally omitted it, fixed retroactively — see the Phase 3 migration for
-- the live-database correction of this exact issue).
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products"
  USING ("tenantId" = current_setting('app.tenant_id', true));
