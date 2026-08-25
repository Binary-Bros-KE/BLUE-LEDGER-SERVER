-- Row-Level Security — ENABLE + FORCE (the app connects as the table-owning role, which Postgres
-- exempts from RLS by default) + current_setting's missing_ok=true (so a query outside
-- withTenantContext fails closed with zero rows instead of hard-erroring). Same pattern as every
-- other tenant-scoped table (see e.g. stock_receipts' own migration).
ALTER TABLE "mobile_document_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mobile_document_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mobile_document_counters"
  USING ("tenantId" = current_setting('app.tenant_id', true));
