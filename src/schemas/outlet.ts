import { z } from "zod";

const nameField = z.string().trim().min(1, "Name is required").max(200);
const createOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
const updateOptionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const outletCreateSchema = z.object({
  name: nameField,
  location: createOptionalText(200),
  notes: createOptionalText(2000),
});

export type OutletCreateInput = z.infer<typeof outletCreateSchema>;

export const outletUpdateSchema = z.object({
  name: nameField.optional(),
  location: updateOptionalText(200),
  notes: updateOptionalText(2000),
});

export type OutletUpdateInput = z.infer<typeof outletUpdateSchema>;
