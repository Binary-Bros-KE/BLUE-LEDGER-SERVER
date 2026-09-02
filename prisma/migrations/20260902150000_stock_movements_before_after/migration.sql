-- This location's actual on-hand quantity immediately before/after a stock movement, frozen at the
-- moment it happened on the device that recorded it — never recomputed here. Mirrors DESKTOP's
-- stock_movements.previous_quantity/new_quantity (migration 83).
ALTER TABLE "stock_movements" ADD COLUMN "previousQuantity" INTEGER;
ALTER TABLE "stock_movements" ADD COLUMN "newQuantity" INTEGER;
