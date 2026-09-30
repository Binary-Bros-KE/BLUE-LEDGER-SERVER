import type { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Website price markup (web_stores.pricingJson): every POS price shown or charged on the website is
 * the POS price + `markupPercent`, rounded to the nearest `roundTo` (whole currency units — 10 →
 * KES 1,667 becomes 1,670). A product's own website price override (Product.onlinePriceCents) is
 * used exactly as set — never marked up. Applied at read time, so it follows every POS price change
 * and new product automatically, and 0% turns it off. ONE place computes shopper prices from here:
 * the catalog, product page, price filter/sort AND order pricing all go through these helpers, so
 * what a shopper sees is always what the order charges.
 */
export type WebPricing = { markupPercent: number; roundTo: number };

export const ROUND_TO_OPTIONS = [1, 5, 10, 50, 100] as const;

export const webPricingSchema = z.object({
  markupPercent: z.number().min(0).max(500),
  roundTo: z.number().refine((n) => (ROUND_TO_OPTIONS as readonly number[]).includes(n), "Round to 1, 5, 10, 50 or 100"),
});

export const NO_MARKUP: WebPricing = { markupPercent: 0, roundTo: 1 };

export function readWebPricing(json: Prisma.JsonValue | null | undefined): WebPricing {
  const parsed = webPricingSchema.safeParse(json);
  return parsed.success ? parsed.data : NO_MARKUP;
}

/** A POS price (cents) → its website price. */
export function markUp(cents: number, pricing: WebPricing): number {
  if (!pricing.markupPercent) return cents;
  const step = pricing.roundTo * 100;
  return Math.round((cents * (1 + pricing.markupPercent / 100)) / step) * step;
}

/** The product's website price: its own website override as-is, else the marked-up POS price. */
export function shopperPrice(row: { onlinePriceCents: number | null; sellingPriceCents: number }, pricing: WebPricing): number {
  return row.onlinePriceCents ?? markUp(row.sellingPriceCents, pricing);
}

/** A shared-stock variant's website price: its own POS price marked up, else the product's. */
export function shopperVariantPrice(variant: { priceCents: number | null }, productShopperPrice: number, pricing: WebPricing): number {
  return variant.priceCents !== null ? markUp(variant.priceCents, pricing) : productShopperPrice;
}
