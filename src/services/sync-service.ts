import { Prisma } from "@prisma/client";
import { withTenantContext } from "../lib/tenant-context.js";
import {
  syncCountsSchema,
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
  customers: (tx) => tx.customer,
  employees: (tx) => tx.employee,
  roles: (tx) => tx.role,
  products: (tx) => tx.product,
  locations: (tx) => tx.location,
  sales: (tx) => tx.sale,
  expense_categories: (tx) => tx.expenseCategory,
  expenses: (tx) => tx.expense,
  salaries: (tx) => tx.salary,
  recurring_bills: (tx) => tx.recurringBill,
  sale_voids: (tx) => tx.saleVoid,
  sale_returns: (tx) => tx.saleReturn,
  quotations: (tx) => tx.quotation,
  purchases: (tx) => tx.purchase,
  stock_movements: (tx) => tx.stockMovement,
  stock_requests: (tx) => tx.stockRequest,
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
};

export type PushRowResult =
  | { id: string; status: "ok" }
  | { id: string; status: "error"; error: string }
  | { id: string; status: "conflict"; serverRow: unknown }
  | { id: string; status: "aliased"; canonicalId: string };

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

  await withTenantContext(parsed.tenantId, async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic dispatch across
    // differently-shaped Prisma models; Zod at the request boundary is the real safety net here.
    const delegate = ENTITY_DELEGATES[parsed.entity](tx) as any;

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
        if (naturalKeyField && !existingById) {
          const naturalKeyValue = row[naturalKeyField];
          if (naturalKeyValue !== null && naturalKeyValue !== undefined) {
            const existingByNaturalKey = await delegate.findFirst({
              where: { tenantId: parsed.tenantId, [naturalKeyField]: naturalKeyValue },
            });
            if (existingByNaturalKey && existingByNaturalKey.id !== id) {
              results.push({ id, status: "aliased", canonicalId: existingByNaturalKey.id });
              continue;
            }
          }
        }

        const data = sanitizeRow(row, parsed.tenantId, parsed.deviceId, parsed.entity);
        await delegate.upsert({ where: { id }, create: { id, ...data }, update: data });
        results.push({ id, status: "ok" });
      } catch (err) {
        results.push({ id, status: "error", error: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  });

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
