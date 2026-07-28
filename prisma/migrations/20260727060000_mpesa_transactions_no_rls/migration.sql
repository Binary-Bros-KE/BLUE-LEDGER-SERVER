-- mpesa_transactions must be readable BEFORE tenant context is known — Safaricom's own callback
-- POST carries no tenantId at all, only a checkoutRequestId, so its handler (and the DESKTOP status
-- poll, which looks the row up by the same opaque id) needs a tenant-blind first lookup, exactly the
-- same "entry point before tenant context exists" shape as share_links/License/Device. FORCE ROW
-- LEVEL SECURITY on this table made every such lookup silently return zero rows (current_setting
-- ('app.tenant_id', true) is NULL outside withTenantContext, and "tenantId" = NULL is never true),
-- which meant the callback could never actually record a result and the status endpoint could never
-- find its own just-created row. Removing RLS here; tenant isolation for this table is enforced by
-- explicit `existing.tenantId !== parsed.tenantId` checks in mpesa-service.ts instead (same pattern
-- already used for ShareLink resolution).
DROP POLICY IF EXISTS tenant_isolation ON "mpesa_transactions";
ALTER TABLE "mpesa_transactions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "mpesa_transactions" DISABLE ROW LEVEL SECURITY;
