-- What's owed to a supplier — an append-only ledger, same shape as stock_movements: see the
-- SupplierBalanceEntry model's own doc comment in schema.prisma for the full "why" (DESKTOP's own
-- suppliers.balance_cents is a LOCAL cache derived from this, deliberately never synced itself).
CREATE TABLE "supplier_balance_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "notes" TEXT,
    "performedBy" TEXT,
    "localCreatedAt" TIMESTAMP(3) NOT NULL,
    "localUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_balance_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supplier_balance_entries_tenantId_idx" ON "supplier_balance_entries"("tenantId");

ALTER TABLE "supplier_balance_entries" ADD CONSTRAINT "supplier_balance_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — same checklist every synced-entity table already follows (see
-- stock_movements' own migration comment): ENABLE alone isn't enough because the app connects as the
-- table-owning role (blueledger_app), which Postgres exempts from RLS by default, so FORCE is
-- required too; current_setting's second (missing_ok) argument must be true, or any query running
-- outside withTenantContext() hard-ERRORs instead of failing closed with zero rows.
ALTER TABLE "supplier_balance_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_balance_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier_balance_entries"
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- No backfill — explicit client instruction (same day this feature was requested): every supplier
-- starts at exactly 0, purchases/payments made before this feature shipped get entered by hand via
-- DESKTOP's new "Record Balance Adjustment" action. See DESKTOP migration 78's own comment for the
-- full reasoning.
