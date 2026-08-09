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
  // Where THIS server is reachable from the public internet — the only place the M-Pesa STK push
  // callback URL is built from (Safaricom's servers POST the result here; a desktop app on a
  // cashier's LAN has no public URL of its own, so this can never be anything else).
  SERVER_PUBLIC_URL: z.string().min(1).default("http://localhost:4000"),
  // Where built DESKTOP release artifacts (the NSIS installer, its .blockmap, and electron-
  // updater's own latest.yml manifest) get manually copied to after each `npm run dist:win` —
  // served as plain static files (see app.ts), which is all electron-updater's "generic" provider
  // needs. Relative paths resolve against SERVER's own working directory.
  RELEASES_DIR: z.string().min(1).default("./releases"),
  // Pesapal (Card/PayPal) platform-billing credentials — one shared Blue Ledger merchant account,
  // unlike M-Pesa's per-Outlet OutletMpesaSettings, so these live here rather than in the DB. The
  // IPN/callback URLs are deliberately NOT separate env vars — both are built from SERVER_PUBLIC_URL
  // above, same as the M-Pesa callback URL, so there's one less thing to keep in sync when the
  // server moves.
  PESAPAL_CONSUMER_KEY: z.string().min(1, "PESAPAL_CONSUMER_KEY is required"),
  PESAPAL_CONSUMER_SECRET: z.string().min(1, "PESAPAL_CONSUMER_SECRET is required"),
  PESAPAL_DEBUG: z.coerce.boolean().default(false),
  // Filled in once, after calling POST /billing-pesapal/admin/register-ipn against this server's own
  // /billing-pesapal/ipn URL (see that route's own comment) — Pesapal requires an IPN be registered
  // and referenced by id on every order, and the id from a DIFFERENT project's IPN URL is useless here.
  PESAPAL_IPN_ID: z.string().min(1, "PESAPAL_IPN_ID is required — see billing-pesapal.ts's register-ipn route"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
