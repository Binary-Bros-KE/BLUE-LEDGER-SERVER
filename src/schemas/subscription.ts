import { z } from "zod";

const SUBSCRIPTION_TYPES = ["MONTHLY", "LIFETIME", "CUSTOM"] as const;
const BILLING_CYCLES = ["MONTHLY", "YEARLY", "ONCE"] as const;
const BILLING_STATUSES = ["ACTIVE", "PAST_DUE", "CANCELLED"] as const;
const SUPPORT_STATUSES = ["ACTIVE", "EXPIRED", "LIFETIME"] as const;

/** Every field optional/undefined-safe — a PATCH only touches what it sends. Lives on its own
 * endpoint (not blended into tenantUpdateSchema) since changing a subscription's plan/pricing is a
 * distinct, more sensitive action than editing a tenant's contact details. */
export const subscriptionUpdateSchema = z.object({
  planId: z.string().trim().min(1).optional(),
  subscriptionType: z.enum(SUBSCRIPTION_TYPES).optional(),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  status: z.enum(BILLING_STATUSES).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  maintenanceFeeCents: z.coerce.number().int().min(0).nullable().optional(),
  nextDueDate: z.coerce.date().nullable().optional(),
  maintenanceExpiry: z.coerce.date().nullable().optional(),
  supportExpiry: z.coerce.date().nullable().optional(),
  supportStatus: z.enum(SUPPORT_STATUSES).optional(),
});

export type SubscriptionUpdateInput = z.infer<typeof subscriptionUpdateSchema>;
