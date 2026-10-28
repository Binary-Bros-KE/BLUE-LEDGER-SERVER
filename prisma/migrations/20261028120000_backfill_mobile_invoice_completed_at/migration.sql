-- Invoices created from the Owner App were saved with "completedAt" NULL, while DESKTOP stamps an
-- invoice's completed_at with its creation time. Every report that finds invoices by completedAt
-- (the dashboard's revenue/margins, the Sales Report, Close Till, and DESKTOP's own reports) skipped
-- them — including payments later received on them. mobile-invoices-service.ts now sets it on
-- create; this fills in the existing rows with their creation time, matching DESKTOP.
--
-- localUpdatedAt + syncedAt are bumped so every DESKTOP pulls the corrected row (its pull keeps a
-- local copy unless the cloud's localUpdatedAt is newer).
--
-- Looped ONE TENANT AT A TIME via set_config — "sales" has FORCE ROW LEVEL SECURITY and there is no
-- separate migration role; same pattern as 20260831210000_server_inventory_balance.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t.id, true);
    UPDATE "sales"
    SET "completedAt" = "localCreatedAt", "localUpdatedAt" = now(), "syncedAt" = now()
    WHERE "tenantId" = t.id
      AND "invoiceNumber" IS NOT NULL
      AND "completedAt" IS NULL;
  END LOOP;
END $$;
