import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { isStorefrontLocationType } from "./mobile-sales-service.js";

export type MobileProductStorefrontStock = { locationId: string; locationName: string; quantity: number };

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
  /** Auto-pricing at a quantity threshold — null wholesalePriceCents or a zero/negative
   * wholesaleMinQuantity means this product has no wholesale tier at all. Matches DESKTOP's own
   * cart-pricing.ts computeLinePricing condition exactly. */
  wholesalePriceCents: number | null;
  wholesaleMinQuantity: number;
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
  /** Same total as storefrontQuantity, broken out per storefront — every active storefront-type
   * location for the tenant appears here, even at 0 (mirrors DESKTOP's own StockByLocationRow.tsx,
   * which shows "Storefront B: 0" rather than omitting it). */
  storefrontBreakdown: MobileProductStorefrontStock[];
  totalQuantity: number;
  lowStock: boolean;
  outOfStock: boolean;
};

/**
 * Every active, stock-tracked product with its current quantity split between the Main Store
 * (distribution center) and storefronts — read from the `inventory` running-balance table (see that
 * Prisma model's own doc comment) rather than summed live from the StockMovement ledger. Grouped by
 * location as well as product so the Main-Store/storefront split falls out of one query, same shape
 * as before. Low/out-of-stock thresholds are IDENTICAL to mobile-metrics-service.ts's own
 * computeStockAlerts (quantity <= 0 = out of stock; 0 < reorderLevel and quantity < reorderLevel =
 * low stock) — one source of truth for what "low stock" means across the whole Owner App.
 */
export async function listProducts(tenantId: string): Promise<MobileProductListItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [products, categories, locations, balances] = await Promise.all([
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
          wholesalePriceCents: true,
          wholesaleMinQuantity: true,
        },
        orderBy: { name: "asc" },
      }),
      tx.category.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true, locationType: true } }),
      tx.inventory.findMany({ where: { tenantId }, select: { productId: true, locationId: true, quantity: true } }),
    ]);

    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
    // Mirrors DESKTOP's own findMainStoreLocationRow — only "distribution_center" is actually used at
    // runtime there, even though "warehouse" is reserved in the type options too.
    const mainStoreLocationId = locations.find((l) => l.locationType === "distribution_center")?.id ?? null;
    const storefronts = locations.filter((l) => isStorefrontLocationType(l.locationType));

    // qtyByProductThenLocation: productId -> locationId -> quantity, so both the Main Store figure
    // and each storefront's own figure fall out of the same single balances query.
    const qtyByProductThenLocation = new Map<string, Map<string, number>>();
    for (const row of balances) {
      const byLocation = qtyByProductThenLocation.get(row.productId) ?? new Map<string, number>();
      byLocation.set(row.locationId, row.quantity);
      qtyByProductThenLocation.set(row.productId, byLocation);
    }

    return products.map((product) => {
      const byLocation = qtyByProductThenLocation.get(product.id);
      const mainStoreQuantity = mainStoreLocationId ? (byLocation?.get(mainStoreLocationId) ?? 0) : null;
      const storefrontBreakdown: MobileProductStorefrontStock[] = storefronts.map((location) => ({
        locationId: location.id,
        locationName: location.locationName,
        quantity: byLocation?.get(location.id) ?? 0,
      }));
      const storefrontQuantity = storefrontBreakdown.reduce((sum, entry) => sum + entry.quantity, 0);
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
        wholesalePriceCents: product.wholesalePriceCents,
        wholesaleMinQuantity: product.wholesaleMinQuantity,
        reorderLevel: product.reorderLevel,
        mainStoreQuantity,
        storefrontQuantity,
        storefrontBreakdown,
        totalQuantity,
        lowStock: totalQuantity > 0 && product.reorderLevel > 0 && totalQuantity < product.reorderLevel,
        outOfStock: totalQuantity <= 0,
      };
    });
  });
}
