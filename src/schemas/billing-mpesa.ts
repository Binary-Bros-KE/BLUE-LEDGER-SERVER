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

/** Admin-dashboard equivalent of the two schemas above — a SUPER_ADMIN triggering/checking a
 * billing STK push on a client's behalf (e.g. over a support call), so it identifies the tenant
 * directly by id (the admin is already looking at that tenant's page) instead of a license key.
 * requireSuperAdmin at the route layer is what actually authorizes this — these schemas only
 * validate shape. */
export const billingMpesaAdminStkPushSchema = z.object({
  tenantId: z.string().trim().min(1),
  phone: z.string().trim().min(9, "Enter a valid phone number"),
  periodCount: z.coerce.number().int().min(1).max(24),
});
export type BillingMpesaAdminStkPushInput = z.infer<typeof billingMpesaAdminStkPushSchema>;

export const billingMpesaAdminStatusSchema = z.object({
  tenantId: z.string().trim().min(1),
  checkoutRequestId: z.string().trim().min(1),
});
export type BillingMpesaAdminStatusInput = z.infer<typeof billingMpesaAdminStatusSchema>;
