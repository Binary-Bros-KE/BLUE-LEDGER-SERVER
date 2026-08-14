import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Every synced-entity table (Category, PaymentMethod, Rider, Supplier, Customer, Employee, Role —
 * see the sync-model block at the end of schema.prisma) has a Postgres Row-Level Security policy
 * keyed off the `app.tenant_id` session variable. Prisma has no native RLS integration, so this is
 * the one place that variable ever gets set: every sync route MUST run its queries through this
 * wrapper rather than the bare `prisma` client, or RLS's fail-closed default means it'll just see
 * zero rows (see the migration's own comment for why that's a deliberate safety net, not a bug to
 * work around).
 *
 * `set_config(..., true)` (the `is_local` flag) scopes the setting to THIS transaction only — it
 * evaporates on commit/rollback, so there's no risk of it leaking onto a pooled connection's next,
 * unrelated request. */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  // Prisma's own interactive-transaction default (5000ms) assumes a handful of queries, not a loop
  // over an entire push batch (pushRows does up to one findUnique/findFirst + one upsert PER ROW,
  // sequentially, inside this same transaction — up to 200 rows per DESKTOP's own PUSH_BATCH_SIZE).
  // Confirmed live against a real client's production volume: even after removing the N+1
  // REQUIRED_REF_FIELDS lookups (see sync-service.ts's own comment on that fix), a 200-row batch
  // under real concurrent load still occasionally crossed 5000ms and got killed mid-commit —
  // P2028 "Transaction already closed", whose own error text literally suggests this. 30s is
  // generous headroom for legitimate per-row work, not a runaway-query band-aid.
  options?: { timeoutMs?: number },
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
  );
}
