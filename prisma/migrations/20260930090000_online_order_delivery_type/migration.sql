-- Web orders: the shopper picks up from the shop or asks for delivery. Payment is NOT chosen online —
-- the shop and customer agree it after the order arrives, so new orders record "to_be_arranged".
ALTER TABLE "online_orders" ADD COLUMN "deliveryType" TEXT NOT NULL DEFAULT 'delivery';
ALTER TABLE "online_orders" ALTER COLUMN "paymentMethod" SET DEFAULT 'to_be_arranged';
