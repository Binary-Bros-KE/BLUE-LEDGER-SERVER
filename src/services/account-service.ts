import type { Account, Outlet } from "@prisma/client";
import bcrypt from "bcryptjs";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { accountCreateSchema, accountUpdateSchema } from "../schemas/account.js";

const SALT_ROUNDS = 10;

const WITH_OUTLET = { include: { outlet: true } } as const;
type AccountWithOutlet = Account & { outlet: Outlet | null };

/** Never let a password hash leave this module — every function below returns this shape. The
 * outlet is embedded (not just outletId) since both the Accounts table and a MARKETER's own
 * "logged in as" display need the outlet's NAME, and a MARKETER can't call GET /outlets to look
 * it up themselves (that route is super-admin only). */
export type PublicAccount = Omit<AccountWithOutlet, "passwordHash">;

export function toPublicAccount(account: AccountWithOutlet): PublicAccount {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}

async function assertOutletExists(outletId: string): Promise<void> {
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
  if (!outlet) {
    throw new HttpError(400, "Selected outlet was not found");
  }
}

async function getAccountRow(id: string): Promise<AccountWithOutlet> {
  const account = await prisma.account.findUnique({ where: { id }, ...WITH_OUTLET });
  if (!account) {
    throw new NotFoundError("Account not found");
  }
  return account;
}

// Every function here is only ever reached via a SUPER_ADMIN-gated router (see
// routes/accounts.ts) — a MARKETER can't list, view, or CRUD their teammates at all.

export async function listAccounts(): Promise<PublicAccount[]> {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "desc" }, ...WITH_OUTLET });
  return accounts.map(toPublicAccount);
}

export async function getAccount(id: string): Promise<PublicAccount> {
  return toPublicAccount(await getAccountRow(id));
}

export async function createAccount(input: unknown): Promise<PublicAccount> {
  const parsed = accountCreateSchema.parse(input);
  if (parsed.outletId) {
    await assertOutletExists(parsed.outletId);
  }

  const passwordHash = await bcrypt.hash(parsed.password, SALT_ROUNDS);
  const account = await prisma.account.create({
    data: {
      name: parsed.name,
      email: parsed.email,
      passwordHash,
      role: parsed.role,
      outletId: parsed.outletId,
      isActive: parsed.isActive,
    },
    ...WITH_OUTLET,
  });
  return toPublicAccount(account);
}

export async function updateAccount(id: string, input: unknown): Promise<PublicAccount> {
  const parsed = accountUpdateSchema.parse(input);
  const existing = await getAccountRow(id);

  // A PATCH only carries the fields it changes — check the EFFECTIVE role/outlet (existing merged
  // with whatever this update actually touches), not just what's in this one request.
  const effectiveRole = parsed.role ?? existing.role;
  const effectiveOutletId = parsed.outletId !== undefined ? parsed.outletId : existing.outletId;
  if (effectiveRole === "MARKETER" && !effectiveOutletId) {
    throw new HttpError(400, "A marketer account must be assigned to an outlet");
  }
  if (effectiveOutletId) {
    await assertOutletExists(effectiveOutletId);
  }

  const passwordHash = parsed.password ? await bcrypt.hash(parsed.password, SALT_ROUNDS) : undefined;

  const account = await prisma.account.update({
    where: { id },
    data: {
      name: parsed.name,
      email: parsed.email,
      role: parsed.role,
      outletId: parsed.outletId,
      isActive: parsed.isActive,
      ...(passwordHash ? { passwordHash } : {}),
    },
    ...WITH_OUTLET,
  });
  return toPublicAccount(account);
}

/** actingAccountId is whoever is making the request — prevents a super admin from deleting the
 * very session they're currently using (no recovery flow exists yet if they lock themselves out). */
export async function deleteAccount(id: string, actingAccountId: string): Promise<void> {
  if (id === actingAccountId) {
    throw new HttpError(400, "You can't delete your own account while logged in as it");
  }
  await getAccountRow(id);
  await prisma.account.delete({ where: { id } });
}
