-- CreateTable: server-side running stock balance per (product, location) — see the Inventory model's
-- own doc comment in schema.prisma for the full "why" (the business owner's own live concern: mobile
-- reads were summing the ENTIRE stock_movements ledger, unbounded, on every single request). This is
-- the Postgres-side equivalent of DESKTOP's local `inventory` table.
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- One row per (product, location) — the trigger below relies on this exact constraint for its own
-- ON CONFLICT ("productId", "locationId") upsert.
CREATE UNIQUE INDEX "inventory_productId_locationId_key" ON "inventory"("productId", "locationId");
CREATE INDEX "inventory_tenantId_idx" ON "inventory"("tenantId");

ALTER TABLE "inventory" ADD CONSTRAINT "inventory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One-time backfill: replays the FULL existing stock_movements history exactly once, right now, at
-- migration time. This is deliberately the ONLY place a full-history aggregation over stock_movements
-- is allowed to happen ever again — every application read after this migration hits this table
-- instead (O(1) per product+location, not O(all-time movements)).
--
-- Looped ONE TENANT AT A TIME via set_config, exactly the way withTenantContext() already scopes
-- every ordinary application query — deliberately NOT a single bare cross-tenant
-- "INSERT ... SELECT ... FROM stock_movements GROUP BY tenantId, ..." statement. stock_movements
-- itself already carries FORCE ROW LEVEL SECURITY from its own original migration, and that isn't a
-- write-side-only guard: a SELECT against it with no app.tenant_id set doesn't error and doesn't see
-- "everything" — its USING clause silently filters the read down to ZERO rows for every tenant at
-- once, so a bare cross-tenant backfill attempt SILENTLY inserts nothing and reports success. Caught
-- live: an early version of this migration did exactly that, and only surfaced because the resulting
-- `inventory` row count didn't match a fresh SUM over the ledger for a real, non-empty local tenant.
-- The one thing that's genuinely off the table here is temporarily loosening stock_movements' own
-- RLS (ALTER ... NO FORCE, or similar) to read across tenants in one shot — this migration can run
-- against a live production database with real concurrent traffic mid-deploy, and there's only ever
-- one DB role in play (blueledger_app; see .env's single DATABASE_URL — no separate, more-privileged
-- migration role), so briefly loosening RLS on the actual ledger table would briefly loosen it for
-- every OTHER concurrent request on that same connection role too. Looping per tenant instead costs
-- nothing extra in safety terms — plain set_config, the exact mechanism every other query in this
-- codebase already goes through — while keeping tenant isolation intact for the table's entire
-- history, including the one moment (migration time) most likely to touch all of it at once.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t.id, true);
    INSERT INTO "inventory" (id, "tenantId", "productId", "locationId", quantity, "updatedAt")
    SELECT gen_random_uuid()::text, "tenantId", "productId", "locationId", SUM("quantityChange"), now()
    FROM "stock_movements"
    WHERE "tenantId" = t.id
    GROUP BY "tenantId", "productId", "locationId";
  END LOOP;
END $$;

-- Row-Level Security — same checklist every synced-entity table already follows (see
-- stock_movements' own migration comment): ENABLE alone isn't enough because the app connects as the
-- table-owning role (blueledger_app), which Postgres exempts from RLS by default, so FORCE is
-- required too; current_setting's second (missing_ok) argument must be true, or any query running
-- outside withTenantContext() hard-ERRORs instead of failing closed with zero rows. This table is
-- never written by application code directly (only the trigger below writes it, always inside the
-- same withTenantContext() transaction as the stock_movements insert that fired it — same
-- app.tenant_id already set for that whole transaction), so the same policy that gates reads also
-- correctly gates the trigger's own writes going forward.
ALTER TABLE "inventory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- Trigger: keeps this table correct incrementally from here on, for every future stock_movements
-- INSERT, regardless of which code path created it — DESKTOP's own sync push (sync-service.ts's
-- generic pushRows, which upserts by id: a genuine new movement always lands via the INSERT branch,
-- so this fires exactly once per real movement; a retried push of the same already-applied id lands
-- via the UPDATE branch instead — since stock_movements are immutable/append-only, that update is a
-- no-op on identical data anyway, but either way it does NOT re-fire this AFTER INSERT trigger, so a
-- retry can never double-count) AND every mobile direct-write path (checkout, invoices, quotations —
-- all plain stockMovement.createMany, never upsert). A DB-level trigger on the ledger's own table is
-- the one mechanism that structurally cannot be bypassed by a new code path forgetting to update a
-- derived total by hand — exactly the class of bug main_store_allocations had on the DESKTOP side
-- (see that table's own migration 77): a manually-maintained derived copy can silently drift the
-- moment one write path forgets it; a trigger on the single source-of-truth table cannot. Runs as the
-- invoking session (SECURITY INVOKER, PL/pgSQL's default) so it inherits whatever app.tenant_id is
-- already set for the surrounding withTenantContext() transaction — the tenant_isolation policy above
-- passes for it exactly the same way it would for a query the application wrote by hand.
CREATE OR REPLACE FUNCTION fn_stock_movements_maintain_inventory() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "inventory" (id, "tenantId", "productId", "locationId", quantity, "updatedAt")
  VALUES (gen_random_uuid()::text, NEW."tenantId", NEW."productId", NEW."locationId", NEW."quantityChange", now())
  ON CONFLICT ("productId", "locationId")
  DO UPDATE SET quantity = "inventory".quantity + NEW."quantityChange", "updatedAt" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movements_maintain_inventory
  AFTER INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION fn_stock_movements_maintain_inventory();
