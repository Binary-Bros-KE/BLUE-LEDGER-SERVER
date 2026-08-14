-- AlterTable
-- A quotation is non-binding (no money/credit at stake, unlike an invoice) — same reasoning
-- Sale.customerId already relies on for a walk-in receipt. This was the one document type left
-- requiring a real customer, which meant a quotation whose customer reference became genuinely
-- unresolvable on the DESKTOP side failed to sync at all rather than degrading gracefully.
ALTER TABLE "quotations" ALTER COLUMN "customerId" DROP NOT NULL;
