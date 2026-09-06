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
  // base64 of a ≤5 MB file inflates to ~6.9 MB of text; 9 MB ceiling leaves headroom for the
  // JSON envelope under the route's dedicated 12 MB body limit.
  dataBase64: z.string().min(1).max(9_000_000),
});

export const productImageDeleteSchema = z.object({
  productId: z.string().trim().min(1).max(64),
  url: z.string().trim().url().max(2048),
});

export type StoreConfigUpdateInput = z.infer<typeof storeConfigUpdateSchema>;
export type ProductImageUploadInput = z.infer<typeof productImageUploadSchema>;
export type ProductImageDeleteInput = z.infer<typeof productImageDeleteSchema>;
