import { Prisma } from "@prisma/client";
import { withTenantContext } from "../lib/tenant-context.js";
import {
  syncCountsSchema,
  syncFetchByIdSchema,
  syncPullSchema,
  syncPushSchema,
  syncRowStatusSchema,
  type SyncEntityName,
} from "../schemas/sync.js";

/** One generic dispatch table instead of seven near-identical route/service files — see the plan's
 * own reasoning for this. Each entry just picks the right Prisma delegate off a transaction client;
 * the actual push/pull/count logic below is entity-agnostic. */
const ENTITY_DELEGATES: Record<SyncEntityName, (tx: Prisma.TransactionClient) => unknown> = {
  categories: (tx) => tx.category,
  payment_methods: (tx) => tx.paymentMethod,
  riders: (tx) => tx.rider,
  suppliers: (tx) => tx.supplier,
  supplier_balance_entries: (tx) => tx.supplierBalanceEntry,
  customers: (tx) => tx.customer,
  employees: (tx) => tx.employee,
  roles: (tx) => tx.role,
  products: (tx) => tx.product,
  locations: (tx) => tx.location,
  working_hours: (tx) => tx.workingHours,
  sales: (tx) => tx.sale,
  expense_categories: (tx) => tx.expenseCategory,
  expenses: (tx) => tx.expense,
  salaries: (tx) => tx.salary,
  recurring_bills: (tx) => tx.recurringBill,
  sale_voids: (tx) => tx.saleVoid,
  invoice_cancellations: (tx) => tx.invoiceCancellation,
  sale_returns: (tx) => tx.saleReturn,
  quotations: (tx) => tx.quotation,
  purchases: (tx) => tx.purchase,
  stock_movements: (tx) => tx.stockMovement,
  stock_requests: (tx) => tx.stockRequest,
  stock_receipts: (tx) => tx.stockReceipt,
  main_store_allocations: (tx) => tx.mainStoreAllocation,
};

/** The only nullable Json columns across the whole synced schema today (every other Json field —
 * items/serviceCharges/payments/allowancesJson/etc. — is non-nullable, always an array/object, never
 * legitimately null). Prisma requires the special `Prisma.JsonNull` sentinel to store a genuine
 * null into a nullable Json column — a bare JS `null` doesn't match either generated create/update
 * input variant at runtime, which surfaces as a confusing unrelated "Argument `tenant` is missing"
 * error (the Unchecked variant silently fails to match, so the client falls back to describing what
 * the OTHER, relation-based variant would need). Found live via this feature's own end-to-end test —
 * a quotation/sale with no delivery attached failed to push until this was added. */
const NULLABLE_JSON_FIELDS: Partial<Record<SyncEntityName, string[]>> = {
  sales: ["delivery"],
  quotations: ["delivery"],
};

/** Every Phase-1 model shares one shape: id + entity fields + localCreatedAt/localUpdatedAt +
 * tenantId/deviceId/syncedAt. That means one generic sanitizer covers all seven — no per-entity
 * mapping code needed. tenantId/deviceId are ALWAYS forced from the authenticated request context,
 * never trusted from the row payload itself (a device can only ever write as itself, for the tenant
 * requireDevice already proved it belongs to); syncedAt is server-owned and stripped if present. */
function sanitizeRow(
  row: Record<string, unknown>,
  tenantId: string,
  deviceId: string,
  entity: SyncEntityName,
): Record<string, unknown> {
  const {
    id: _id,
    tenantId: _tenantId,
    deviceId: _deviceId,
    syncedAt: _syncedAt,
    // The desktop's own raw field names — sync-engine.ts (DESKTOP) always renames these to
    // localCreatedAt/localUpdatedAt before sending, but strip them defensively too: Prisma rejects
    // unknown fields outright, and this is exactly the mistake that's easy to make by hand (caught
    // live during this feature's own smoke test).
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    // Phase 2's optimistic-lock baseline (see pushRows below) — never a real column on any model,
    // just metadata about what the client last saw. Read there, stripped here.
    baseUpdatedAt: _baseUpdatedAt,
    localCreatedAt,
    localUpdatedAt,
    ...rest
  } = row;

  for (const field of NULLABLE_JSON_FIELDS[entity] ?? []) {
    if (rest[field] === null) {
      rest[field] = Prisma.JsonNull;
    }
  }

  return {
    ...rest,
    tenantId,
    deviceId,
    localCreatedAt: typeof localCreatedAt === "string" ? new Date(localCreatedAt) : localCreatedAt,
    localUpdatedAt: typeof localUpdatedAt === "string" ? new Date(localUpdatedAt) : localUpdatedAt,
    // Every model's syncedAt is `@default(now())`, NOT `@updatedAt` — Prisma only ever applies a
    // plain default at INSERT time, never on its own on a later UPDATE. Since pullRows' delta query
    // is `syncedAt: { gt: since }`, leaving this out of an update's data (the previous behavior)
    // meant syncedAt froze at whatever it was on first creation FOREVER — every entity's own edits
    // were completely invisible to every other device's future pulls, silently, with no error
    // anywhere (the push itself succeeds normally; only propagation to OTHER devices was broken).
    // Confirmed live: an employee edited on Device 1 pushed/"synced" fine there, but Device 2 never
    // picked it up no matter how long it waited. Setting this explicitly on every push — create AND
    // update alike — is what actually keeps it "the last time ANY write for this row reached this
    // server", which is the whole point of the field.
    syncedAt: new Date(),
  };
}

/** Mirrors the client's own APPLY_CONFIG naturalKey entries (sync-engine.ts, DESKTOP) — the same
 * five entities seeded locally at boot by every device (default roles, the SYSTEM employee, default
 * payment methods/expense categories, the Main Store location), each carrying its own real
 * UNIQUE(tenantId is implicit via RLS, name/code) constraint. Without this, a second device pushing
 * its own independently-seeded "Cashier" would land as a genuine second row here — reconciled away
 * per-device on pull (see the client's sync_id_aliases), but still visible clutter to anything that
 * queries this table directly (e.g. a future admin/mobile app). Checking here instead prevents the
 * duplicate from ever landing in the first place. */
const NATURAL_KEY_FIELDS: Partial<Record<SyncEntityName, string>> = {
  roles: "roleName",
  employees: "employeeCode",
  payment_methods: "code",
  expense_categories: "name",
  locations: "locationCode",
  // Not a boot-seeded default like the five above — this reconciles a DIFFERENT collision: two
  // devices each first-touching the same real (product, storefront) bucket before ever syncing
  // with each other, which would otherwise land as two permanent duplicate rows (see the model's
  // own schema comment).
  main_store_allocations: "bucketKey",
  // Same reasoning as main_store_allocations above — not boot-seeded, but two devices could each
  // independently create the first-ever WorkingHours row for the same storefront while offline from
  // each other (e.g. two Super Admins each first opening the new Working Hours screen for the same
  // location before their devices have synced). Dedupe by the storefront it belongs to.
  working_hours: "locationId",
  // Also not a boot-seeded default — real customer data, entered independently by staff on two
  // different devices before they'd ever synced with each other. But DESKTOP's own local schema
  // already enforces UNIQUE(tenantId, phone) as a hard invariant (a phone number IS the customer,
  // as far as this app is concerned), and this table had no equivalent here — confirmed live: two
  // devices each created "KIBE BUSIA" / 0722944921 ~80 minutes apart, both pushed fine (nothing here
  // rejected either), and the SECOND one to reach a third device could never pull in — permanently
  // blocked by that device's own UNIQUE(tenantId, phone) constraint, no matter how many retries.
  // Same fix as the five entities above: dedup by the natural key here so a genuine duplicate never
  // lands as two separate rows in the first place.
  customers: "phone",
};

/** stock_movements.locationId/productId are deliberately plain opaque strings, not Prisma relations
 * (same reasoning as Employee.roleId/Product.categoryId elsewhere in this schema — see StockMovement's
 * own model comment) — meaning Postgres enforces NO foreign key on them at all. Confirmed live: a
 * device with a stale local copy of a stock_movement kept re-pushing a locationId for a storefront
 * that no longer exists for this tenant, silently overwriting a manual admin correction on the
 * server's own row on every retry, because nothing here ever checked it — DESKTOP's own SQLite FK
 * constraint only ever caught this on the PULL side (a device other than the one still re-pushing the
 * bad value), never on push, and Postgres never enforced it either. Checked here instead, same
 * pattern as NATURAL_KEY_FIELDS above: one small declarative table of ref fields to validate before
 * the upsert runs. */
const REQUIRED_REF_FIELDS: Partial<Record<SyncEntityName, Array<{ field: string; delegate: (tx: Prisma.TransactionClient) => unknown }>>> = {
  stock_movements: [
    { field: "locationId", delegate: (tx) => tx.location },
    { field: "productId", delegate: (tx) => tx.product },
  ],
  working_hours: [{ field: "locationId", delegate: (tx) => tx.location }],
};

export type PushRowResult =
  | { id: string; status: "ok" }
  | { id: string; status: "error"; error: string }
  | { id: string; status: "conflict"; serverRow: unknown }
  | { id: string; status: "aliased"; canonicalId: string }
  // The row references something that isn't on the cloud (yet, or at all). NOT an error and NOT a
  // silent success — the desktop keeps it queued and retries, and only surfaces it as a visible
  // failure after many attempts of the same rejection. Replaces the old status:"ok" here, which
  // cleared the row from the desktop's outbox and lost it forever (see the REQUIRED_REF_FIELDS
  // check below).
  | { id: string; status: "deferred"; error: string };

/** Upserts a batch of rows for one entity, scoped to the calling tenant via withTenantContext (RLS
 * enforces this is the ONLY tenant these writes can land in, even if something upstream were ever
 * wrong). One bad row in a batch doesn't fail the rest — each gets its own ok/error/conflict result
 * so the desktop's outbox can mark exactly the failing rows for retry (or, for a conflict, hold for
 * manual resolution).
 *
 * Conflict detection (Phase 2, generalized — not hardcoded to Products): a row MAY include
 * `baseUpdatedAt`, the localUpdatedAt value this device last saw for this row. If present, and a
 * row with this id already exists, and its CURRENT localUpdatedAt doesn't match that baseline,
 * another device's write landed in between — reject as a conflict instead of blindly overwriting,
 * and hand back the server's current row so the desktop can show a real diff. Rows that never send
 * a baseline (every Phase 1 entity today) skip this check entirely and upsert exactly as before. */
export async function pushRows(input: unknown): Promise<{ results: PushRowResult[] }> {
  const parsed = syncPushSchema.parse(input);
  const results: PushRowResult[] = [];

  await withTenantContext(
    parsed.tenantId,
    async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic dispatch across
      // differently-shaped Prisma models; Zod at the request boundary is the real safety net here.
      const delegate = ENTITY_DELEGATES[parsed.entity](tx) as any;

      // Batch-prefetch every REQUIRED_REF_FIELDS value for this push ONCE, instead of once per row —
      // the per-row `findUnique` this replaced turned a 200-row stock_movements batch (DESKTOP's own
      // PUSH_BATCH_SIZE) into up to 400 sequential round trips inside this one transaction, which blew
      // Prisma's default 5s interactive-transaction timeout on a client with real production volume
      // (confirmed live: "Transaction already closed... 6055ms passed since the start of the
      // transaction" for exactly this entity — not a data problem, a request-shape problem). However
      // large the batch, this is now exactly `requiredRefs.length` findMany calls, not one per row.
      const requiredRefs = REQUIRED_REF_FIELDS[parsed.entity];
      const validRefIdsByField = new Map<string, Set<string>>();
      if (requiredRefs) {
        for (const ref of requiredRefs) {
          const values = [
            ...new Set(parsed.rows.map((row) => row[ref.field]).filter((value): value is string => typeof value === "string")),
          ];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see pushRows' own delegate cast above.
          const refDelegate = ref.delegate(tx) as any;
          const found: Array<{ id: string }> =
            values.length > 0 ? await refDelegate.findMany({ where: { id: { in: values } }, select: { id: true } }) : [];
          validRefIdsByField.set(ref.field, new Set(found.map((row) => row.id)));
        }
      }

      for (const row of parsed.rows) {
        const id = typeof row.id === "string" ? row.id : null;
        if (!id) {
          results.push({ id: "(missing)", status: "error", error: "Row missing id" });
          continue;
        }
        try {
          const naturalKeyField = NATURAL_KEY_FIELDS[parsed.entity];
          const baseUpdatedAt = typeof row.baseUpdatedAt === "string" ? row.baseUpdatedAt : null;

          // One existence check up front, reused by both the conflict check and the natural-key dedup
          // below — either needs to know "does a row with this exact id already exist."
          const existingById =
            baseUpdatedAt || naturalKeyField ? await delegate.findUnique({ where: { id } }) : null;

          if (baseUpdatedAt && existingById && existingById.localUpdatedAt.toISOString() !== new Date(baseUpdatedAt).toISOString()) {
            results.push({ id, status: "conflict", serverRow: existingById });
            continue;
          }

          // Dedup by natural key BEFORE ever inserting a new row — only relevant the first time this
          // id is seen (an update to an already-known row never needs this). See NATURAL_KEY_FIELDS.
          // IMPORTANT: an alias must still write this row's actual content to the canonical row
          // below (via targetId) — it used to `continue` here and discard `data` entirely, which
          // was harmless the instant the alias was first created (both rows were identical
          // boot-seeded defaults) but silently dropped every subsequent edit to the aliased local
          // row forever after (caught live: a role's permission edit reported "synced" locally
          // while production stayed weeks stale — 2026-08-25).
          let targetId = id;
          let aliasedCanonicalId: string | null = null;
          if (naturalKeyField && !existingById) {
            const naturalKeyValue = row[naturalKeyField];
            if (naturalKeyValue !== null && naturalKeyValue !== undefined) {
              const existingByNaturalKey = await delegate.findFirst({
                where: { tenantId: parsed.tenantId, [naturalKeyField]: naturalKeyValue },
              });
              if (existingByNaturalKey && existingByNaturalKey.id !== id) {
                targetId = existingByNaturalKey.id;
                aliasedCanonicalId = existingByNaturalKey.id;
              }
            }
          }

          const data = sanitizeRow(row, parsed.tenantId, parsed.deviceId, parsed.entity);

          // Held ("pending") sales are meant to be local-only (see migrate.ts's held_sales_local_only
          // migration, DESKTOP) — every up-to-date device already refuses to enqueue one for push at
          // all. This is the backstop for any device that ISN'T up to date yet (still running
          // pre-fix code, or simply hasn't restarted to pick up the update): reject it here too,
          // at the one chokepoint every device shares, instead of relying on every client being
          // current. Reporting "ok" (rather than "error") lets the stale device's outbox clear the
          // row normally instead of retrying it forever — the row just never actually lands.
          if (parsed.entity === "sales" && data.saleStatus === "pending") {
            results.push({ id, status: "ok" });
            continue;
          }

          // See REQUIRED_REF_FIELDS above — reject (silently, from the pushing device's point of view)
          // any row whose ref field points at something that doesn't exist for this tenant, instead of
          // upserting it and corrupting whatever's currently stored. Membership check against the
          // batch-prefetched sets above — no per-row query here.
          if (requiredRefs) {
            let brokenRef: string | null = null;
            for (const ref of requiredRefs) {
              const value = row[ref.field];
              if (typeof value !== "string") continue; // nullable ref left unset — not this check's concern
              if (!validRefIdsByField.get(ref.field)!.has(value)) {
                brokenRef = `${ref.field}=${value}`;
                break;
              }
            }
            if (brokenRef) {
              console.error(
                `[sync] Deferred ${parsed.entity} row ${id} from device ${parsed.deviceId}: ${brokenRef} does not exist for this tenant yet.`,
              );
              results.push({
                id,
                status: "deferred",
                error: `${brokenRef} has not synced to the cloud yet`,
              });
              continue;
            }
          }

          // where/create both use targetId: for a normal row this is just `id` (unchanged
          // behavior); for an aliased row targetId is the canonical row's id, which is guaranteed
          // to already exist (found via findFirst above), so this is always the update branch —
          // the create branch only exists to satisfy upsert's shape.
          await delegate.upsert({ where: { id: targetId }, create: { id: targetId, ...data }, update: data });
          results.push(
            aliasedCanonicalId ? { id, status: "aliased", canonicalId: aliasedCanonicalId } : { id, status: "ok" },
          );
        } catch (err) {
          results.push({ id, status: "error", error: err instanceof Error ? err.message : "Unknown error" });
        }
      }
    },
    { timeoutMs: 30_000 },
  );

  return { results };
}

const PULL_PAGE_SIZE = 500;

/** Delta pull — everything for this tenant/entity synced (by THIS server, not the desktop) since
 * the caller's last cursor. Ordered/paginated by syncedAt so a device that's been offline for
 * months gets it in bounded pages via hasMore, not one giant response. */
export async function pullRows(
  input: unknown,
): Promise<{ rows: unknown[]; cursor: string; hasMore: boolean }> {
  const parsed = syncPullSchema.parse(input);

  return withTenantContext(parsed.tenantId, async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see pushRows.
    const delegate = ENTITY_DELEGATES[parsed.entity](tx) as any;
    const where = parsed.since ? { syncedAt: { gt: parsed.since } } : {};
    const page: Array<{ syncedAt: Date }> = await delegate.findMany({
      where,
      orderBy: { syncedAt: "asc" },
      take: PULL_PAGE_SIZE + 1,
    });

    const hasMore = page.length > PULL_PAGE_SIZE;
    const rows = hasMore ? page.slice(0, PULL_PAGE_SIZE) : page;
    const lastRow = rows[rows.length - 1];
    const cursor = lastRow ? lastRow.syncedAt.toISOString() : (parsed.since?.toISOString() ?? new Date(0).toISOString());

    return { rows, cursor, hasMore };
  });
}

/** On-demand fetch of specific rows by id — same row shape as pullRows, no cursor, no pagination.
 * The desktop calls this the moment a pulled child row fails a local foreign key: rather than
 * stalling that whole entity's delta pull until the referenced entity happens to catch up, it grabs
 * exactly the missing parent(s) right now and applies them first. Tenant-scoped via
 * withTenantContext / RLS, identical to every other endpoint here. */
export async function fetchRowsById(input: unknown): Promise<{ rows: unknown[] }> {
  const parsed = syncFetchByIdSchema.parse(input);

  return withTenantContext(parsed.tenantId, async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see pushRows.
    const delegate = ENTITY_DELEGATES[parsed.entity](tx) as any;
    const rows: unknown[] = await delegate.findMany({ where: { id: { in: parsed.ids } } });
    return { rows };
  });
}

/** Backs the drift-reconciliation check — a plain row count per requested entity, nothing more. A
 * mismatch against the desktop's own local count is only ever a SIGNAL for the desktop to
 * investigate/manually resync; this endpoint doesn't do anything about a mismatch itself. */
export async function getCounts(input: unknown): Promise<{ counts: Partial<Record<SyncEntityName, number>> }> {
  const parsed = syncCountsSchema.parse(input);

  return withTenantContext(parsed.tenantId, async (tx) => {
    const counts: Partial<Record<SyncEntityName, number>> = {};
    for (const entity of parsed.entities) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see pushRows.
      const delegate = ENTITY_DELEGATES[entity](tx) as any;
      counts[entity] = await delegate.count();
    }
    return { counts };
  });
}

/** Live pre-approval check for stock requests/sale voids/sale returns — called synchronously
 * BEFORE a device creates a real side effect (a stock movement), not just after the fact via the
 * normal push/pull cycle. Two devices approving the same request within the same sync window used
 * to both succeed locally and both apply their side effect; this closes that by letting the
 * approving device ask "what does the cloud say RIGHT NOW" first. Generic across any entity with a
 * `status` field — not hardcoded to these three, so a future approval-workflow entity gets this for
 * free. Returns `found: false` for a row nobody has pushed yet (nothing to conflict with). */
export async function getRowStatus(
  input: unknown,
): Promise<{ found: boolean; status: string | null; localUpdatedAt: string | null }> {
  const parsed = syncRowStatusSchema.parse(input);

  return withTenantContext(parsed.tenantId, async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see pushRows.
    const delegate = ENTITY_DELEGATES[parsed.entity](tx) as any;
    const row = await delegate.findUnique({ where: { id: parsed.id } });
    if (!row) return { found: false, status: null, localUpdatedAt: null };
    return { found: true, status: row.status ?? null, localUpdatedAt: row.localUpdatedAt?.toISOString() ?? null };
  });
}
