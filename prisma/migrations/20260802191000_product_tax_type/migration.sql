-- AlterTable
-- Mirrors DESKTOP's matching migration (product_tax_type). Backfill matches DESKTOP's own
-- best-effort default exactly: taxRate > 0 -> 'vat' (it WAS being taxed), 0 -> 'zero_rated'.
ALTER TABLE "products" ADD COLUMN     "taxType" TEXT NOT NULL DEFAULT 'vat';
UPDATE "products" SET "taxType" = CASE WHEN "taxRate" > 0 THEN 'vat' ELSE 'zero_rated' END;
