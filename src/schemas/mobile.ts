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

export const mobileDashboardQuerySchema = z.object({
  period: z.enum(["today", "week", "month"]).default("today"),
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
export const salesReportPeriodQuerySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("daily"), anchor: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ mode: z.literal("weekly"), anchor: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ mode: z.literal("monthly"), anchor: z.string().trim().regex(/^\d{4}-\d{2}$/) }),
  z.object({ mode: z.literal("yearly"), anchor: z.string().trim().regex(/^\d{4}$/) }),
  z
    .object({
      mode: z.literal("custom"),
      startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .refine((v) => v.startDate <= v.endDate, { message: "startDate must not be after endDate", path: ["endDate"] }),
]);

export type SalesReportPeriodQuery = z.infer<typeof salesReportPeriodQuerySchema>;
