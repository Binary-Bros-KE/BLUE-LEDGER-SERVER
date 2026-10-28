import { z } from "zod";

// --- Admin (dashboard Dropshipping panel — /tenants/:id/dropship) --------------------------------

/** Connect this (reseller) tenant to a supplier tenant whose stock it reflects. */
export const dropshipConnectionCreateSchema = z.object({
  supplierTenantId: z.string().trim().min(1, "Choose a supplier store"),
  /** The reseller's own location that holds the reflected quantity (normally its selling storefront). */
  targetLocationId: z.string().trim().min(1, "Choose the location that holds the supplier's stock"),
  autoImport: z.boolean().default(true),
});

export type DropshipConnectionCreateInput = z.infer<typeof dropshipConnectionCreateSchema>;

export const dropshipConnectionUpdateSchema = z.object({
  targetLocationId: z.string().trim().min(1).optional(),
  status: z.enum(["active", "paused"]).optional(),
  autoImport: z.boolean().optional(),
});

export type DropshipConnectionUpdateInput = z.infer<typeof dropshipConnectionUpdateSchema>;

/** Link supplier products to the reseller's catalogue: existing reseller products are matched by
 * barcode, then SKU, then name; with importMissing, the rest are created as new reseller products. */
export const dropshipCatalogSyncSchema = z.object({
  importMissing: z.boolean().default(true),
});

export type DropshipCatalogSyncInput = z.infer<typeof dropshipCatalogSyncSchema>;
