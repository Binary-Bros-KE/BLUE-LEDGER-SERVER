ALTER TABLE "stock_receipts" ADD COLUMN "stockRequestId" TEXT;
CREATE UNIQUE INDEX "stock_receipts_stockRequestId_key" ON "stock_receipts"("stockRequestId") WHERE "stockRequestId" IS NOT NULL;
