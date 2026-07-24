import { z } from "zod";

// Matches DESKTOP's own shared/types/tenant.ts BUSINESS_TYPE_OPTIONS exactly — see schema.prisma's
// BusinessType enum comment for the 2026-07-24 reconciliation this came from.
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
const SUBSCRIPTION_TYPES = ["MONTHLY", "LIFETIME", "CUSTOM"] as const;
const BILLING_CYCLES = ["MONTHLY", "YEARLY", "ONCE"] as const;

// Bare per-field validators, shared between create and update, WITHOUT defaults — a field's
// default only makes sense at creation. Applying it to an update too would mean "the admin didn't
// mention this field in their PATCH" gets silently treated as "reset it to the factory default",
// clobbering whatever was already stored.
const nameField = z.string().trim().min(1, "Name is required").max(200);
const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required")
  .max(80)
  .regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers, and hyphens only");
const contactEmailField = z.string().trim().toLowerCase().email("Enter a valid email");
// Every tenant belongs to exactly one outlet, no exceptions — never nullable, unlike the tenant's
// optional text fields below.
const outletIdField = z.string().trim().min(1, "Select an outlet");

/** For CREATE: input may omit the field entirely, meaning "no value" — store null. */
const createOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));

/** For UPDATE: omitting the field must mean "leave it alone" (stays `undefined`, so Prisma skips
 * it), while explicitly sending `null` means "clear it". Deliberately does NOT collapse undefined
 * into null the way createOptionalText does. */
const updateOptionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Fields the admin dashboard fills in when creating a tenant. `dbName`/`dbHost`/`dbPort` are
 * server-derived, never taken from client input — see tenant-service.ts. A License (TRIAL) and a
 * Subscription are always created alongside the Tenant in the same transaction, so this schema
 * also carries the minimum subscription setup fields needed for that. */
export const tenantCreateSchema = z.object({
  name: nameField,
  slug: slugField,
  outletId: outletIdField,
  businessType: z.enum(BUSINESS_TYPES).default("other"),
  timezone: z.string().trim().min(1).max(60).default("Africa/Nairobi"),
  currency: z.enum(CURRENCIES).default("KES"),
  ownerName: createOptionalText(200),
  contactEmail: contactEmailField,
  contactPhone: createOptionalText(50),
  notes: createOptionalText(2000),

  planId: z.string().trim().min(1, "Select a plan"),
  subscriptionType: z.enum(SUBSCRIPTION_TYPES),
  billingCycle: z.enum(BILLING_CYCLES),
  priceCents: z.coerce.number().int().min(0),
  maintenanceFeeCents: z.coerce.number().int().min(0).nullable().optional().transform((v) => (v ? v : null)),
  startDate: z.coerce.date().default(() => new Date()),
});

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;

/** Every field is optional and undefined-safe: a PATCH only ever touches the fields it actually
 * includes. Slug is excluded — it's load-bearing for the tenant's derived database name, so
 * changing it after provisioning would orphan the existing database. Subscription/License fields
 * live on their OWN dedicated endpoints now (see subscription.ts, license actions in tenants.ts) —
 * this schema is core tenant profile fields only. The extended-profile fields below are normally
 * kept current by the desktop app's own push (see schemas/activation.ts's
 * activationProfileUpdateSchema) — a super admin editing them here is just the other way in. */
export const tenantUpdateSchema = z.object({
  name: nameField.optional(),
  // Reassignable (SUPER_ADMIN only, enforced at the route/service layer) but never nullable — a
  // tenant can move to a different outlet, never to no outlet.
  outletId: outletIdField.optional(),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  timezone: z.string().trim().min(1).max(60).optional(),
  currency: z.enum(CURRENCIES).optional(),
  ownerName: updateOptionalText(200),
  contactEmail: contactEmailField.optional(),
  contactPhone: updateOptionalText(50),
  notes: updateOptionalText(2000),

  businessRegistrationNumber: updateOptionalText(100),
  kraPin: updateOptionalText(50),
  email: updateOptionalText(200),
  alternativePhone: updateOptionalText(50),
  website: updateOptionalText(200),
  country: updateOptionalText(100),
  countyState: updateOptionalText(100),
  cityTown: updateOptionalText(100),
  physicalAddress: updateOptionalText(500),
  ownerPhone: updateOptionalText(50),
  ownerEmail: updateOptionalText(200),

  // Per-tenant exception to the Plan's own maxDevices — null explicitly clears the override (falls
  // back to the plan's value again); omitting the field entirely leaves whatever's already stored.
  maxDevicesOverride: z.coerce.number().int().min(1).max(1000).nullable().optional(),
});

export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;
