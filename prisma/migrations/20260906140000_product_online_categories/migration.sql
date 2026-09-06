-- Online-only extra category memberships for a product (see ECOMMERCE-ARCHITECTURE.md). A JSON
-- string array of category ids. The POS keeps its single `categoryId`; the storefront unions the
-- two: a product is "in category X" when `categoryId = X` OR X is in `onlineCategoryIds`.
-- Synced from the desktop like `onlineImageUrls` (the values travel, it's just JSON).

ALTER TABLE "products" ADD COLUMN "onlineCategoryIds" JSONB NOT NULL DEFAULT '[]';
