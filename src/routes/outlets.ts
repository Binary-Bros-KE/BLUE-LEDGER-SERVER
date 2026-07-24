import { Router } from "express";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import * as outletService from "../services/outlet-service.js";

export const outletsRouter = Router();

// SUPER_ADMIN only, for the whole router.
outletsRouter.use(requireAuth, requireSuperAdmin);

outletsRouter.get("/", async (_req, res) => {
  const outlets = await outletService.listOutlets();
  res.json(outlets);
});

outletsRouter.get("/:id", async (req, res) => {
  const outlet = await outletService.getOutlet(req.params.id as string);
  res.json(outlet);
});

outletsRouter.post("/", async (req, res) => {
  const outlet = await outletService.createOutlet(req.body);
  res.status(201).json(outlet);
});

outletsRouter.patch("/:id", async (req, res) => {
  const outlet = await outletService.updateOutlet(req.params.id as string, req.body);
  res.json(outlet);
});

outletsRouter.delete("/:id", async (req, res) => {
  await outletService.deleteOutlet(req.params.id as string);
  res.status(204).send();
});
