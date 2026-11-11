import type { Prisma } from "@prisma/client";

/** Match DESKTOP reconcileAllSupplierBalances. Purchase-linked ledger entries are audit history,
 * including legacy multi-device corrections; only standalone adjustments affect this calculation.
 * Keep signed balances (supplier credits offset debts) and include every purchase status, as desktop does.
 */
export async function supplierBalances(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  tenantId: string,
  supplierId: string | null = null,
): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<Array<{ id: string; balanceCents: bigint | number }>>`
    SELECT s.id,
      COALESCE((
        SELECT SUM(
          (CASE WHEN p."receivedValueCents" > 0
            THEN p."receivedValueCents" + p."shippingCostCents"
            ELSE p."receivedValueCents" END) - p."amountPaidCents"
        ) FROM purchases p WHERE p."supplierId" = s.id AND p."tenantId" = s."tenantId"
      ), 0)
      + COALESCE((
        SELECT SUM(e."amountCents") FROM supplier_balance_entries e
        WHERE e."supplierId" = s.id AND e."tenantId" = s."tenantId" AND e."referenceId" IS NULL
      ), 0) AS "balanceCents"
    FROM suppliers s
    WHERE s."tenantId" = ${tenantId} AND s.id = COALESCE(${supplierId}, s.id)
  `;
  return new Map(rows.map(row => [row.id, Number(row.balanceCents)]));
}
