-- Product brand, online "was" price, and the variant model (mirrors DESKTOP migration v98).
-- All nullable / defaulted: every existing product is unaffected (no brand, no sale, no variants).
ALTER TABLE "products" ADD COLUMN "onlineCompareAtPriceCents" INTEGER,
ADD COLUMN "brand" TEXT,
ADD COLUMN "variantGroupId" TEXT,
ADD COLUMN "variantOptionsJson" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "variantConfigJson" JSONB;

CREATE INDEX "products_tenantId_variantGroupId_idx" ON "products"("tenantId", "variantGroupId");
