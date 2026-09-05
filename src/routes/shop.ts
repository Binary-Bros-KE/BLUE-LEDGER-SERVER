import { Router } from "express";
import rateLimit from "express-rate-limit";
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

// A public, unauthenticated surface on the open internet — a generous ceiling that a normal
// browsing session never touches, but caps scrapers / abuse. Keyed by IP (see app.ts trust proxy).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
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

shopRouter.get("/product/:id", async (req, res) => {
  res.json(await shopService.getProductDetail(req.shopContext!, req.params.id as string));
});
