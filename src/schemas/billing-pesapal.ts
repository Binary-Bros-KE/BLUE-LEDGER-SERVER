import { z } from "zod";

/** License-key-authenticated, same auth model as billing-mpesa.ts — a tenant paying for their OWN
 * subscription, initiated directly from DESKTOP (sometimes before any employee is logged in, from
 * the lockout screen itself). */
const licenseKeyField = { licenseKey: z.string().trim().min(1, "License key is required") };

export const billingPesapalSubmitOrderSchema = z.object({
  ...licenseKeyField,
  /** How many billing periods this order covers, starting from the subscription's current
   * nextDueDate — see billing-mpesa's identical field. Forced to 1 server-side when
   * enrollAutoBilling is true (see billing-pesapal-service.ts). */
  periodCount: z.coerce.number().int().min(1).max(24),
  /** True only for the dedicated "Setup Auto Billing" button — see PayNowModal.tsx and
   * pesapal-client.ts's SubmitOrderParams comment on why this is kept a separate, explicit flag
   * rather than inferred. */
  enrollAutoBilling: z.boolean().default(false),
  deviceId: z.string().trim().min(1).optional(),
});
export type BillingPesapalSubmitOrderInput = z.infer<typeof billingPesapalSubmitOrderSchema>;

export const billingPesapalStatusSchema = z.object({
  ...licenseKeyField,
  orderTrackingId: z.string().trim().min(1),
});
export type BillingPesapalStatusInput = z.infer<typeof billingPesapalStatusSchema>;

/** Admin-dashboard equivalents — a staff account triggering/checking a Pesapal order on a client's
 * behalf, identified by tenantId directly instead of a license key. requireAuth at the route layer
 * is what actually authorizes this — these schemas only validate shape. */
export const billingPesapalAdminSubmitOrderSchema = z.object({
  tenantId: z.string().trim().min(1),
  periodCount: z.coerce.number().int().min(1).max(24),
  enrollAutoBilling: z.boolean().default(false),
});
export type BillingPesapalAdminSubmitOrderInput = z.infer<typeof billingPesapalAdminSubmitOrderSchema>;

export const billingPesapalAdminStatusSchema = z.object({
  tenantId: z.string().trim().min(1),
  orderTrackingId: z.string().trim().min(1),
});
export type BillingPesapalAdminStatusInput = z.infer<typeof billingPesapalAdminStatusSchema>;
