import { z } from "zod";

// Mirrors tenant.ts's own BUSINESS_TYPES/CURRENCIES exactly — kept as a separate literal list here
// (not imported) for the same reason tenant.ts itself doesn't import from anywhere: this schema
// module has no dependency on that one today, and the two are already independently kept in sync
// by hand across this file, tenant.ts, and the Prisma enum they both mirror. These are the SAME
// values DESKTOP's own shared/types/tenant.ts BUSINESS_TYPE_OPTIONS offers — see schema.prisma's
// BusinessType enum comment for why these reconciled onto desktop's list, not the other way round.
const BUSINESS_TYPES = [
  "retail_shop",
  "wholesale_shop",
  "retail_and_wholesale",
  "restaurant",
  "hotel",
  "pharmacy",
  "electronics",
  "hardware",
  "general_store",
  "supermarket",
  "other",
] as const;
const CURRENCIES = ["KES", "UGX", "TZS", "USD"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

/** For the profile PUSH below: omitting a field must mean "leave the cloud value alone" (stays
 * `undefined`, so Prisma skips it), while explicitly sending `null` clears it. Deliberately does
 * NOT collapse undefined into null the way optionalText above does — this is the same distinction
 * tenant.ts's createOptionalText vs updateOptionalText makes. */
const pushOptionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** No auth token here — the license key itself IS the credential. This is called by a desktop
 * install that has no Account/JWT concept at all. */
export const activationRegisterSchema = z.object({
  licenseKey: z.string().trim().min(1, "License key is required"),
  deviceName: z.string().trim().min(1, "Device name is required").max(200),
  deviceType: z.enum(["DESKTOP", "LAPTOP"]).default("DESKTOP"),
  osName: optionalText(100),
  appVersion: optionalText(50),
});

export type ActivationRegisterInput = z.infer<typeof activationRegisterSchema>;

/** Called periodically by an already-activated install to re-check its license is still valid —
 * see license-service.ts's suspend/reactivate for what this needs to detect. */
export const activationHeartbeatSchema = z.object({
  licenseKey: z.string().trim().min(1, "License key is required"),
  deviceId: z.string().trim().min(1, "Device id is required"),
  appVersion: optionalText(50),
});

export type ActivationHeartbeatInput = z.infer<typeof activationHeartbeatSchema>;

/** Undefined-vs-null convention matches tenantUpdateSchema exactly: the desktop only sends fields
 * the tenant actually filled in on their local Business Profile screen. A field genuinely omitted
 * (undefined) leaves the cloud value alone; an explicit null clears it. */
export const activationProfileUpdateSchema = z.object({
  licenseKey: z.string().trim().min(1, "License key is required"),
  // contactEmail is deliberately NOT here — it's the one field that stays admin/marketer-owned
  // (set at tenant creation, editable on the dashboard), so the desktop never overwrites it.
  // `name` (not `businessName`) to match the Tenant model's own field directly — same renaming
  // convention already used below (primaryPhone -> contactPhone).
  name: z.string().trim().min(1, "Business name is required").max(200).optional(),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  currency: z.enum(CURRENCIES).optional(),
  ownerName: pushOptionalText(200),
  contactPhone: pushOptionalText(50),
  businessRegistrationNumber: pushOptionalText(100),
  kraPin: pushOptionalText(50),
  email: pushOptionalText(200),
  alternativePhone: pushOptionalText(50),
  website: pushOptionalText(200),
  country: pushOptionalText(100),
  countyState: pushOptionalText(100),
  cityTown: pushOptionalText(100),
  physicalAddress: pushOptionalText(500),
  ownerPhone: pushOptionalText(50),
  ownerEmail: pushOptionalText(200),
  vatRatePercent: z.coerce.number().min(0).max(100).optional(),
  pricesTaxInclusive: z.boolean().optional(),
});

export type ActivationProfileUpdateInput = z.infer<typeof activationProfileUpdateSchema>;

export const activationPaymentsQuerySchema = z.object({
  licenseKey: z.string().trim().min(1, "License key is required"),
});

export type ActivationPaymentsQueryInput = z.infer<typeof activationPaymentsQuerySchema>;
