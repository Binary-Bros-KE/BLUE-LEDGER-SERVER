-- A web order rung up at the POS remembers which sale it became (one order -> at most one sale).
ALTER TABLE "online_orders" ADD COLUMN "linkedSaleId" TEXT,
ADD COLUMN "linkedReceiptNumber" TEXT;
