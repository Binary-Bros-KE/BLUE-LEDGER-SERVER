-- Invoices/quotations used to just borrow receiptHeader/receiptFooter (and had no header of their
-- own at all) -- these give each document type its own, same per-storefront-overrides pattern as
-- the receipt pair. showProductImagesOn* only ever affects DESKTOP's own downloaded/printed PDF;
-- synced here purely so every device sharing this storefront sees the same toggle.
ALTER TABLE "locations" ADD COLUMN "invoiceHeader" TEXT;
ALTER TABLE "locations" ADD COLUMN "invoiceFooter" TEXT;
ALTER TABLE "locations" ADD COLUMN "quotationHeader" TEXT;
ALTER TABLE "locations" ADD COLUMN "quotationFooter" TEXT;
ALTER TABLE "locations" ADD COLUMN "showProductImagesOnInvoices" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "locations" ADD COLUMN "showProductImagesOnQuotations" BOOLEAN NOT NULL DEFAULT false;
