import { z } from "zod";

const CURRENCIES = ["KES", "UGX", "TZS", "USD"] as const;
const PAYMENT_STATUSES = ["PAID", "PENDING", "FAILED"] as const;

export const subscriptionPaymentCreateSchema = z.object({
  amountCents: z.coerce.number().int().min(0),
  currency: z.enum(CURRENCIES),
  paymentMethod: z.string().trim().min(1, "Payment method is required").max(100),
  // No cash payment option exists for subscription billing — every accepted method (M-Pesa, bank
  // transfer, card, etc.) always produces some kind of transaction/reference code, so this is
  // required, not optional.
  transactionReference: z.string().trim().min(1, "Transaction reference is required").max(120),
  billingPeriod: z.string().trim().min(1, "Billing period is required").max(20),
  paymentDate: z.coerce.date().default(() => new Date()),
  nextDueDateAfter: z.coerce.date().nullable().optional(),
  status: z.enum(PAYMENT_STATUSES).default("PAID"),
});

export type SubscriptionPaymentCreateInput = z.infer<typeof subscriptionPaymentCreateSchema>;
