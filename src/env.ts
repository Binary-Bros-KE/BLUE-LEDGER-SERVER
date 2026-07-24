import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TENANT_DB_HOST: z.string().min(1).default("localhost"),
  TENANT_DB_PORT: z.coerce.number().int().positive().default(5432),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  // The one place a share-link's own domain is known — where the public "view this document"
  // page (the SHARE app) actually lives. Never hardcode this anywhere else.
  SHARE_APP_BASE_URL: z.string().min(1).default("http://localhost:3300"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
