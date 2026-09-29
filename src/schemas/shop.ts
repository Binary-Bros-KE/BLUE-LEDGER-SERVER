import { z } from "zod";
import { COLOR_ROLES, STOREFRONT_TEMPLATE_IDS } from "../lib/storefront-templates.js";

/** GET /shop/catalog query. Cursor-less offset paging is fine here — a public catalog is small
 * (hundreds to low thousands of published products) and the storefront renders category pages, not
 * an infinite feed. */
export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(24),
  categoryId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  /** exact brand (case-insensitive), e.g. "Samsung" */
  brand: z.string().trim().min(1).max(60).optional(),
  /** "featured" = the long-standing default (name A→Z). Price sorts use the price shoppers see
   * (online override, else the selling price). */
  sort: z.enum(["featured", "price-asc", "price-desc", "newest"]).default("featured"),
  minPriceCents: z.coerce.number().int().min(0).max(1_000_000_000_00).optional(),
  maxPriceCents: z.coerce.number().int().min(0).max(1_000_000_000_00).optional(),
});

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

// --- Admin (dashboard onboarding — /tenants/:id/shop) ---------------------------------------------

/** A subdomain label: lowercase letters, digits, hyphens; can't start/end with a hyphen. */
const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, digits and hyphens only");

/** A bare hostname, e.g. "shop.acme.co.ke" — no scheme, no path, no port. */
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "Enter a domain like shop.acme.co.ke");

const currencySchema = z.string().trim().toUpperCase().min(2).max(5);

const templateIdSchema = z.enum(STOREFRONT_TEMPLATE_IDS);

/** "#rrggbb" — lower-cased so the stored value is canonical. */
const hexColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Use a 6-digit hex colour like #d71920");

/** Brand-colour overrides. A role that's absent or null falls back to the template default — the
 * object REPLACES the stored one wholesale (it's tiny, and "reset to default" is just omitting it). */
const themeColorsSchema = z
  .object(Object.fromEntries(COLOR_ROLES.map((r) => [r, hexColorSchema.nullish()])) as Record<
    (typeof COLOR_ROLES)[number],
    z.ZodOptional<z.ZodNullable<typeof hexColorSchema>>
  >)
  .strict();

export const shopProvisionSchema = z.object({
  subdomain: subdomainSchema,
  currency: currencySchema.optional(),
  fulfilmentLocationId: z.string().trim().min(1).nullish(),
  customDomain: hostnameSchema.optional(),
  templateId: templateIdSchema.optional(),
  themeColors: themeColorsSchema.optional(),
});

export const shopUpdateSchema = z
  .object({
    subdomain: subdomainSchema.optional(),
    currency: currencySchema.optional(),
    fulfilmentLocationId: z.string().trim().min(1).nullish(),
    status: z.enum(["DRAFT", "LIVE", "SUSPENDED"]).optional(),
    // Look & feel — admin-only (this schema is only reachable from the SUPER_ADMIN dashboard route).
    templateId: templateIdSchema.optional(),
    themeColors: themeColorsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const shopDomainSchema = z.object({
  // null clears the custom domain and drops back to the subdomain-only setup.
  customDomain: hostnameSchema.nullable(),
});

export type ShopProvisionInput = z.infer<typeof shopProvisionSchema>;
export type ShopUpdateInput = z.infer<typeof shopUpdateSchema>;
export type ShopDomainInput = z.infer<typeof shopDomainSchema>;

// --- Store owner (desktop POS — /shop-admin, device-authed) --------------------------------------
//
// The tenant runs their own online store from the POS "Online Store" tab. Publish state and
// online price/description overrides are plain synced Product columns (written locally, carried by
// the normal sync engine) — they need NO endpoint here. This surface only covers the two things
// sync can't do: pushing image *bytes* to object storage, and reading/writing the cloud-only
// `web_stores` look/delivery/payment config.

/** A free-form JSON config blob (themeJson / deliveryJson / paymentOptionsJson on web_stores).
 * Bounded to keep a single row sane; the storefront is the only reader and treats it defensively. */
const jsonBlobSchema = z.record(z.string(), z.unknown());

export const storeConfigUpdateSchema = z
  .object({
    themeJson: jsonBlobSchema.optional(),
    deliveryJson: jsonBlobSchema.optional(),
    paymentOptionsJson: jsonBlobSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const productImageUploadSchema = z.object({
  productId: z.string().trim().min(1).max(64),
  filename: z.string().trim().min(1).max(255),
  // Used only to build a human-readable, SEO-friendly object key
  // (`<slug>-<shortid>.webp`). Optional so an older desktop still works.
  productName: z.string().trim().min(1).max(200).optional(),
  // base64 of a ≤5 MB file inflates to ~6.9 MB of text; 9 MB ceiling leaves headroom for the
  // JSON envelope under the route's dedicated 12 MB body limit.
  dataBase64: z.string().min(1).max(9_000_000),
});

export const productImageDeleteSchema = z.object({
  // Optional: the same endpoint deletes theme decoration images too (URL is all it needs).
  productId: z.string().trim().min(1).max(64).optional(),
  url: z.string().trim().url().max(2048),
});

// --- Trylist theme (storefront look — /shop-admin/theme/*) ----------------------------------------

const themeCtaSchema = z
  .object({
    label: z.string().trim().max(60).nullish(),
    href: z.string().trim().max(500).nullish(),
  })
  .strict()
  .nullish();

const themeStoryRowSchema = z
  .object({
    imageUrl: z.string().trim().max(2048).nullish(),
    title: z.string().trim().max(120).nullish(),
    body: z.string().trim().max(600).nullish(),
    ctaLabel: z.string().trim().max(60).nullish(),
    ctaHref: z.string().trim().max(500).nullish(),
  })
  .strict();

const themeProductSectionSchema = z
  .object({
    title: z.string().trim().max(80).nullish(),
    categoryId: z.string().trim().max(64).nullish(),
    ctaLabel: z.string().trim().max(60).nullish(),
  })
  .strict();

/** Hero right-rail tile 1 (red, "Deal of the week" — that label itself is static, never editable).
 * priceCents/offerPriceCents drive an auto-calculated discount badge storefront-side (see
 * NEXT/storefront DealTile.tsx) — deliberately NOT storing a pre-computed percentage here, same
 * "derive, don't store" reasoning as every price computation elsewhere in this codebase. */
const themeDealTileSchema = z
  .object({
    title: z.string().trim().max(120).nullish(),
    // ≤ 1,000,000.00 in cents — same sane ceiling as deliveryMethodCreateSchema.priceCents.
    priceCents: z.number().int().min(0).max(100_000_000).nullish(),
    offerPriceCents: z.number().int().min(0).max(100_000_000).nullish(),
    ctaLabel: z.string().trim().max(60).nullish(),
    ctaHref: z.string().trim().max(500).nullish(),
    imageUrl: z.string().trim().max(2048).nullish(),
  })
  .strict();

/** Hero right-rail tile 2 (cream/grey) — a single featured category highlight, not a live
 * category filter (categoryLabel is free text, same as every other theme copy field). */
const themeTradeTileSchema = z
  .object({
    categoryLabel: z.string().trim().max(60).nullish(),
    title: z.string().trim().max(120).nullish(),
    description: z.string().trim().max(400).nullish(),
    ctaLabel: z.string().trim().max(60).nullish(),
    ctaHref: z.string().trim().max(500).nullish(),
    imageUrl: z.string().trim().max(2048).nullish(),
  })
  .strict();

/** Partial Trylist theme — deep-merged into web_stores.themeJson (see lib/trylist-theme.ts).
 * Hero/story/category *images* are set via /shop-admin/theme/upload + this endpoint (the desktop
 * uploads, gets a URL, then sends it here). `null` on any field clears it. */
// NOT .strict() at the top level — the device sends `{ tenantId, deviceId, ...patch }` and those
// two must be stripped, not rejected (requireDevice already validated them). Unknown *theme* keys
// are still caught by the nested .strict() objects.
const themeBrandSchema = z
  .object({
    logoImageUrl: z.string().trim().max(2048).nullish(),
    nameLine1: z.string().trim().max(40).nullish(),
    nameLine2: z.string().trim().max(40).nullish(),
  })
  .strict();

const themeTopBarSchema = z
  .object({
    announcement: z.string().trim().max(120).nullish(),
  })
  .strict();

/** Contact pop-up channels — numbers/handles as free text (normalised storefront-side). */
const themeContactSchema = z
  .object({
    whatsappSalesLabel: z.string().trim().max(60).nullish(),
    whatsappSalesNumber: z.string().trim().max(30).nullish(),
    whatsappSupportLabel: z.string().trim().max(60).nullish(),
    whatsappSupportNumber: z.string().trim().max(30).nullish(),
    email: z.string().trim().max(200).nullish(),
    instagram: z.string().trim().max(80).nullish(),
    facebook: z.string().trim().max(80).nullish(),
  })
  .strict();

/** Icons a trust-bar item may use — the storefront maps each key to its own icon set. */
export const TRUST_ICONS = ["truck", "shield", "phone", "returns", "card", "clock", "support", "tag", "zap", "star"] as const;

/** "Top brands" strip entry — a name (always shown if there's no logo), optional logo + link. */
const themeBrandLogoSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    logoUrl: z.string().trim().max(2048).nullish(),
    href: z.string().trim().max(500).nullish(),
  })
  .strict();

/** One trust-bar cell (e.g. truck · "Free Delivery" · "On selected items"). */
const themeTrustItemSchema = z
  .object({
    icon: z.enum(TRUST_ICONS),
    title: z.string().trim().min(1).max(40),
    subtitle: z.string().trim().max(60).nullish(),
  })
  .strict();

export const themeUpdateSchema = z
  .object({
    name: z.literal("trylist").optional(),
    brand: themeBrandSchema.optional(),
    topBar: themeTopBarSchema.optional(),
    contact: themeContactSchema.optional(),
    hero: z
      .object({
        headline: z.string().trim().max(200).nullish(),
        sub: z.string().trim().max(400).nullish(),
        primaryCta: themeCtaSchema,
        secondaryCta: themeCtaSchema,
        shotImageUrl: z.string().trim().max(2048).nullish(),
        backgroundImageUrl: z.string().trim().max(2048).nullish(),
      })
      .strict()
      .optional(),
    story: z.array(themeStoryRowSchema).max(3).optional(),
    categoryImages: z.record(z.string().min(1).max(64), z.string().trim().max(2048).nullable()).optional(),
    headerImageUrl: z.string().trim().max(2048).nullish(),
    productSections: z.array(themeProductSectionSchema).max(6).optional(),
    dealTile: themeDealTileSchema.optional(),
    tradeTile: themeTradeTileSchema.optional(),
    // Lists replace wholesale (send the full list; [] = back to the template's defaults).
    brands: z.array(themeBrandLogoSchema).max(24).optional(),
    trustBar: z.array(themeTrustItemSchema).max(4).optional(),
  })
  .refine(
    (v) =>
      ["name", "brand", "topBar", "contact", "hero", "story", "categoryImages", "headerImageUrl", "productSections", "dealTile", "tradeTile", "brands", "trustBar"].some(
        (k) => k in v,
      ),
    "Nothing to update",
  );

export const themeImageUploadSchema = z.object({
  // Only shapes the object-key filename (hero-shot / hero-background / story / category-<id>).
  slot: z.string().trim().min(1).max(80),
  filename: z.string().trim().min(1).max(255),
  dataBase64: z.string().min(1).max(9_000_000),
});

// --- Delivery methods (storefront checkout options — /shop-admin/delivery/*) ----------------------

export const deliveryMethodCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  // ≤ 1,000,000.00 in cents — a sane ceiling, not a real limit anyone hits.
  priceCents: z.coerce.number().int().min(0).max(100_000_000),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

export const deliveryMethodUpdateSchema = deliveryMethodCreateSchema
  .partial()
  .extend({ id: z.string().trim().min(1).max(64) })
  .refine((v) => Object.keys(v).length > 1, "Nothing to update");

export const deliveryMethodDeleteSchema = z.object({ id: z.string().trim().min(1).max(64) });

export const deliveryReorderSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1).max(64)).min(1).max(300),
});

// --- Online orders (storefront checkout → POS inbox) ---------------------------------------------

export const ONLINE_ORDER_STATUSES = ["NEW", "CONFIRMED", "COMPLETED", "CANCELLED"] as const;

/** POST /shop/orders — only ids + quantities are trusted from the shopper; every price, name and
 * the delivery fee are re-read server-side. */
export const shopOrderCreateSchema = z.object({
  customerName: z.string().trim().min(2, "Enter your name").max(120),
  customerPhone: z
    .string()
    .trim()
    .max(30)
    .refine((v) => v.replace(/\D/g, "").length >= 9, "Enter a valid phone number"),
  customerEmail: z.string().trim().email("Enter a valid email").max(200).nullish().or(z.literal("")),
  deliveryAddress: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  deliveryMethodId: z.string().trim().max(64).nullish(),
  /** Accepted for older storefront builds; every order is stored as "to_be_arranged" — payment is
   * agreed between the shop and the customer after the order arrives, never chosen online. */
  paymentMethod: z.enum(["to_be_arranged", "pay_on_delivery"]).optional(),
  /** Customer collects from the shop, or wants it delivered (address required then). */
  deliveryType: z.enum(["pickup", "delivery"]).default("delivery"),
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(64),
        /** a shared-stock variant's key (lib/variants.ts) — priced + validated server-side */
        variantKey: z.string().trim().min(1).max(40).nullish(),
        qty: z.number().int().min(1).max(999),
      }),
    )
    .min(1, "Your cart is empty")
    .max(100),
});

export const orderListSchema = z.object({
  status: z.enum([...ONLINE_ORDER_STATUSES, "ALL"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const orderStatusSchema = z.object({
  id: z.string().trim().min(1).max(64),
  status: z.enum(ONLINE_ORDER_STATUSES),
});

export const orderGetSchema = z.object({ id: z.string().trim().min(1).max(64) });

/** POST /shop-admin/orders/link-sale — the POS rang this order up as a (local) sale. */
export const orderLinkSaleSchema = z.object({
  id: z.string().trim().min(1).max(64),
  saleId: z.string().trim().min(1).max(80),
  receiptNumber: z.string().trim().min(1).max(40).nullish(),
});

export const orderSeenSchema = z.object({ ids: z.array(z.string().trim().min(1).max(64)).max(200).optional() });

export type ShopOrderCreateInput = z.infer<typeof shopOrderCreateSchema>;
export type OrderListInput = z.infer<typeof orderListSchema>;
export type OrderStatusInput = z.infer<typeof orderStatusSchema>;
export type OrderLinkSaleInput = z.infer<typeof orderLinkSaleSchema>;

export type StoreConfigUpdateInput = z.infer<typeof storeConfigUpdateSchema>;
export type ProductImageUploadInput = z.infer<typeof productImageUploadSchema>;
export type ProductImageDeleteInput = z.infer<typeof productImageDeleteSchema>;
export type ThemeUpdateInput = z.infer<typeof themeUpdateSchema>;
export type ThemeImageUploadInput = z.infer<typeof themeImageUploadSchema>;
export type DeliveryMethodCreateInput = z.infer<typeof deliveryMethodCreateSchema>;
export type DeliveryMethodUpdateInput = z.infer<typeof deliveryMethodUpdateSchema>;
