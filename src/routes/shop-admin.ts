import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireDevice } from "../middleware/device-auth.js";
import {
  productImageDeleteSchema,
  productImageUploadSchema,
  storeConfigUpdateSchema,
  themeImageUploadSchema,
  themeUpdateSchema,
} from "../schemas/shop.js";
import * as shopOwnerService from "../services/shop-owner-service.js";

/**
 * Store-owner API — the desktop POS "Online Store" tab (see ECOMMERCE-ARCHITECTURE.md §6.3).
 * Device-authenticated exactly like /sync (requireDevice reads {tenantId, deviceId} from the body),
 * NOT Account/JWT — a POS install isn't an Account.
 *
 * Scope is deliberately narrow: publish state and online price/description overrides are plain
 * synced Product columns and never touch this router. What's here is only what the sync engine
 * can't carry — image *bytes* to object storage, and the cloud-only web_stores look/delivery/
 * payment config.
 */
export const shopAdminRouter = Router();

// Image uploads are a few per session at most; everything else is trivial. Keyed by IP.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again in a minute." },
});

shopAdminRouter.use(limiter);
shopAdminRouter.use(requireDevice);

shopAdminRouter.post("/store", async (req, res) => {
  res.json(await shopOwnerService.getStoreForDevice(req.syncContext!.tenantId));
});

shopAdminRouter.post("/store/update", async (req, res) => {
  const parsed = storeConfigUpdateSchema.parse(req.body);
  res.json(await shopOwnerService.updateStoreConfig(req.syncContext!.tenantId, parsed));
});

shopAdminRouter.post("/upload", async (req, res) => {
  const parsed = productImageUploadSchema.parse(req.body);
  res.json(await shopOwnerService.uploadImage(req.syncContext!.tenantId, parsed));
});

shopAdminRouter.post("/image/delete", async (req, res) => {
  const parsed = productImageDeleteSchema.parse(req.body);
  res.json(await shopOwnerService.deleteImage(req.syncContext!.tenantId, parsed));
});

// --- Trylist theme (storefront look) ---
shopAdminRouter.post("/theme/update", async (req, res) => {
  const parsed = themeUpdateSchema.parse(req.body);
  res.json(await shopOwnerService.updateTheme(req.syncContext!.tenantId, parsed));
});

shopAdminRouter.post("/theme/upload", async (req, res) => {
  const parsed = themeImageUploadSchema.parse(req.body);
  res.json(await shopOwnerService.uploadThemeAsset(req.syncContext!.tenantId, parsed));
});
