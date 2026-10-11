-- AlterTable
-- Mirrors DESKTOP stock_requests.fulfillment_note (partial-dispatch note), never synced before.
ALTER TABLE "stock_requests" ADD COLUMN     "fulfillmentNote" TEXT;
