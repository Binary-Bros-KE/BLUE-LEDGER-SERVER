-- Web orders move step by step (pending → confirmed → ready/shipped → picked up/delivered → completed),
-- take payments before they become a sale, and keep a short audit trail + the rider they shipped with.
ALTER TABLE "online_orders" ADD COLUMN "paymentsJson" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "online_orders" ADD COLUMN "historyJson" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "online_orders" ADD COLUMN "riderId" TEXT;
ALTER TABLE "online_orders" ADD COLUMN "riderName" TEXT;
