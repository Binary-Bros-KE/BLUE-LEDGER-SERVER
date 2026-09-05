import type { NextFunction, Request, Response } from "express";
import type { WebStore } from "@prisma/client";
import { env } from "../env.js";
import { assertLicenseUsable } from "../lib/license-guard.js";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";

/** Resolved once per storefront request by resolveLiveStore, reused by every /shop route handler.
 * `tenantId` is the key that every subsequent withTenantContext() call uses to read the tenant's
 * actual (RLS'd) products / customers / orders. */
export type ShopContext = { tenantId: string; store: WebStore };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      shopContext?: ShopContext;
    }
  }
}

/** The storefront (NEXT/storefront) is ONE deployment for every tenant. On each request it forwards
 * its own incoming Host as `X-Shop-Domain`; we resolve which tenant that is here. `Host` is the
 * fallback for a direct hit (curl, health checks). Port is kept — the dev preview domain
 * (STOREFRONT_BASE_DOMAIN defaults to "localhost:3200") includes one; real custom domains won't. */
function requestedDomain(req: Request): string {
  const forwarded = req.headers["x-shop-domain"];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host ?? "";
  return raw.trim().toLowerCase();
}

/**
 * Gates every /shop/* route. Mirrors middleware/device-auth.ts's requireDevice: a bare (non-RLS)
 * lookup that resolves the tenant BEFORE any tenant context exists — web_stores is a routing table,
 * not synced business data (see the model's own doc comment). On any failure it throws rather than
 * defaulting to anything.
 *
 * Order of checks is deliberate:
 *  1. domain -> a web_stores row that is LIVE           (else 404 — never leak DRAFT/SUSPENDED)
 *  2. tenant's plan has featureEcommerce                (else 402 — "not on this plan")
 *  3. license is usable (not suspended/cancelled)       (else 403 — assertLicenseUsable)
 *
 * (2) + (3) are the live "unpaid -> POS only" enforcement — re-checked on every single request,
 * nothing scheduled, so it can't drift.
 */
export async function resolveLiveStore(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const domain = requestedDomain(req);
  if (!domain) {
    throw new HttpError(400, "Missing store domain");
  }

  const baseSuffix = `.${env.STOREFRONT_BASE_DOMAIN.toLowerCase()}`;
  const where = domain.endsWith(baseSuffix)
    ? { subdomain: domain.slice(0, -baseSuffix.length) }
    : { customDomain: domain };

  const store = await prisma.webStore.findFirst({
    where,
    include: {
      tenant: {
        include: {
          license: true,
          subscription: { include: { plan: true } },
        },
      },
    },
  });

  // A missing store and a not-yet-published store are the same 404 on purpose — a probe must not be
  // able to tell "this shop doesn't exist" from "this shop isn't live yet".
  if (!store || store.status !== "LIVE") {
    throw new HttpError(404, "No store found at this address");
  }

  // Granted à la carte (Tenant.ecommerceEnabled) OR bundled into the plan tier
  // (Plan.featureEcommerce). Either is enough.
  const plan = store.tenant.subscription?.plan ?? null;
  if (!store.tenant.ecommerceEnabled && !plan?.featureEcommerce) {
    throw new HttpError(402, "This store is not available on the current plan");
  }

  if (!store.tenant.license) {
    throw new HttpError(403, "This store is unavailable — contact the shop.");
  }
  assertLicenseUsable(store.tenant.license);

  // Strip the joined relations back off — handlers only ever need the flat store row + tenantId.
  const { tenant: _tenant, ...flatStore } = store;
  req.shopContext = { tenantId: store.tenantId, store: flatStore as WebStore };
  next();
}
