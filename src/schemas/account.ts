import { z } from "zod";

const ACCOUNT_ROLES = ["SUPER_ADMIN", "MARKETER"] as const;

const nameField = z.string().trim().min(1, "Name is required").max(200);
const emailField = z.string().trim().toLowerCase().email("Enter a valid email");
const passwordField = z.string().min(8, "Password must be at least 8 characters").max(200);

/** CREATE: omitting outletId truly means "no outlet" — collapse to null. */
const outletIdForCreate = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

/** UPDATE: omitting the key must mean "leave alone" (stays undefined, Prisma skips it); an
 * explicit `null` means "clear the outlet". No transform, unlike outletIdForCreate — same
 * omit-vs-null distinction the tenant schema draws between create/update optional fields. */
const outletIdForUpdate = z.string().trim().min(1).nullable().optional();

/** role defaults to MARKETER — the common case ("any other normal account" per the brief);
 * outletId is required at this layer for MARKETER (see the refine below), enforced again for
 * updates in account-service.ts since a PATCH only carries the fields it actually changes. */
export const accountCreateSchema = z
  .object({
    name: nameField,
    email: emailField,
    password: passwordField,
    role: z.enum(ACCOUNT_ROLES).default("MARKETER"),
    outletId: outletIdForCreate,
    isActive: z.boolean().default(true),
  })
  .refine((data) => data.role !== "MARKETER" || data.outletId !== null, {
    message: "A marketer account must be assigned to an outlet",
    path: ["outletId"],
  });

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/** No cross-field refine here on purpose — a PATCH might touch only `role` or only `outletId`,
 * never both at once. account-service.ts checks the *effective* (existing + patched) role/outlet
 * combination once it has the current row to merge against. */
export const accountUpdateSchema = z.object({
  name: nameField.optional(),
  email: emailField.optional(),
  password: passwordField.optional(),
  role: z.enum(ACCOUNT_ROLES).optional(),
  outletId: outletIdForUpdate,
  isActive: z.boolean().optional(),
});

export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;
