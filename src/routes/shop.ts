import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../env.js";
import { resolveLiveStore } from "../middleware/shop-tenant.js";
import { catalogQuerySchema } from "../schemas/shop.js";
import * as shopService from "../services/shop-service.js";

/**
 * Public storefront API (see ECOMMERCE-ARCHITECTURE.md §6). Consumed by the single multi-tenant
 * NEXT/storefront deployment. Every route resolves the tenant from the request's domain via
 * resolveLiveStore, which also enforces the live "paid + licensed" gate — a tenant whose plan
 * loses featureEcommerce (or whose license lapses) serves 402/403 here on the very next request,
 * nothing scheduled.
 *
 * P0 = read-only catalog. Shopper accounts, cart and orders (/shop/auth/*, /shop/orders) are P1/P2.
 */
export const shopRouter = Router();

/** True when the request carries the storefront's shared key. Hashing both sides first gives equal
 * lengths for timingSafeEqual, so the comparison leaks nothing about the key. */
function isStorefront(req: Request): boolean {
  const sent = req.get("x-storefront-key");
  if (!env.STOREFRONT_API_KEY || !sent) return false;
  const a = createHash("sha256").update(sent).digest();
  const b = createHash("sha256").update(env.STOREFRONT_API_KEY).digest();
  return timingSafeEqual(a, b);
}

// Why limit at all: /shop is public and unauthenticated, and this same server runs POS sync and the
// mobile app for every tenant — a scraper hammering the catalogue must not be able to slow those.
// But real shoppers never call /shop themselves: the storefront calls it for them, from its own
// servers, so a per-IP limit would put ALL shoppers of ALL shops in one bucket. The storefront
// therefore identifies itself (X-Storefront-Key) and is never limited; only direct callers are.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  skip: isStorefront,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — slow down and try again shortly." },
});

shopRouter.use(publicLimiter);
shopRouter.use(resolveLiveStore);

shopRouter.get("/store", async (req, res) => {
  res.json(await shopService.getStorePayload(req.shopContext!));
});

shopRouter.get("/catalog", async (req, res) => {
  const query = catalogQuerySchema.parse(req.query);
  res.json(await shopService.listCatalog(req.shopContext!, query));
});

shopRouter.get("/categories", async (req, res) => {
  res.json(await shopService.listCategories(req.shopContext!));
});

shopRouter.get("/delivery", async (req, res) => {
  res.json(await shopService.listDeliveryMethods(req.shopContext!));
});

shopRouter.get("/product/:id", async (req, res) => {
  res.json(await shopService.getProductDetail(req.shopContext!, req.params.id as string));
});
