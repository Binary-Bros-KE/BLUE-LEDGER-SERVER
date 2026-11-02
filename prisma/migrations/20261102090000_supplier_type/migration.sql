-- Local or international supplier. Existing suppliers: Kenya or no country = local, any other country
-- = international. DESKTOP's migration applies the same rule to its own copy, so localUpdatedAt isn't
-- bumped here: nothing needs pulling, and a bump would only make every device's copy conflict.
ALTER TABLE "suppliers" ADD COLUMN "supplierType" TEXT NOT NULL DEFAULT 'local';

-- One tenant at a time via set_config, as "suppliers" is under row level security; same pattern as
-- 20261028120000_backfill_mobile_invoice_completed_at.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t.id, true);
    UPDATE "suppliers"
    SET "supplierType" = 'international'
    WHERE "tenantId" = t.id
      AND trim(coalesce("country", '')) <> ''
      AND lower(trim("country")) NOT IN ('kenya', 'ke');
  END LOOP;
END $$;
