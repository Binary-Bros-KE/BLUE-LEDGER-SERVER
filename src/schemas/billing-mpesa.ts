import { z } from "zod";

/** License-key-authenticated, same auth model as activation.ts — this is a tenant paying for their
 * OWN subscription, initiated directly from DESKTOP (sometimes before any employee is even logged
 * in, from the lockout screen itself), not a device-scoped/employee-scoped action. */
const licenseKeyField = { licenseKey: z.string().trim().min(1, "License key is required") };

export const billingMpesaStkPushSchema = z.object({
  ...licenseKeyField,
  phone: z.string().trim().min(9, "Enter a valid phone number"),
  /** How many billing periods (months, or years for a YEARLY/maintenance subscription) this single
   * push should cover, starting from the subscription's current nextDueDate — 1 just clears what's
   * currently due, more prepays ahead. */
  periodCount: z.coerce.number().int().min(1).max(24),
  deviceId: z.string().trim().min(1).optional(),
});
export type BillingMpesaStkPushInput = z.infer<typeof billingMpesaStkPushSchema>;

export const billingMpesaStatusSchema = z.object({
  ...licenseKeyField,
  checkoutRequestId: z.string().trim().min(1),
});
export type BillingMpesaStatusInput = z.infer<typeof billingMpesaStatusSchema>;
