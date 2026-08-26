import { z } from "zod";

/** The DESKTOP app's own SQLite table names — these are exactly what `sync_outbox.entity` already
 * contains (see the per-table triggers in DESKTOP/src/main/database/migrate.ts), so no translation
 * layer is needed between "what the desktop calls this" and "what this API calls this." */
export const SYNC_ENTITY_NAMES = [
  "categories",
  "payment_methods",
  "riders",
  "suppliers",
  "customers",
  "employees",
  "roles",
  "products",
  "locations",
  "working_hours",
  "sales",
  "expense_categories",
  "expenses",
  "salaries",
  "recurring_bills",
  "sale_voids",
  "invoice_cancellations",
  "sale_returns",
  "quotations",
  "purchases",
  "stock_movements",
  "stock_requests",
  "stock_receipts",
  "main_store_allocations",
] as const;

export type SyncEntityName = (typeof SYNC_ENTITY_NAMES)[number];

const entityEnum = z.enum(SYNC_ENTITY_NAMES);

export const syncPushSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entity: entityEnum,
  // Deliberately loose per-row shape — the desktop is the only writer, always sends its own
  // mapXRow() output for that entity (see sync-engine.ts on the DESKTOP side), and sanitizeRow()
  // below strips/overrides the security-relevant fields (tenantId, deviceId) regardless of what a
  // row claims. RLS is the actual backstop if any of this were ever wrong.
  rows: z.array(z.record(z.string(), z.unknown())).max(500),
});

export type SyncPushInput = z.infer<typeof syncPushSchema>;

export const syncPullSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entity: entityEnum,
  /** Null/omitted means "never synced this entity before — send everything." */
  since: z.coerce.date().nullable().optional(),
});

export type SyncPullInput = z.infer<typeof syncPullSchema>;

export const syncCountsSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entities: z.array(entityEnum).min(1),
});

export type SyncCountsInput = z.infer<typeof syncCountsSchema>;

/** Backs the pre-approval live check (see sync-service.ts's getRowStatus) — a stock request/sale
 * void/sale return needs to confirm no OTHER device has already decided it before this one creates
 * a real side effect (a stock movement), not just after the fact via the normal push/pull cycle. */
export const syncRowStatusSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entity: entityEnum,
  id: z.string().trim().min(1),
});

export type SyncRowStatusInput = z.infer<typeof syncRowStatusSchema>;
