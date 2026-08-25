import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

export type MobileProductListItem = {
  id: string;
  name: string;
  sku: string;
  categoryName: string | null;
  /** Needed for mobile checkout's cart preview — the SAME product-catalog fields DESKTOP's own
   * Checkout screen shows. Never trusted server-side for the actual sale total (mobile-checkout-
   * service.ts always re-fetches the real Product row and recomputes) — display/preview only. */
  sellingPriceCents: number;
  taxType: string;
  /** This product's own inclusive/exclusive override, or null to fall back to the tenant default
   * (MobileSessionInfo.pricesTaxInclusive) — same resolveProductTaxConfig contract DESKTOP and
   * mobile-checkout-service.ts already use. Needed client-side so Checkout's cart preview can show
   * the REAL tax-inclusive total instead of a naive pre-tax sum (caught live: a tax-exclusive
   * product's cart showed a total the cashier could never actually collect, since SERVER's real
   * checkout total — computed via this same field — was always higher — 2026-08-25). */
  pricesTaxInclusive: boolean | null;
  /** The floor a cashier's price override/discount can never push this line below — null means no
   * floor. Needed client-side so Checkout's price-override field can warn before submit, matching
   * mobile-checkout-service.ts's own authoritative check. */
  minimumPriceCents: number | null;
  reorderLevel: number;
  /** Physical quantity sitting at the tenant's Main Store (distribution center) location, or null
   * if this tenant has no Main Store location at all. Combines what DESKTOP's own Main Store screen
   * calls "unallocated" and "allocated but not yet shipped" — that finer split lives in a SQLite-only
   * table that never syncs to Postgres (not even between two DESKTOP devices), so it can't be
   * reconstructed here. This number is the honest, always-correct total still sitting centrally. */
  mainStoreQuantity: number | null;
  /** Physical quantity actually on hand across every storefront (i.e. every non-Main-Store
   * location) combined — stock that has actually been moved out, not just earmarked. */
  storefrontQuantity: number;
  totalQuantity: number;
  lowStock: boolean;
  outOfStock: boolean;
};

/**
 * Every active, stock-tracked product with its current quantity split between the Main Store
 * (distribution center) and storefronts — derived from the same StockMovement ledger that already
 * powers the dashboard's Stock Alerts (mobile-metrics-service.ts's computeStockAlerts), just grouped
 * by location as well as product so the Main-Store/storefront split falls out of the same query.
 * Low/out-of-stock thresholds are IDENTICAL to that existing function (quantity <= 0 = out of
 * stock; 0 < reorderLevel and quantity < reorderLevel = low stock) — one source of truth for what
 * "low stock" means across the whole Owner App.
 */
export async function listProducts(tenantId: string): Promise<MobileProductListItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [products, categories, mainStoreLocation, movementSums] = await Promise.all([
      tx.product.findMany({
        where: { tenantId, trackStock: true, status: "active" },
        select: {
          id: true,
          name: true,
          sku: true,
          categoryId: true,
          reorderLevel: true,
          sellingPriceCents: true,
          taxType: true,
          pricesTaxInclusive: true,
          minimumPriceCents: true,
        },
        orderBy: { name: "asc" },
      }),
      tx.category.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      // Mirrors DESKTOP's own findMainStoreLocationRow — only "distribution_center" is actually used
      // at runtime there, even though "warehouse" is reserved in the type options too.
      tx.location.findFirst({ where: { tenantId, locationType: "distribution_center" }, select: { id: true } }),
      tx.stockMovement.groupBy({ by: ["productId", "locationId"], where: { tenantId }, _sum: { quantityChange: true } }),
    ]);

    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
    const mainStoreLocationId = mainStoreLocation?.id ?? null;

    const mainStoreQtyByProduct = new Map<string, number>();
    const storefrontQtyByProduct = new Map<string, number>();
    for (const row of movementSums) {
      const qty = row._sum.quantityChange ?? 0;
      if (mainStoreLocationId && row.locationId === mainStoreLocationId) {
        mainStoreQtyByProduct.set(row.productId, (mainStoreQtyByProduct.get(row.productId) ?? 0) + qty);
      } else {
        storefrontQtyByProduct.set(row.productId, (storefrontQtyByProduct.get(row.productId) ?? 0) + qty);
      }
    }

    return products.map((product) => {
      const mainStoreQuantity = mainStoreLocationId ? (mainStoreQtyByProduct.get(product.id) ?? 0) : null;
      const storefrontQuantity = storefrontQtyByProduct.get(product.id) ?? 0;
      const totalQuantity = (mainStoreQuantity ?? 0) + storefrontQuantity;

      return {
        id: product.id,
        name: product.name,
        sku: product.sku,
        categoryName: product.categoryId ? (categoryNameById.get(product.categoryId) ?? null) : null,
        sellingPriceCents: product.sellingPriceCents,
        taxType: product.taxType,
        pricesTaxInclusive: product.pricesTaxInclusive,
        minimumPriceCents: product.minimumPriceCents,
        reorderLevel: product.reorderLevel,
        mainStoreQuantity,
        storefrontQuantity,
        totalQuantity,
        lowStock: totalQuantity > 0 && product.reorderLevel > 0 && totalQuantity < product.reorderLevel,
        outOfStock: totalQuantity <= 0,
      };
    });
  });
}
