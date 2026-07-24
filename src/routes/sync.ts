import { Router } from "express";
import { requireDevice } from "../middleware/device-auth.js";
import * as syncService from "../services/sync-service.js";

/** Every route here is device-authenticated (see requireDevice), NOT Account/JWT — a desktop
 * install isn't an Account. Generic per-entity endpoints (not one route per entity) so adding a
 * Phase 2/3 entity later only means adding it to sync-service.ts's ENTITY_DELEGATES map. */
export const syncRouter = Router();
syncRouter.use(requireDevice);

syncRouter.post("/push", async (req, res) => {
  const result = await syncService.pushRows(req.body);
  res.json(result);
});

syncRouter.post("/pull", async (req, res) => {
  const result = await syncService.pullRows(req.body);
  res.json(result);
});

syncRouter.post("/counts", async (req, res) => {
  const result = await syncService.getCounts(req.body);
  res.json(result);
});

syncRouter.post("/row-status", async (req, res) => {
  const result = await syncService.getRowStatus(req.body);
  res.json(result);
});
