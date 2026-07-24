import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireDevice } from "../middleware/device-auth.js";
import * as shareService from "../services/share-service.js";

/** Minting a link is gated by requireDevice (the desktop's own {tenantId, deviceId}, same as every
 * /sync/* route). Resolving one is fully public — the token itself, not a session, is the
 * authorization, same model as any share-link product (Dropbox, Google Docs, etc.): unguessable,
 * scoped to one document, expires on its own. */
export const shareRouter = Router();

/** Basic scrape/abuse hygiene, not a credential-guessing defense — a share token is a signed JWT,
 * not a brute-forceable PIN, so this is nowhere near as strict as mobile-auth's loginLimiter. */
const shareViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

shareRouter.post("/links", requireDevice, async (req, res) => {
  const result = await shareService.createShareLink(req.body);
  res.status(201).json(result);
});

shareRouter.get("/:token", shareViewLimiter, async (req, res) => {
  const result = await shareService.getSharedDocument(req.params.token as string);
  res.json(result);
});
