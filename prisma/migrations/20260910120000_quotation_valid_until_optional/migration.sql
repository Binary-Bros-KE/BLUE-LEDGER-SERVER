-- Client request: a quotation only expires if the user explicitly set an expiry date. valid_until
-- (stored as an ISO date string) becomes nullable; NULL means "never expires". Existing rows keep
-- their current value.
ALTER TABLE "quotations" ALTER COLUMN "validUntil" DROP NOT NULL;
