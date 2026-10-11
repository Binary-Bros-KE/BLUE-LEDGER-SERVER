-- AlterTable
-- Mirrors DESKTOP's matching migration. Existing tenants keep storefront-only invoice stock.
ALTER TABLE "tenants" ADD COLUMN     "invoiceStockFromMainStore" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
-- Null = stock came from the invoice's own storefront (locationId), i.e. every existing row.
ALTER TABLE "sales" ADD COLUMN     "stockLocationId" TEXT;
