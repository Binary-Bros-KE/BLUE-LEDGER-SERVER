import type { AccountRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";

/** The decoded, trusted identity of whoever is calling — attached by requireAuth, read by every
 * route/service downstream. Never trust req.body for who the caller is; always this. */
export type AuthenticatedAccount = {
  id: string;
  role: AccountRole;
  /** Null only for SUPER_ADMIN — see Account.outletId in schema.prisma. */
  outletId: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: AuthenticatedAccount;
    }
  }
}

type TokenPayload = { sub: string; role: AccountRole; outletId: string | null };

/** Verifies the Bearer JWT and attaches req.account. Every route below /tenants, /accounts, and
 * /outlets requires this — only /auth/login and /health are reachable unauthenticated. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    throw new HttpError(401, "Missing or invalid Authorization header");
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    req.account = { id: payload.sub, role: payload.role, outletId: payload.outletId };
    next();
  } catch {
    throw new HttpError(401, "Invalid or expired session — log in again");
  }
}

/** Gates an entire router (Accounts, Outlets) or a single route (Tenant edit/delete) to
 * SUPER_ADMIN only. Must run after requireAuth. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.account?.role !== "SUPER_ADMIN") {
    throw new HttpError(403, "Only a super admin can do that");
  }
  next();
}

export function signAccountToken(account: TokenPayload): string {
  return jwt.sign(account, env.JWT_SECRET, { expiresIn: "12h" });
}
