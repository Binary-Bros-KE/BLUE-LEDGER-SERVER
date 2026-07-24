import bcrypt from "bcryptjs";
import { HttpError } from "../lib/http-error.js";
import { signAccountToken } from "../middleware/auth.js";
import { prisma } from "../prisma.js";
import { loginSchema } from "../schemas/auth.js";
import { toPublicAccount, type PublicAccount } from "./account-service.js";

export async function login(input: unknown): Promise<{ token: string; account: PublicAccount }> {
  const parsed = loginSchema.parse(input);
  const account = await prisma.account.findUnique({ where: { email: parsed.email } });

  // Same generic message either way — never reveal whether the email exists.
  if (!account || !account.isActive) {
    throw new HttpError(401, "Invalid email or password");
  }
  const passwordValid = await bcrypt.compare(parsed.password, account.passwordHash);
  if (!passwordValid) {
    throw new HttpError(401, "Invalid email or password");
  }

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date() },
    include: { outlet: true },
  });
  const token = signAccountToken({ sub: updated.id, role: updated.role, outletId: updated.outletId });

  return { token, account: toPublicAccount(updated) };
}

/** Backs GET /auth/me — lets the dashboard re-hydrate "logged in as X" on every load/refresh
 * without re-sending a password, and re-validates the account hasn't been deactivated since the
 * token was issued (the JWT itself has no way to know that). */
export async function getCurrentAccount(id: string): Promise<PublicAccount> {
  const account = await prisma.account.findUnique({ where: { id }, include: { outlet: true } });
  if (!account || !account.isActive) {
    throw new HttpError(401, "Session no longer valid — log in again");
  }
  return toPublicAccount(account);
}
