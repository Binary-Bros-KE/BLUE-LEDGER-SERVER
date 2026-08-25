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

/** One cart line as APP sends it — a PREVIEW only. mobile-checkout-service.ts never trusts
 * unitPriceCents/discountAmountCents/lineTotalCents from here; it re-fetches the real Product and
 * recomputes everything server-side (see that service's own doc comment). quantity/discount are the
 * only client inputs that actually matter. */
export const mobileCheckoutItemSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(1),
  discountAmountCents: z.coerce.number().int().min(0).default(0),
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
});

export type MobileCheckoutInput = z.infer<typeof mobileCheckoutSchema>;
