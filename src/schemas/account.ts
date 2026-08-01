import { z } from "zod";

// DISTRIBUTOR was added alongside MARKETER, not as a replacement — existing accounts already
// stored with role="MARKETER" are untouched; DISTRIBUTOR exists purely so new accounts can be
// created under a better-fitting label. Both are outlet-scoped, non-admin roles — see the refine
// below, which treats them identically.
const ACCOUNT_ROLES = ["SUPER_ADMIN", "MARKETER", "DISTRIBUTOR"] as const;

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

/** role defaults to DISTRIBUTOR — the common case ("any other normal account" per the brief);
 * outletId is required at this layer for any non-SUPER_ADMIN role (see the refine below), enforced
 * again for updates in account-service.ts since a PATCH only carries the fields it actually
 * changes. */
export const accountCreateSchema = z
  .object({
    name: nameField,
    email: emailField,
    password: passwordField,
    role: z.enum(ACCOUNT_ROLES).default("DISTRIBUTOR"),
    outletId: outletIdForCreate,
    isActive: z.boolean().default(true),
  })
  .refine((data) => data.role === "SUPER_ADMIN" || data.outletId !== null, {
    message: "This account must be assigned to an outlet",
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
