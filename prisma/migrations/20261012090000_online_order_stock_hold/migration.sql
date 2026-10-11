-- A confirmed web order holds its items out of the branch's stock (see OnlineOrder.stockHoldJson).
ALTER TABLE "online_orders" ADD COLUMN "stockHoldJson" JSONB;
