-- Client request: the supplier balance only grows as goods are actually received, never at order
-- time and never including shipping cost — see DESKTOP's migrate.ts migration 89 for the full
-- design. receivedValueCents is maintained incrementally by DESKTOP's receivePurchaseGoods and
-- pushed through sync like every other purchase header column.
ALTER TABLE "purchases" ADD COLUMN "receivedValueCents" INTEGER NOT NULL DEFAULT 0;
