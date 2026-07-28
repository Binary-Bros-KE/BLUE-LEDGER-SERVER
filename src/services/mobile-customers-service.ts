import { withTenantContext } from "../lib/tenant-context.js";
import { buildSharedStatement, type SharedStatementResult } from "./share-service.js";

export type MobileCustomer = { id: string; name: string; phone: string };

/** Backs the Owner App's "Generate Statement" customer picker — same search-a-customer flow
 * DESKTOP's InvoicesRoute.tsx already has for this exact feature, just a fresh lookup since no other
 * mobile tab needed a customer list yet. */
export async function listCustomers(tenantId: string): Promise<MobileCustomer[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.customer.findMany({
      where: { tenantId, status: "active" },
      select: { id: true, name: true, phone: true },
      orderBy: { name: "asc" },
    }),
  );
}

/** The owner viewing their own tenant's own customer's statement — a plain authenticated read via
 * the exact same view-model the Share feature renders (buildSharedStatement), not a public-token
 * lookup, same reasoning as mobile-sales-service.ts's getSale. */
export async function getStatement(tenantId: string, customerId: string): Promise<SharedStatementResult | null> {
  return buildSharedStatement(tenantId, customerId);
}
