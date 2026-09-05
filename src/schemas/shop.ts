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

export const shopPublishSchema = z
  .object({
    published: z.boolean(),
    productIds: z.array(z.string().trim().min(1)).max(5000).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (v.productIds?.length ?? 0) > 0, "Pass productIds or all:true");

export type ShopProvisionInput = z.infer<typeof shopProvisionSchema>;
export type ShopUpdateInput = z.infer<typeof shopUpdateSchema>;
export type ShopDomainInput = z.infer<typeof shopDomainSchema>;
export type ShopPublishInput = z.infer<typeof shopPublishSchema>;
