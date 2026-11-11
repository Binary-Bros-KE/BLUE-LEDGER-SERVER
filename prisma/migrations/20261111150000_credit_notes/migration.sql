-- Credit notes (DESKTOP migration 112): a return can carry a CN number and the amount actually refunded.
ALTER TABLE "sale_returns" ADD COLUMN "creditNoteNumber" TEXT;
ALTER TABLE "sale_returns" ADD COLUMN "refundCents" INTEGER;
