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
  entity: z.enum(["sale", "quotation", "customer_statement", "sale_delivery", "quotation_delivery"]),
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
  /** Shared-stock variant (lib/variants.ts) — prepareMobileCart validates + prices it. */
  variantKey: z.string().trim().min(1).max(40).nullish(),
  /** DESKTOP invoice/quotation section ("Lighting") — carried through so editing a desktop-made
   * document on the phone keeps its sections. The app never creates one itself. */
  sectionLabel: z.string().trim().max(120).nullish(),
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

/** Where an invoice LINE's stock is deducted from (chosen per line — one invoice can mix sources).
 * "main_store" is only accepted when the tenant's admin "Invoice stock from Main Store" toggle
 * (Tenant.invoiceStockFromMainStore) is on. */
export const mobileInvoiceStockSourceSchema = z.enum(["storefront", "main_store"]);

export type MobileInvoiceStockSource = z.infer<typeof mobileInvoiceStockSourceSchema>;

/** An invoice cart line — a checkout line plus its own optional stockSource. Omitted falls back to
 * the invoice-level stockSource below (the first, whole-invoice version of this feature, which an
 * already-deployed APP still sends), then to "storefront" on create / the line's current source on
 * update. */
export const mobileInvoiceItemSchema = mobileCheckoutItemSchema.extend({
  stockSource: mobileInvoiceStockSourceSchema.optional(),
});

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
  items: z.array(mobileInvoiceItemSchema).min(1, "At least one item is required"),
  initialPayment: mobileInitialPaymentSchema.nullable().optional(),
  delivery: mobileCheckoutDeliverySchema.optional(),
  serviceCharges: mobileServiceChargesFieldSchema,
  /** Legacy whole-invoice default for lines that don't carry their own stockSource. */
  stockSource: mobileInvoiceStockSourceSchema.optional(),
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
  // Optional now: a blank/omitted expiry means the quotation never expires (client request).
  validUntil: z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  notes: z.string().trim().optional(),
  includeTaxBreakdown: z.coerce.boolean().optional().default(true),
  includeBusinessInfo: z.coerce.boolean().optional().default(true),
  items: z.array(mobileCheckoutItemSchema).min(1, "At least one item is required"),
  delivery: mobileCheckoutDeliverySchema.optional(),
  serviceCharges: mobileServiceChargesFieldSchema,
  locationId: z.string().trim().min(1).optional(),
});

export type MobileQuotationInput = z.infer<typeof mobileQuotationSchema>;

/** 0 is allowed and means "leave this line off" — same as DESKTOP's convert dialog. */
const mobileQuotationQuantityOverrideSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(0, "Quantity can't be negative"),
});

/** Lines marked "Sourced from another shop" at conversion — bought elsewhere on the spot (no stock
 * check, no deduction). localCostCents is the line's TOTAL buying cost, same as a cart line's. */
const mobileConvertSourcedLinesSchema = z
  .array(
    z.object({
      productId: z.string().trim().min(1),
      localCostCents: z.coerce.number().int().positive("Enter the buying price for this locally-sourced item"),
      localSupplierId: z.string().trim().min(1).optional(),
    }),
  )
  .optional()
  .default([]);

export const mobileConvertToSaleSchema = z.object({
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  paymentReference: z.string().trim().optional(),
  amountReceivedCents: z.coerce.number().int().min(0).nullable().optional(),
  quantityOverrides: z.array(mobileQuotationQuantityOverrideSchema).optional().default([]),
  sourcedLines: mobileConvertSourcedLinesSchema,
});

export type MobileConvertToSaleInput = z.infer<typeof mobileConvertToSaleSchema>;

export const mobileConvertToInvoiceSchema = z.object({
  dueDate: z.string().trim().min(1, "Due date is required"),
  quantityOverrides: z.array(mobileQuotationQuantityOverrideSchema).optional().default([]),
  sourcedLines: mobileConvertSourcedLinesSchema,
  /** Per-line stock source, keyed by productId (same keying as quantityOverrides). */
  stockSources: z
    .array(z.object({ productId: z.string().trim().min(1), stockSource: mobileInvoiceStockSourceSchema }))
    .optional()
    .default([]),
  /** Legacy whole-invoice default for lines not listed in stockSources. */
  stockSource: mobileInvoiceStockSourceSchema.optional(),
  /** Who to bill when the quotation was for a walk-in (no customer of its own) — ignored otherwise. */
  customerId: z.string().trim().min(1).optional(),
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

/** Body for POST /mobile/sales/:id/request-return — mirrors DESKTOP's own
 * shared/schemas/sale-return.ts saleReturnRequestSchema exactly (same reason/notes bounds, same
 * per-line saleItemId+quantity shape). */
export const mobileSaleReturnRequestSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        saleItemId: z.string().trim().min(1),
        quantity: z.coerce.number().int().positive("Quantity must be greater than 0"),
      }),
    )
    .min(1, "Select at least one item to return"),
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

/** Same 6-digit rule as DESKTOP's own shared/schemas/employee.ts pinSchema — a PIN set here must
 * also work on every DESKTOP install once the employee row is pulled down. */
const employeePinSchema = z.string().trim().regex(/^\d{6}$/, "PIN must be exactly 6 digits");

/** Mirrors DESKTOP's EMPLOYEE_STATUS_OPTIONS (shared/types/employee.ts). */
export const mobileEmployeeStatusSchema = z.enum(["active", "suspended", "terminated"]);

/** The Owner App's "Add employee" form — deliberately the system-access essentials only (who they
 * are, which role/storefront, their login PIN). Everything HR-shaped (DOB, department, default
 * salary, photo, …) stays on DESKTOP's full Employee form. employeeCode is uppercased exactly like
 * DESKTOP's own employeeBaseFields.employeeCode, so uniqueness is compared on the same value. */
export const mobileCreateEmployeeSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .min(1, "Employee code is required")
    .max(30)
    .transform((value) => value.toUpperCase()),
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((value) => (value ? value : null)),
  roleId: z.string().trim().min(1, "Choose a role"),
  branchId: z.string().trim().min(1).nullable(),
  pin: employeePinSchema,
});

export type MobileCreateEmployeeInput = z.infer<typeof mobileCreateEmployeeSchema>;

/** Body for PATCH /mobile/employees/:id/access — every field optional so Suspend/Reactivate can
 * send just `status`, while the Edit Access sheet sends role + branch together. */
export const mobileEmployeeAccessSchema = z
  .object({
    roleId: z.string().trim().min(1).optional(),
    branchId: z.string().trim().min(1).nullable().optional(),
    status: mobileEmployeeStatusSchema.optional(),
  })
  .refine((data) => data.roleId !== undefined || data.branchId !== undefined || data.status !== undefined, {
    message: "Nothing to change",
  });

export type MobileEmployeeAccessInput = z.infer<typeof mobileEmployeeAccessSchema>;

export const mobileEmployeePinResetSchema = z.object({
  pin: employeePinSchema,
});

/** Mirrors DESKTOP's UNIT_OF_MEASURE_OPTIONS (shared/types/product.ts) — validated against the same
 * list so a mobile-created product round-trips into DESKTOP's own Product form without a blank. */
export const MOBILE_UNIT_OF_MEASURE_VALUES = [
  "piece", "pack", "box", "carton", "set", "kg", "g", "L", "mL", "m", "cm", "dozen", "pair", "roll",
  "bottle", "can", "bag", "sack", "bundle", "tray", "tube", "jar", "bucket", "plate", "sheet",
] as const;

const mobilePriceCents = z.coerce.number().int().min(0).max(100_000_000_000);
const mobileNullablePriceCents = mobilePriceCents.nullable().optional().transform((value) => value ?? null);
const mobileOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

/** The day-to-day subset of DESKTOP's own productFieldsSchema (shared/schemas/product.ts) — same
 * bounds, same uppercased SKU, same "minimum price can't exceed selling price" refinement. Online
 * store content, variants, brand, short name and supplier SKU stay DESKTOP-only and are never
 * touched by a mobile edit (mobile-products-service.ts only writes the fields listed here). */
const mobileProductFields = z.object({
  name: z.string().trim().min(1, "Product name is required").max(200),
  sku: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((value) => (value ? value.toUpperCase() : undefined)),
  barcode: mobileOptionalText(64),
  categoryId: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null),
  storefrontId: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null),
  unitOfMeasure: z.enum(MOBILE_UNIT_OF_MEASURE_VALUES).nullable().optional().transform((value) => value ?? null),
  description: mobileOptionalText(1000),
  buyingPriceCents: mobilePriceCents,
  sellingPriceCents: mobilePriceCents,
  wholesalePriceCents: mobileNullablePriceCents,
  wholesaleMinQuantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  minimumPriceCents: mobileNullablePriceCents,
  taxType: z.enum(["vat", "exempted", "zero_rated"]).default("vat"),
  pricesTaxInclusive: z.boolean().nullable().optional().transform((value) => (value === undefined ? null : value)),
  reorderLevel: z.coerce.number().int().min(0).max(1_000_000).default(0),
  trackStock: z.boolean().default(true),
  allowNegativeStock: z.boolean().default(false),
});

function minimumPriceNotAboveSelling(data: { minimumPriceCents: number | null; sellingPriceCents: number }): boolean {
  return data.minimumPriceCents === null || data.minimumPriceCents <= data.sellingPriceCents;
}

const MINIMUM_PRICE_REFINEMENT_OPTS = {
  message: "Minimum price can't be higher than the selling price",
  path: ["minimumPriceCents"] as PropertyKey[],
};

export const mobileCreateProductSchema = mobileProductFields
  .extend({
    /** Optional opening stock at ONE location — same "opening_stock" movement DESKTOP's own
     * createProduct records per openingStock entry. */
    openingStock: z
      .object({
        locationId: z.string().trim().min(1),
        quantity: z.coerce.number().int().min(1, "Opening stock must be at least 1"),
      })
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .refine(minimumPriceNotAboveSelling, MINIMUM_PRICE_REFINEMENT_OPTS);

export type MobileCreateProductInput = z.infer<typeof mobileCreateProductSchema>;

export const mobileUpdateProductSchema = mobileProductFields.refine(minimumPriceNotAboveSelling, MINIMUM_PRICE_REFINEMENT_OPTS);

export type MobileUpdateProductInput = z.infer<typeof mobileUpdateProductSchema>;

/** Mirrors DESKTOP's ProductStatus — "inactive" is DESKTOP's own archive (hidden from selling,
 * history kept). Products are never hard-deleted once synced. */
export const mobileProductStatusSchema = z.object({
  status: z.enum(["active", "inactive"]),
});

export const mobileCreateCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(150),
});

/** Body for POST /mobile/stock-adjustments. `mode` picks the movement type the way DESKTOP's own
 * manual-movement form does (MANUAL_STOCK_MOVEMENT_TYPE_OPTIONS):
 *  - "add"    → reason "purchase" | "return" | "opening_stock", +quantity
 *  - "remove" → "damage", −quantity
 *  - "count"  → "adjustment" by (counted − current); `quantity` is the physical count itself.
 * `id` is minted CLIENT-SIDE and resent on retry, same idempotency contract as mobile checkout. */
export const mobileStockAdjustmentSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    productId: z.string().trim().min(1),
    locationId: z.string().trim().min(1),
    mode: z.enum(["add", "remove", "count"]),
    addReason: z.enum(["purchase", "return", "opening_stock"]).optional(),
    quantity: z.coerce.number().int().min(0).max(10_000_000),
    notes: mobileOptionalText(500),
  })
  .refine((data) => data.mode === "count" || data.quantity > 0, { message: "Quantity must be greater than 0", path: ["quantity"] });

export type MobileStockAdjustmentInput = z.infer<typeof mobileStockAdjustmentSchema>;

const mobileCents = z.coerce.number().int().min(0).max(100_000_000_000);

/** Mirrors DESKTOP's own purchaseItemInputSchema (shared/schemas/purchase.ts) — line tax is always
 * computed server-side from taxType + cost, never taken from the client. */
const mobilePurchaseItemSchema = z.object({
  productId: z.string().trim().min(1),
  orderedQuantity: z.coerce.number().int().positive("Quantity must be greater than 0"),
  unitCostCents: mobileCents,
  /** Optional new selling price — pushed onto the product when the order is placed, same as DESKTOP. */
  sellingPriceCents: mobileCents.nullable().optional().transform((value) => value ?? null),
  discountAmountCents: mobileCents.optional().default(0),
  taxType: z.enum(["vat", "exempted", "zero_rated"]).default("vat"),
});

/** The day-to-day subset of DESKTOP's purchaseCreateSchema — shipment tracking and attachments stay
 * DESKTOP-only. `id` is minted CLIENT-SIDE and resent on retry (same idempotency contract as mobile
 * checkout), so a dropped connection can never create the same purchase twice. */
export const mobileCreatePurchaseSchema = z.object({
  id: z.string().trim().min(1).max(100),
  supplierId: z.string().trim().min(1, "Select a supplier"),
  supplierInvoiceNumber: mobileOptionalText(100),
  locationId: z.string().trim().min(1, "Select where the goods will be received"),
  /** "Shipping Fee" — owed to the supplier, added to the order total. */
  shippingCostCents: mobileCents.optional().default(0),
  /** "Shipping Cost" — the business's own out-of-pocket cost, booked as an Expense, never owed. */
  shippingExpenseCents: mobileCents.optional().default(0),
  notes: mobileOptionalText(1000),
  items: z.array(mobilePurchaseItemSchema).min(1, "Add at least one product"),
  intent: z.enum(["draft", "ordered"]).default("ordered"),
});

export type MobileCreatePurchaseInput = z.infer<typeof mobileCreatePurchaseSchema>;

export const mobileReceivePurchaseSchema = z.object({
  items: z
    .array(
      z.object({
        purchaseItemId: z.string().trim().min(1),
        receivingQuantity: z.coerce.number().int().positive("Enter a quantity greater than 0"),
      }),
    )
    .min(1, "Enter at least one quantity to receive"),
});

/** `amountCents` omitted = pay off the full balance currently due (DESKTOP's markPurchasePaid). */
export const mobilePurchasePaymentSchema = z.object({
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0").optional(),
  reference: mobileOptionalText(120),
  notes: mobileOptionalText(500),
});

/** Mirrors DESKTOP's own expenseInputSchema (shared/schemas/expense.ts) minus the attachment —
 * every expense needs a storefront ("no General/Head Office catch-all"), category and payment
 * method. expenseDate is the plain YYYY-MM-DD string DESKTOP stores. */
export const mobileExpenseInputSchema = z.object({
  expenseDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Expense date is required"),
  categoryId: z.string().trim().min(1, "Select a category"),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0").max(100_000_000_000),
  paidBy: mobileOptionalText(150),
  paymentMethodId: z.string().trim().min(1, "Select a payment method"),
  storefrontId: z.string().trim().min(1, "Select a storefront"),
  reference: mobileOptionalText(120),
  description: mobileOptionalText(1000),
});

export type MobileExpenseInput = z.infer<typeof mobileExpenseInputSchema>;

export const mobileCreateExpenseSchema = mobileExpenseInputSchema.extend({
  /** Minted CLIENT-SIDE, resent unchanged on retry — same idempotency contract as checkout. */
  id: z.string().trim().min(1).max(100),
});

export const mobileCreateExpenseCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(150),
});
