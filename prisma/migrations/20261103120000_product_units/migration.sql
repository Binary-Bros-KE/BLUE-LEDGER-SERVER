-- Selling a product in several units (kg and g, carton and piece) — see src/lib/product-units.ts.
-- Prices stay per base unit but may now be fractional (KES 175/kg = 17.5 cents per gram), which keeps
-- every existing quantity * price correct. Existing whole-number prices are unchanged by the cast.
ALTER TABLE "products"
  ALTER COLUMN "buyingPriceCents" TYPE DOUBLE PRECISION,
  ALTER COLUMN "sellingPriceCents" TYPE DOUBLE PRECISION,
  ALTER COLUMN "wholesalePriceCents" TYPE DOUBLE PRECISION,
  ALTER COLUMN "minimumPriceCents" TYPE DOUBLE PRECISION,
  ADD COLUMN "unitConfigJson" JSONB;
