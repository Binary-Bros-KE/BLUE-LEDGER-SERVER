import { Router, type Request } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireAuth, type AuthenticatedAccount } from "../middleware/auth.js";
import * as activityService from "../services/activity-service.js";

/** Admin Activity tab (services/activity-service.ts). Both roles; a MARKETER only sees their outlet's
 * businesses, same boundary as the tenants routes. */
export const activityRouter = Router();
activityRouter.use(requireAuth);

function requireAccount(req: Request): asserts req is Request & { account: AuthenticatedAccount } {
  if (!req.account) throw new HttpError(401, "Not authenticated");
}

activityRouter.get("/", async (req, res) => {
  requireAccount(req);
  res.json(await activityService.getActivityOverview(req.account));
});

activityRouter.get("/tenants/:id", async (req, res) => {
  requireAccount(req);
  res.json(await activityService.getTenantActivity(req.params.id as string, req.account));
});
