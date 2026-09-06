import { z } from "zod";

/** GET /shop/catalog query. Cursor-less offset paging is fine here — a public catalog is small
 * (hundreds to low thousands of published products) and the storefront renders category pages, not
 * an infinite feed. */
export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(24),
  categoryId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
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

export const shopProvisionSchema = z.object({
  subdomain: subdomainSchema,
  currency: currencySchema.optional(),
  fulfilmentLocationId: z.string().trim().min(1).nullish(),
  customDomain: hostnameSchema.optional(),
});

export const shopUpdateSchema = z
  .object({
    subdomain: subdomainSchema.optional(),
    currency: currencySchema.optional(),
    fulfilmentLocationId: z.string().trim().min(1).nullish(),
    status: z.enum(["DRAFT", "LIVE", "SUSPENDED"]).optional(),
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

/** Partial Trylist theme — deep-merged into web_stores.themeJson (see lib/trylist-theme.ts).
 * Hero/story/category *images* are set via /shop-admin/theme/upload + this endpoint (the desktop
 * uploads, gets a URL, then sends it here). `null` on any field clears it. */
// NOT .strict() at the top level — the device sends `{ tenantId, deviceId, ...patch }` and those
// two must be stripped, not rejected (requireDevice already validated them). Unknown *theme* keys
// are still caught by the nested .strict() objects.
export const themeUpdateSchema = z
  .object({
    name: z.literal("trylist").optional(),
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
    productSections: z.array(themeProductSectionSchema).max(6).optional(),
  })
  .refine(
    (v) => ["name", "hero", "story", "categoryImages", "productSections"].some((k) => k in v),
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

export type StoreConfigUpdateInput = z.infer<typeof storeConfigUpdateSchema>;
export type ProductImageUploadInput = z.infer<typeof productImageUploadSchema>;
export type ProductImageDeleteInput = z.infer<typeof productImageDeleteSchema>;
export type ThemeUpdateInput = z.infer<typeof themeUpdateSchema>;
export type ThemeImageUploadInput = z.infer<typeof themeImageUploadSchema>;
export type DeliveryMethodCreateInput = z.infer<typeof deliveryMethodCreateSchema>;
export type DeliveryMethodUpdateInput = z.infer<typeof deliveryMethodUpdateSchema>;
