import { z } from "zod";

const nameField = z.string().trim().min(1, "Name is required").max(200);
const createOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
const updateOptionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const outletCreateSchema = z.object({
  name: nameField,
  location: createOptionalText(200),
  notes: createOptionalText(2000),
});

export type OutletCreateInput = z.infer<typeof outletCreateSchema>;

export const outletUpdateSchema = z.object({
  name: nameField.optional(),
  location: updateOptionalText(200),
  notes: updateOptionalText(2000),
});

export type OutletUpdateInput = z.infer<typeof outletUpdateSchema>;

/** The Till (Buy Goods) this outlet's own tenants pay their software subscription/maintenance
 * into — same shape as the desktop app's per-storefront mpesaSettingsSaveSchema, deliberately
 * mirrored so the two features stay easy to reason about together. */
export const outletMpesaSettingsSaveSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  consumerKey: z.string().trim().min(1, "Consumer Key is required"),
  consumerSecret: z.string().trim().min(1, "Consumer Secret is required"),
  passkey: z.string().trim().min(1, "Passkey is required"),
  shortcode: z.string().trim().min(1, "Shortcode is required"),
  tillNumber: z.string().trim().min(1, "Till Number is required"),
  accountReference: z.string().trim().max(120).optional().default(""),
});

export type OutletMpesaSettingsSaveInput = z.infer<typeof outletMpesaSettingsSaveSchema>;
