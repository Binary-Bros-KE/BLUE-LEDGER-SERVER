-- Reassigns every existing tenant row off the old uppercase BusinessType values onto the new
-- lowercase ones that actually match what the desktop app's Business Profile screen offers (see
-- schema.prisma's BusinessType enum comment). Split into its OWN migration/transaction, separate
-- from the one that added these new enum values — Postgres does not allow a newly-added enum value
-- to be used in the same transaction that added it.
-- BOOKSHOP has no equivalent in the new list (the desktop app never offered it) — falls back to
-- 'other', the same safe default every other unmapped/blank case in this app already uses.
UPDATE "tenants" SET "businessType" = 'retail_shop' WHERE "businessType" = 'RETAIL';
UPDATE "tenants" SET "businessType" = 'wholesale_shop' WHERE "businessType" = 'WHOLESALE';
UPDATE "tenants" SET "businessType" = 'retail_and_wholesale' WHERE "businessType" = 'RETAIL_AND_WHOLESALE';
UPDATE "tenants" SET "businessType" = 'hardware' WHERE "businessType" = 'HARDWARE';
UPDATE "tenants" SET "businessType" = 'pharmacy' WHERE "businessType" = 'PHARMACY';
UPDATE "tenants" SET "businessType" = 'supermarket' WHERE "businessType" = 'SUPERMARKET';
UPDATE "tenants" SET "businessType" = 'electronics' WHERE "businessType" = 'ELECTRONICS';
UPDATE "tenants" SET "businessType" = 'other' WHERE "businessType" = 'BOOKSHOP';
UPDATE "tenants" SET "businessType" = 'other' WHERE "businessType" = 'OTHER';
