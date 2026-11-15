/**
 * Mark Point (client request): one multiplier between a product's buying and selling price, set in
 * Business Profile — mark point 1.33 means selling = buying x 1.33, and buying = selling / 1.33.
 *
 * Worked in the unit prices are typed in (per kg for a product sold by weight — see product-units.ts,
 * where prices are stored per base unit and may be fractional), then stored back per base unit.
 * Selling rounds UP to the whole shilling and buying rounds DOWN, so rounding never takes the margin
 * below the mark point.
 *
 * Copied verbatim from DESKTOP (shared/lib/mark-point.ts) — keep the copies (SERVER, APP) in sync by hand,
 * same as product-units.ts.
 */

export type MarkPointSettings = {
  markPointEnabled: boolean;
  markPoint: number | null;
  markPointStrict: boolean;
};

/** The mark point to use, or null when it's off (or never set). */
export function activeMarkPoint(settings: MarkPointSettings | null | undefined): number | null {
  if (!settings?.markPointEnabled || !settings.markPoint || settings.markPoint <= 1) return null;
  return settings.markPoint;
}

/** The mark point when strict mode should fill prices in automatically, else null. */
export function strictMarkPoint(settings: MarkPointSettings | null | undefined): number | null {
  return settings?.markPointStrict ? activeMarkPoint(settings) : null;
}

const SHILLING_CENTS = 100;
// Float noise: 300 x 1.33 is 399.00000000000006, which must still be 399.
const EPSILON = 1e-6;

/** Selling price per base unit from a buying price per base unit. `priceFactor` = base units per price
 * unit (1000 for a product priced per kg and stocked in grams; 1 otherwise). */
export function sellingFromBuying(buyingCents: number, markPoint: number, priceFactor = 1): number {
  const shillings = (buyingCents * priceFactor * markPoint) / SHILLING_CENTS;
  return (Math.ceil(shillings - EPSILON) * SHILLING_CENTS) / priceFactor;
}

/** Buying price per base unit from a selling price per base unit. */
export function buyingFromSelling(sellingCents: number, markPoint: number, priceFactor = 1): number {
  const shillings = (sellingCents * priceFactor) / markPoint / SHILLING_CENTS;
  return (Math.floor(shillings + EPSILON) * SHILLING_CENTS) / priceFactor;
}

/** What Apply Mark Point does to a product that already has both prices. */
export type MarkPointBothPricesMode = "skip" | "selling_from_buying" | "buying_from_selling";

export type MarkPointPlan =
  | { action: "update"; buyingPriceCents: number; sellingPriceCents: number; changed: "selling" | "buying" }
  | { action: "skip"; reason: "no_prices" | "has_both" | "unchanged" };

/**
 * One product under Apply Mark Point: a missing price is always filled from the other; with both, the
 * chosen mode decides. A price of 0 counts as missing.
 */
export function planMarkPoint(
  product: { buyingPriceCents: number; sellingPriceCents: number; priceFactor?: number },
  markPoint: number,
  bothPrices: MarkPointBothPricesMode
): MarkPointPlan {
  const factor = product.priceFactor ?? 1;
  const hasBuying = product.buyingPriceCents > 0;
  const hasSelling = product.sellingPriceCents > 0;
  if (!hasBuying && !hasSelling) return { action: "skip", reason: "no_prices" };

  let direction: "selling" | "buying";
  if (hasBuying && !hasSelling) direction = "selling";
  else if (hasSelling && !hasBuying) direction = "buying";
  else if (bothPrices === "skip") return { action: "skip", reason: "has_both" };
  else direction = bothPrices === "selling_from_buying" ? "selling" : "buying";

  const next =
    direction === "selling"
      ? { buyingPriceCents: product.buyingPriceCents, sellingPriceCents: sellingFromBuying(product.buyingPriceCents, markPoint, factor) }
      : { buyingPriceCents: buyingFromSelling(product.sellingPriceCents, markPoint, factor), sellingPriceCents: product.sellingPriceCents };
  if (Math.abs(next.buyingPriceCents - product.buyingPriceCents) < EPSILON && Math.abs(next.sellingPriceCents - product.sellingPriceCents) < EPSILON) {
    return { action: "skip", reason: "unchanged" };
  }
  return { action: "update", ...next, changed: direction };
}
