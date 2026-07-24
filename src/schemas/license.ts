import { z } from "zod";

const LICENSE_STATUSES = ["TRIAL", "ACTIVE", "SUSPENDED", "CANCELLED"] as const;
const SUSPENSION_REASONS = ["PAYMENT_OVERDUE", "FRAUD", "MANUAL", "CUSTOMER_REQUESTED"] as const;

export const licenseSuspendSchema = z.object({
  reason: z.enum(SUSPENSION_REASONS),
});

export type LicenseSuspendInput = z.infer<typeof licenseSuspendSchema>;

/** General-purpose edit — lets a super admin set the status directly (e.g. TRIAL → ACTIVE without
 * going through suspend/reactivate) and set/clear the trial end date. suspensionReason is only
 * meaningful (and only persisted) when status is SUSPENDED. */
export const licenseUpdateSchema = z.object({
  status: z.enum(LICENSE_STATUSES),
  suspensionReason: z
    .enum(SUSPENSION_REASONS)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  trialEndsAt: z.coerce
    .date()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

export type LicenseUpdateInput = z.infer<typeof licenseUpdateSchema>;
