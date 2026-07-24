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
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
