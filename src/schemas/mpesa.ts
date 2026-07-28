import { z } from "zod";

const deviceContextFields = {
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
};

export const mpesaSettingsGetSchema = z.object({
  ...deviceContextFields,
  locationId: z.string().trim().min(1),
});
export type MpesaSettingsGetInput = z.infer<typeof mpesaSettingsGetSchema>;

export const mpesaSettingsSaveSchema = z.object({
  ...deviceContextFields,
  locationId: z.string().trim().min(1),
  environment: z.enum(["sandbox", "production"]),
  consumerKey: z.string().trim().min(1, "Consumer Key is required"),
  consumerSecret: z.string().trim().min(1, "Consumer Secret is required"),
  passkey: z.string().trim().min(1, "Passkey is required"),
  shortcode: z.string().trim().min(1, "Shortcode is required"),
  tillNumber: z.string().trim().min(1, "Till Number is required"),
  accountReference: z.string().trim().max(120).optional().default(""),
});
export type MpesaSettingsSaveInput = z.infer<typeof mpesaSettingsSaveSchema>;

export const mpesaConfiguredSchema = z.object({
  ...deviceContextFields,
  locationId: z.string().trim().min(1),
});
export type MpesaConfiguredInput = z.infer<typeof mpesaConfiguredSchema>;

export const mpesaStkPushSchema = z.object({
  ...deviceContextFields,
  locationId: z.string().trim().min(1),
  phone: z.string().trim().min(9, "Enter a valid phone number"),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0"),
  employeeId: z.string().trim().min(1).optional(),
});
export type MpesaStkPushInput = z.infer<typeof mpesaStkPushSchema>;

export const mpesaStatusSchema = z.object({
  ...deviceContextFields,
  checkoutRequestId: z.string().trim().min(1),
});
export type MpesaStatusInput = z.infer<typeof mpesaStatusSchema>;
