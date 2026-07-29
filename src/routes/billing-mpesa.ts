import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as billingMpesaService from "../services/billing-mpesa-service.js";

/** License-key-authenticated throughout (like activation.ts) — no requireDevice/requireAuth here.
 * This is a tenant paying Blue Ledger for their OWN subscription, which can legitimately happen
 * before any employee is logged in (Pay Now from the lockout screen itself). */
export const billingMpesaRouter = Router();

// Safaricom's own servers call this — no auth possible, must be registered before anything else.
billingMpesaRouter.post("/callback", async (req, res) => {
  await billingMpesaService.handleBillingMpesaCallback(req.body);
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

billingMpesaRouter.post("/stk-push", async (req, res) => {
  const result = await billingMpesaService.initiateBillingStkPush(req.body);
  res.status(201).json(result);
});

// Passive — polled automatically. Never calls Safaricom.
billingMpesaRouter.post("/status", async (req, res) => {
  const result = await billingMpesaService.getBillingMpesaStatus(req.body);
  res.json(result);
});

// Manual only — an explicit "Check Status Now" click.
billingMpesaRouter.post("/status/check", async (req, res) => {
  const result = await billingMpesaService.checkBillingMpesaStatusManually(req.body);
  res.json(result);
});

// --- Admin-dashboard equivalents --- any logged-in admin account (SUPER_ADMIN or MARKETER)
// triggering/checking a payment on a client's behalf (e.g. over a support call), identified by
// tenantId (already known from the open tenant page) instead of a license key. Same underlying STK
// logic, same BillingMpesaTransaction table. Deliberately NOT requireSuperAdmin — the money always
// lands in the tenant's own Outlet Till regardless of who initiates the push, so there's no fraud
// exposure in letting any authenticated staff member send one (explicit product decision). Must
// come AFTER requireAuth (this router has no blanket .use(requireAuth) — the license-key routes
// above are deliberately reachable pre-login) so req.account actually gets populated here.
billingMpesaRouter.post("/admin/stk-push", requireAuth, async (req, res) => {
  const result = await billingMpesaService.initiateBillingStkPushAsAdmin(req.body);
  res.status(201).json(result);
});

billingMpesaRouter.post("/admin/status", requireAuth, async (req, res) => {
  const result = await billingMpesaService.getBillingMpesaStatusAsAdmin(req.body);
  res.json(result);
});

billingMpesaRouter.post("/admin/status/check", requireAuth, async (req, res) => {
  const result = await billingMpesaService.checkBillingMpesaStatusManuallyAsAdmin(req.body);
  res.json(result);
});
