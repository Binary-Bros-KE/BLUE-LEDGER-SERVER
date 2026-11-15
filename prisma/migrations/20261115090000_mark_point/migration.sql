-- Mark Point (DESKTOP migration 115): selling = buying x markPoint, off by default.
ALTER TABLE "tenants" ADD COLUMN "markPointEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "markPoint" DOUBLE PRECISION;
ALTER TABLE "tenants" ADD COLUMN "markPointStrict" BOOLEAN NOT NULL DEFAULT false;
