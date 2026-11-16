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

/** Admin: a cash/bank top-up (positive) or a correction (ADJUSTMENT, either sign) to the prepaid balance. */
export const walletAdjustmentSchema = z
  .object({
    amountCents: z.coerce.number().int().refine((value) => value !== 0, "Enter an amount"),
    kind: z.enum(["TOPUP", "ADJUSTMENT"]).default("TOPUP"),
    paymentMethod: z.string().trim().min(1).max(50).default("Cash"),
    reference: z.string().trim().max(100).nullable().optional().transform((value) => value || null),
    note: z.string().trim().max(300).nullable().optional().transform((value) => value || null),
  })
  .refine((value) => value.kind === "ADJUSTMENT" || value.amountCents > 0, { message: "A top-up must be positive", path: ["amountCents"] });
