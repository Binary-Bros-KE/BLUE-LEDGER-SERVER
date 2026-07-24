import { z } from "zod";

const PLAN_STATUSES = ["ACTIVE", "INACTIVE"] as const;

const nameField = z.string().trim().min(1, "Name is required").max(200);
const outletIdField = z.string().trim().min(1, "Select an outlet");

/** CREATE: omitting the field truly means "no value" — collapse to null. */
const centsForCreate = (max: number) =>
  z
    .coerce.number()
    .int()
    .min(0)
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
/** UPDATE: omitting the key must mean "leave alone" (undefined, Prisma skips it); an explicit
 * `null` means "clear it". No transform, unlike centsForCreate — same distinction the tenant
 * schema draws between its create/update optional-field helpers. */
const centsForUpdate = (max: number) => z.coerce.number().int().min(0).max(max).nullable().optional();

const textForCreate = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
const textForUpdate = (max: number) => z.string().trim().max(max).nullable().optional();

export const planCreateSchema = z.object({
  outletId: outletIdField,
  name: nameField,
  monthlyPriceCents: centsForCreate(100_000_000),
  purchasePriceCents: centsForCreate(100_000_000),
  annualMaintenanceCents: centsForCreate(100_000_000),
  maxBranches: z.coerce.number().int().min(1).max(1000).default(1),
  maxUsers: z.coerce.number().int().min(1).max(10000).default(3),
  maxDevices: z.coerce.number().int().min(1).max(10000).default(1),
  supportLevel: textForCreate(100),
  description: textForCreate(2000),
  featureInventory: z.boolean().default(true),
  featureSales: z.boolean().default(true),
  featureQuotations: z.boolean().default(false),
  featurePurchaseOrders: z.boolean().default(false),
  featureExpenses: z.boolean().default(false),
  featurePayroll: z.boolean().default(false),
  featureCrm: z.boolean().default(false),
  featureMultiStore: z.boolean().default(false),
  featureCloudSync: z.boolean().default(false),
});

export type PlanCreateInput = z.infer<typeof planCreateSchema>;

export const planUpdateSchema = z.object({
  name: nameField.optional(),
  monthlyPriceCents: centsForUpdate(100_000_000),
  purchasePriceCents: centsForUpdate(100_000_000),
  annualMaintenanceCents: centsForUpdate(100_000_000),
  maxBranches: z.coerce.number().int().min(1).max(1000).optional(),
  maxUsers: z.coerce.number().int().min(1).max(10000).optional(),
  maxDevices: z.coerce.number().int().min(1).max(10000).optional(),
  supportLevel: textForUpdate(100),
  description: textForUpdate(2000),
  status: z.enum(PLAN_STATUSES).optional(),
  featureInventory: z.boolean().optional(),
  featureSales: z.boolean().optional(),
  featureQuotations: z.boolean().optional(),
  featurePurchaseOrders: z.boolean().optional(),
  featureExpenses: z.boolean().optional(),
  featurePayroll: z.boolean().optional(),
  featureCrm: z.boolean().optional(),
  featureMultiStore: z.boolean().optional(),
  featureCloudSync: z.boolean().optional(),
});

export type PlanUpdateInput = z.infer<typeof planUpdateSchema>;
