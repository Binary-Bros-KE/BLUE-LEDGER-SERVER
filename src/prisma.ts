import { PrismaClient } from "@prisma/client";

/** Single shared client for the tenants registry database — not to be confused with the
 * per-tenant application database clients that'll be introduced when sync/provisioning lands. */
export const prisma = new PrismaClient();
