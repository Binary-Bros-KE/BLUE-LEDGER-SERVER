-- AlterTable
-- Mirrors DESKTOP's matching migration 96. shippingCostCents stays exactly as-is (never renamed —
-- see its own doc comment); shippingExpenseCents is the new, purely additive "Shipping Cost" concept.
ALTER TABLE "purchases" ADD COLUMN     "shippingExpenseCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "purchases" ADD COLUMN     "shipmentCourierName" TEXT;
ALTER TABLE "purchases" ADD COLUMN     "shipmentTrackingNumber" TEXT;
ALTER TABLE "purchases" ADD COLUMN     "shipmentDepartedAt" TEXT;
ALTER TABLE "purchases" ADD COLUMN     "shipmentEta" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "sourceType" TEXT;
ALTER TABLE "expenses" ADD COLUMN     "sourceId" TEXT;
