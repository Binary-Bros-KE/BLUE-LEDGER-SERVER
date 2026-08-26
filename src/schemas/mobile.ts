import { z } from "zod";

/** No auth token here — mirrors activationRegisterSchema's own reasoning: this is called by an
 * Owner App install that has no session yet, the same license key + employee credential combo the
 * DESKTOP POS already uses locally. */
export const mobileLoginSchema = z.object({
  licenseKey: z.string().trim().min(1, "License key is required"),
  employeeCode: z.string().trim().min(1, "Employee code is required"),
  pin: z.string().trim().min(1, "PIN is required"),
});

export type MobileLoginInput = z.infer<typeof mobileLoginSchema>;

// The requesting device's own UTC offset in minutes — same sign/units as JS's own
// Date.prototype.getTimezoneOffset() (e.g. Nairobi/UTC+3 sends -180). "today"/"week"/"month" must
// mean the phone's own local calendar, never the tenant's stored business-record timezone (that
// field is onboarding data only, not a source of truth for date math) and never the server's own
// host timezone — this is the one value that makes that possible.
const timezoneOffsetMinutesField = z.coerce.number().int().min(-720).max(840);

export const mobileDashboardQuerySchema = z.object({
  period: z.enum(["today", "week", "month"]).default("today"),
  timezoneOffsetMinutes: timezoneOffsetMinutesField,
  /** Omit to see every storefront — same "All" convention as the Owner App's other filter chips. */
  locationId: z.string().trim().min(1).optional(),
});

export type MobileDashboardQueryInput = z.infer<typeof mobileDashboardQuerySchema>;

export const mobileSalesQuerySchema = z.object({
  /** Omit to see every storefront — the Owner App's own filter chips, same "All" convention as the
   * Employees tab. */
  locationId: z.string().trim().min(1).optional(),
});

export type MobileSalesQueryInput = z.infer<typeof mobileSalesQuerySchema>;

/** Mints a share link from inside the Owner App — same underlying createShareLink (share-service.ts)
 * DESKTOP's ShareModal calls, just reached via mobile auth instead of device auth, since the owner's
 * phone isn't a registered sync device. */
export const mobileShareLinkSchema = z.object({
  entity: z.enum(["sale", "quotation", "customer_statement"]),
  entityId: z.string().trim().min(1, "entityId is required"),
  includePreview: z.boolean().optional().default(true),
});

export type MobileShareLinkInput = z.infer<typeof mobileShareLinkSchema>;

/** Same grain-based period model as DESKTOP's Sales Report (SalesReportMode) — Daily/Weekly/
 * Monthly/Yearly are fixed calendar periods stepped via `anchor` (computed client-side, see
 * APP/src/lib/period.ts), Custom is a plain date range. */
const locationIdField = z.string().trim().min(1).optional();

export const salesReportPeriodQuerySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("daily"), anchor: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/), timezoneOffsetMinutes: timezoneOffsetMinutesField, locationId: locationIdField }),
  z.object({ mode: z.literal("weekly"), anchor: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/), timezoneOffsetMinutes: timezoneOffsetMinutesField, locationId: locationIdField }),
  z.object({ mode: z.literal("monthly"), anchor: z.string().trim().regex(/^\d{4}-\d{2}$/), timezoneOffsetMinutes: timezoneOffsetMinutesField, locationId: locationIdField }),
  z.object({ mode: z.literal("yearly"), anchor: z.string().trim().regex(/^\d{4}$/), timezoneOffsetMinutes: timezoneOffsetMinutesField, locationId: locationIdField }),
  z
    .object({
      mode: z.literal("custom"),
      startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezoneOffsetMinutes: timezoneOffsetMinutesField,
      locationId: locationIdField,
    })
    .refine((v) => v.startDate <= v.endDate, { message: "startDate must not be after endDate", path: ["endDate"] }),
]);

export type SalesReportPeriodQuery = z.infer<typeof salesReportPeriodQuerySchema>;

/** One cart line as APP sends it — a PREVIEW only. mobile-checkout-service.ts never TRUSTS these
 * money fields (it re-validates unitPriceCents against the real Product's minimumPriceCents, and
 * only ever uses localCostCents/localSupplierId when isLocallySourced is true), it just accepts them
 * as the cashier's INTENT. unitPriceCents omitted means "use the product's own listed selling
 * price" — present means a cashier-entered mark-up/override for this line only, same convention as
 * DESKTOP's own priceOverride (never written back to the product). isLocallySourced marks a line
 * bought from another shop on the spot rather than pulled from this shop's own stock — skips the
 * usual stock deduction, same as DESKTOP's own sale-service.ts prepareCart. */
export const mobileCheckoutItemSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(1),
  discountAmountCents: z.coerce.number().int().min(0).default(0),
  unitPriceCents: z.coerce.number().int().min(0).optional(),
  isLocallySourced: z.boolean().optional().default(false),
  localCostCents: z.coerce.number().int().min(0).optional(),
  localSupplierId: z.string().trim().min(1).optional(),
});

/** A named custom fee (e.g. "Labour", "Installation") — unlimited per document. costCents is
 * internal-only and never printed. Matches DESKTOP's own shared/schemas/charges.ts
 * serviceChargeInputSchema exactly. Shared by checkout/invoice/quotation. */
export const mobileServiceChargeSchema = z.object({
  name: z.string().trim().min(1, "Charge name is required").max(120),
  feeCents: z.coerce.number().int().min(0),
  costCents: z.coerce.number().int().min(0).optional().default(0),
});

export const mobileServiceChargesFieldSchema = z.array(mobileServiceChargeSchema).optional().default([]);

/** Matches DESKTOP's own ExtraChargesSection DeliveryDraft shape (see sale-service.ts's
 * DeliveryInput) — riderId is optional (a delivery can be entered before a rider is assigned),
 * everything else mirrors the same fields the desktop's inline delivery panel collects.
 * feeCents/costCents are already-converted cents, same convention as discountAmountCents above. */
export const mobileCheckoutDeliverySchema = z.object({
  riderId: z.string().trim().min(1).optional(),
  recipientName: z.string().trim().min(1, "Recipient name is required"),
  country: z.string().trim().optional().default(""),
  town: z.string().trim().optional().default(""),
  physicalAddress: z.string().trim().min(1, "Delivery address is required"),
  notes: z.string().trim().optional().default(""),
  feeCents: z.coerce.number().int().min(0).default(0),
  costCents: z.coerce.number().int().min(0).default(0),
});

/** Body for POST /mobile/sales. `id` is minted CLIENT-SIDE (a UUID, same convention as DESKTOP's own
 * local sale ids) and resent unchanged on any retry — this is the whole idempotency mechanism (see
 * mobile-checkout-service.ts): a retry of an id that already succeeded is treated as a no-op success
 * rather than re-running stock deduction a second time. */
export const mobileCheckoutSchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  locationId: z.string().trim().min(1, "locationId is required"),
  items: z.array(mobileCheckoutItemSchema).min(1, "At least one item is required"),
  paymentMethodId: z.string().trim().min(1, "paymentMethodId is required"),
  paymentReference: z.string().trim().optional(),
  customerId: z.string().trim().min(1).optional(),
  amountReceivedCents: z.coerce.number().int().min(0),
  delivery: mobileCheckoutDeliverySchema.optional(),
  serviceCharges: mobileServiceChargesFieldSchema,
  notes: z.string().trim().optional(),
  /** See Sale["includeTaxBreakdown"]/["includeBusinessInfo"]'s own doc comment (schema.prisma) —
   * same per-document toggles DESKTOP's own Checkout already has. Previously hardcoded true,true on
   * every mobile-created sale with no wire slot at all; this is the first mobile release that lets a
   * cashier actually choose. */
  includeTaxBreakdown: z.coerce.boolean().optional().default(true),
  includeBusinessInfo: z.coerce.boolean().optional().default(true),
});

export type MobileCheckoutInput = z.infer<typeof mobileCheckoutSchema>;

/** The fast path for adding a customer mid-checkout — name + phone only, same fields as DESKTOP's
 * own QuickCreateCustomerModal (everything else is editable later from DESKTOP's Customers screen;
 * mobile has no full customer-edit UI in this phase). */
export const mobileCreateCustomerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  phone: z.string().trim().min(1, "Phone is required"),
});

export type MobileCreateCustomerInput = z.infer<typeof mobileCreateCustomerSchema>;

/** Mirrors DESKTOP's own QuickCreateRiderModal (ExtraChargesSection.tsx) — name + phone required,
 * vehicle description optional. */
export const mobileCreateRiderSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  phone: z.string().trim().min(1, "Phone is required"),
  vehicleDescription: z.string().trim().optional(),
});

export type MobileCreateRiderInput = z.infer<typeof mobileCreateRiderSchema>;

/** Mirrors DESKTOP's own QuickCreateSupplierModal — businessName + phone1 required, contactPerson
 * optional, paymentOption hardcoded to "cash" (everything else editable later from DESKTOP's
 * Suppliers screen). Backs Checkout's "Sourced from another shop" supplier picker. */
export const mobileCreateSupplierSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required"),
  contactPerson: z.string().trim().optional(),
  phone1: z.string().trim().min(1, "Phone is required"),
});

export type MobileCreateSupplierInput = z.infer<typeof mobileCreateSupplierSchema>;

// --- Invoices & Quotations (Phase 2) ---
// Reuses mobileCheckoutItemSchema for cart lines — identical shape (productId/quantity/
// discountAmountCents/unitPriceCents/isLocallySourced/localCostCents/localSupplierId) to Checkout's
// own items, matching DESKTOP's own single shared prepareCart across sale/invoice/quotation.

const mobileInitialPaymentSchema = z.object({
  paymentMethodId: z.string().trim().min(1),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0"),
  reference: z.string().trim().optional(),
});

export const mobileInvoiceSchema = z.object({
  customerId: z.string().trim().min(1, "Select a customer"),
  transactionType: z.enum(["invoice", "wholesale_sale"]),
  dueDate: z.string().trim().min(1, "Due date is required"),
  invoiceNotes: z.string().trim().optional(),
  includeTaxBreakdown: z.coerce.boolean().optional().default(true),
  includeBusinessInfo: z.coerce.boolean().optional().default(true),
  items: z.array(mobileCheckoutItemSchema).min(1, "At least one item is required"),
  initialPayment: mobileInitialPaymentSchema.nullable().optional(),
  delivery: mobileCheckoutDeliverySchema.optional(),
  serviceCharges: mobileServiceChargesFieldSchema,
  /** Only ever read on CREATE when the signed-in employee has no assigned branch — ignored on
   * update (an invoice's storefront is fixed at creation), same as DESKTOP. */
  locationId: z.string().trim().min(1).optional(),
});

export type MobileInvoiceInput = z.infer<typeof mobileInvoiceSchema>;

export const mobileRecordPaymentSchema = z.object({
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0"),
  reference: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export type MobileRecordPaymentInput = z.infer<typeof mobileRecordPaymentSchema>;

export const mobileMarkPaidSchema = z.object({
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  reference: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export type MobileMarkPaidInput = z.infer<typeof mobileMarkPaidSchema>;

export const mobileQuotationSchema = z.object({
  // Null/omitted means a walk-in quotation — see Quotation.customerId's own doc comment for why
  // that's intentional here, unlike an invoice.
  customerId: z.string().trim().min(1).nullable().optional(),
  validUntil: z.string().trim().min(1, "Valid-until date is required"),
  notes: z.string().trim().optional(),
  includeTaxBreakdown: z.coerce.boolean().optional().default(true),
  includeBusinessInfo: z.coerce.boolean().optional().default(true),
  items: z.array(mobileCheckoutItemSchema).min(1, "At least one item is required"),
  delivery: mobileCheckoutDeliverySchema.optional(),
  serviceCharges: mobileServiceChargesFieldSchema,
  locationId: z.string().trim().min(1).optional(),
});

export type MobileQuotationInput = z.infer<typeof mobileQuotationSchema>;

const mobileQuotationQuantityOverrideSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().int().positive("Quantity must be greater than 0"),
});

export const mobileConvertToSaleSchema = z.object({
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  paymentReference: z.string().trim().optional(),
  amountReceivedCents: z.coerce.number().int().min(0).nullable().optional(),
  quantityOverrides: z.array(mobileQuotationQuantityOverrideSchema).optional().default([]),
});

export type MobileConvertToSaleInput = z.infer<typeof mobileConvertToSaleSchema>;

export const mobileConvertToInvoiceSchema = z.object({
  dueDate: z.string().trim().min(1, "Due date is required"),
  quantityOverrides: z.array(mobileQuotationQuantityOverrideSchema).optional().default([]),
});

export type MobileConvertToInvoiceInput = z.infer<typeof mobileConvertToInvoiceSchema>;

export const mobileQuotationStatusSchema = z.object({
  status: z.enum(["draft", "sent", "accepted", "rejected"]),
});

/** Body for the includeTaxBreakdown/includeBusinessInfo toggle endpoints — one flag, one call, same
 * as DESKTOP's own setSaleIncludeTaxBreakdown/setSaleIncludeBusinessInfo IPC channels. Shared by
 * both the sales and quotations routes. */
export const mobileBooleanValueSchema = z.object({
  value: z.boolean(),
});

// --- Invoice cancellation approvals (Phase 3) ---
// Mirrors DESKTOP's own shared/schemas/invoice-cancellation.ts exactly.

export const mobileRequestCancelSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  notes: z.string().trim().max(500).optional(),
});

export type MobileRequestCancelInput = z.infer<typeof mobileRequestCancelSchema>;

export const mobileCancellationDecisionSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export type MobileCancellationDecisionInput = z.infer<typeof mobileCancellationDecisionSchema>;

// --- Working Hours lockout (Super Admin only) ---

const workingHoursDaySchema = z.object({
  isOpen: z.boolean(),
  openTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  closeTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
});

export const mobileWorkingHoursUpsertSchema = z.object({
  lockEnabled: z.boolean(),
  lockMode: z.enum(["auto", "manual"]),
  manuallyLocked: z.boolean(),
  timezoneOffsetMinutes: timezoneOffsetMinutesField,
  // Keyed "0".."6" — Sunday..Saturday, matches JS Date.getDay(). z.record's key type has to be
  // spelled out explicitly here (Zod can't infer a numeric-string key set from a plain string).
  schedule: z.record(z.string().regex(/^[0-6]$/), workingHoursDaySchema),
});

export type MobileWorkingHoursUpsertInput = z.infer<typeof mobileWorkingHoursUpsertSchema>;

export const mobileToggleManualLockSchema = z.object({
  locked: z.boolean(),
});

export type MobileToggleManualLockInput = z.infer<typeof mobileToggleManualLockSchema>;
