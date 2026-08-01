import { Router, type Request } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireAuth, requireSuperAdmin, type AuthenticatedAccount } from "../middleware/auth.js";
import * as planService from "../services/plan-service.js";

export const plansRouter = Router();

// Both roles reach this router — a MARKETER gets an outlet-scoped view and can create new plans for
// their own outlet's catalog; update/delete still require requireSuperAdmin below.
plansRouter.use(requireAuth);

function requireAccount(req: Request): asserts req is Request & { account: AuthenticatedAccount } {
  if (!req.account) {
    throw new HttpError(401, "Not authenticated");
  }
}

plansRouter.get("/", async (req, res) => {
  requireAccount(req);
  const plans = await planService.listPlans(req.account);
  res.json(plans);
});

plansRouter.get("/:id", async (req, res) => {
  requireAccount(req);
  const plan = await planService.getPlanForActor(req.params.id as string, req.account);
  res.json(plan);
});

plansRouter.post("/", async (req, res) => {
  requireAccount(req);
  const plan = await planService.createPlan(req.body, req.account);
  res.status(201).json(plan);
});

plansRouter.patch("/:id", requireSuperAdmin, async (req, res) => {
  const plan = await planService.updatePlan(req.params.id as string, req.body);
  res.json(plan);
});

plansRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  await planService.deletePlan(req.params.id as string);
  res.status(204).send();
});
