import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireMobileAuth, requireOwnerAppAccess } from "../middleware/mobile-auth.js";
import { mobileDashboardQuerySchema } from "../schemas/mobile.js";
import * as mobileAuthService from "../services/mobile-auth-service.js";
import * as mobileDirectoryService from "../services/mobile-directory-service.js";
import * as mobileMetricsService from "../services/mobile-metrics-service.js";

/** Read-only Owner App — see plan notes in schema.prisma's MobileLoginAttempt comment. Deliberately
 * NOT behind requireAuth (that's the Blue Ledger Account/JWT system) — this is a tenant Employee
 * logging in with the same credentials they already use on the DESKTOP POS. */
export const mobileRouter = Router();

/** A 6-digit PIN is only 1,000,000 combinations — this is the first credential-guessing surface in
 * SERVER exposed to the public internet (activation's license-key endpoints have no equivalent
 * throttle, but a license key is a full UUID, not a brute-forceable PIN). Generous enough not to
 * lock out a shop's shared wifi; the real per-account lockout is mobile-auth-service.ts's
 * MobileLoginAttempt counter, keyed by (tenant, employeeCode) rather than IP. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this network. Try again later." },
});

mobileRouter.post("/login", loginLimiter, async (req, res) => {
  const result = await mobileAuthService.loginMobile(req.body);
  res.json(result);
});

mobileRouter.get("/me", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.getMe(req.mobileSession!.tenantId, req.mobileSession!.employeeId);
  res.json(result);
});

mobileRouter.get("/dashboard", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileDashboardQuerySchema.parse(req.query);
  const result = await mobileMetricsService.getOwnerDashboard(req.mobileSession!.tenantId, parsed.period);
  res.json(result);
});

mobileRouter.get("/employees", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.listEmployees(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/employees/:id/salaries", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.getEmployeeSalaries(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});
