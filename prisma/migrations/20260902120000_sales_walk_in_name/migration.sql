-- A free-text label a cashier can attach to a walk-in sale ("Scott") at Checkout, WITHOUT creating a
-- real Customer record — only ever meaningful alongside a null "customerId" (DESKTOP clears it the
-- instant a real customer is selected). Read-side, it's baked into the existing customerName every
-- consumer already reads (see mobile-sales-service.ts / share-service.ts / mobile-transactions-service.ts's
-- own walk-in-aware helpers) rather than requiring every consumer to separately check a new field.
ALTER TABLE "sales" ADD COLUMN "walkInName" TEXT;
