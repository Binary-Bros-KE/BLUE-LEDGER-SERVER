-- AlterTable
-- Client request: invoices/quotations can now carry any number of additional titled note blocks
-- (e.g. "Installation Instructions") alongside the existing plain notes/invoiceNotes field.
-- Per-line-item "sectionLabel" (grouping items into named sections like "Lighting"/"Sound") lives
-- INSIDE the existing "items" JSONB column and needs no schema change here.
ALTER TABLE "sales" ADD COLUMN "notesSections" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "quotations" ADD COLUMN "notesSections" JSONB NOT NULL DEFAULT '[]';
