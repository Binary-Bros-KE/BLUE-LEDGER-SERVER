/**
 * Shape + merge helpers for the "Trylist" storefront theme's config, stored in
 * `web_stores.themeJson`. Everything is optional — an empty `{}` means "use the theme's built-in
 * defaults" (the storefront falls back field by field). A second theme later gets its own shape;
 * `name` is the selector.
 *
 * Mirrored (structurally) in NEXT/storefront and DESKTOP — keep the three in sync.
 */

export type TrylistCta = { label?: string; href?: string };

export type TrylistStoryRow = {
  imageUrl?: string;
  title?: string;
  body?: string;
  ctaLabel?: string;
  ctaHref?: string;
};

/** A curated products row on the home page: a heading + one category's products + a "see all" CTA. */
export type TrylistProductSection = {
  title?: string;
  categoryId?: string;
  ctaLabel?: string;
};

/** Hero right-rail tile 1 (red). "Deal of the week" is a static label, not part of this config —
 * only the fields below are editable. priceCents/offerPriceCents drive an auto-calculated discount
 * badge storefront-side; the percentage itself is never stored (see NEXT/storefront DealTile.tsx). */
export type TrylistDealTile = {
  title?: string;
  priceCents?: number;
  offerPriceCents?: number;
  ctaLabel?: string;
  ctaHref?: string;
  imageUrl?: string;
};

/** Hero right-rail tile 2 (cream). A single featured category highlight — categoryLabel is free
 * text (like every other theme copy field), not a live category id/filter. */
export type TrylistTradeTile = {
  categoryLabel?: string;
  title?: string;
  description?: string;
  ctaLabel?: string;
  ctaHref?: string;
  imageUrl?: string;
};

/** Header logo — an uploaded mark that replaces the letter-square, plus the two-line store name. */
export type TrylistBrand = {
  logoImageUrl?: string;
  nameLine1?: string;
  nameLine2?: string;
};

/** The navy strip above the header. `announcement` is the promo line; contact + track-order live
 * here too but track-order is inert for now. */
export type TrylistTopBar = {
  announcement?: string;
};

/** Channels shown in the "Contact us" pop-up (triggered from the top bar + CTAs). Each is
 * optional; the modal only renders the ones that have a value. */
export type TrylistContact = {
  whatsappSalesLabel?: string;
  whatsappSalesNumber?: string;
  whatsappSupportLabel?: string;
  whatsappSupportNumber?: string;
  email?: string;
  instagram?: string;
  facebook?: string;
};

export type TrylistTheme = {
  name?: "trylist";
  brand?: TrylistBrand;
  topBar?: TrylistTopBar;
  contact?: TrylistContact;
  hero?: {
    headline?: string;
    sub?: string;
    primaryCta?: TrylistCta;
    secondaryCta?: TrylistCta;
    shotImageUrl?: string;
    backgroundImageUrl?: string;
  };
  /** 0–3 image+text blocks rendered below the fold on the home page. */
  story?: TrylistStoryRow[];
  /** categoryId → image URL, used for both the home grid tile and the /products/<cat> header. */
  categoryImages?: Record<string, string>;
  /** Fallback background for the page-header band (breadcrumb + title) on /products, and on any
   * category / product-detail header whose category has no image of its own. */
  headerImageUrl?: string;
  /** 0–6 curated category rows on the home page (Best Sellers, New Arrivals, …). Empty = fall
   * back to the single default product grid. */
  productSections?: TrylistProductSection[];
  dealTile?: TrylistDealTile;
  tradeTile?: TrylistTradeTile;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges `patch` into `base`:
 *  - plain objects merge key by key,
 *  - a `null` value deletes that key,
 *  - arrays and scalars replace wholesale (so `story` is set by sending the whole new array).
 * Returns a new object; neither input is mutated.
 */
export function mergeTheme(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeTheme(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Reads the string at a dotted path (`hero.shotImageUrl`, `categoryImages.cat_x`), or null. */
export function readThemePath(theme: Record<string, unknown>, path: string[]): string | null {
  let node: unknown = theme;
  for (const seg of path) {
    if (!isPlainObject(node) && !Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : null;
}

/** Returns a new theme object with `value` (or deletion, when null) applied at the dotted path,
 * creating intermediate objects as needed. */
export function writeThemePath(
  theme: Record<string, unknown>,
  path: string[],
  value: string | null,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return theme;
  const out: Record<string, unknown> = { ...theme };
  if (rest.length === 0) {
    if (value === null) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = isPlainObject(out[head]) ? (out[head] as Record<string, unknown>) : {};
  out[head] = writeThemePath(child, rest, value);
  return out;
}
