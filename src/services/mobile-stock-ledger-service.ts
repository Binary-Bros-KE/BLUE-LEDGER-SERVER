import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

export type MobileStockMovementType = "purchase" | "sale" | "transfer_in" | "transfer_out" | "return" | "damage" | "adjustment" | "opening_stock";

export type MobileStockMovement = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  locationId: string;
  locationName: string;
  movementType: MobileStockMovementType;
  quantityChange: number;
  /** Quantity moved x the product's CURRENT buying price — a live snapshot, not a price frozen at
   * the time of the movement, matching DESKTOP's own mapStockMovementFeedRow exactly. */
  valueCents: number;
  notes: string | null;
  createdAt: string;
  currency: string;
};

/**
 * Every stock movement across every product — the Stock Ledger, ported from DESKTOP's own
 * listAllStockMovements/StockLedgerRoute.tsx. Same recency-cap philosophy as every other Owner App
 * list (200 most recent rows, not real pagination) rather than DESKTOP's year-filterable 300/5000
 * cap — no other Owner App tab has a Year filter either.
 */
export async function listStockMovements(tenantId: string, locationId: string | null): Promise<MobileStockMovement[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const movements = await tx.stockMovement.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 200,
    });

    const productIds = [...new Set(movements.map((m) => m.productId))];
    const locationIds = [...new Set(movements.map((m) => m.locationId))];
    const [products, locations] = await Promise.all([
      tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, buyingPriceCents: true } }),
      tx.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, locationName: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));

    return movements.map((movement) => {
      const product = productById.get(movement.productId);
      return {
        id: movement.id,
        productId: movement.productId,
        productName: product?.name ?? "Unknown product",
        sku: product?.sku ?? "—",
        locationId: movement.locationId,
        locationName: locationNameById.get(movement.locationId) ?? "—",
        movementType: movement.movementType as MobileStockMovementType,
        quantityChange: movement.quantityChange,
        valueCents: Math.abs(movement.quantityChange) * (product?.buyingPriceCents ?? 0),
        notes: movement.notes,
        createdAt: movement.localCreatedAt.toISOString(),
        currency: tenant.currency,
      };
    });
  });
}
