import { Router } from "express";
import { requireSuperAdmin } from "../middleware/auth.js";
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

// --- Admin-dashboard equivalents --- a SUPER_ADMIN triggering/checking a payment on a client's
// behalf (e.g. over a support call), identified by tenantId (already known from the open tenant
// page) instead of a license key. Same underlying STK logic, same BillingMpesaTransaction table.
billingMpesaRouter.post("/admin/stk-push", requireSuperAdmin, async (req, res) => {
  const result = await billingMpesaService.initiateBillingStkPushAsAdmin(req.body);
  res.status(201).json(result);
});

billingMpesaRouter.post("/admin/status", requireSuperAdmin, async (req, res) => {
  const result = await billingMpesaService.getBillingMpesaStatusAsAdmin(req.body);
  res.json(result);
});

billingMpesaRouter.post("/admin/status/check", requireSuperAdmin, async (req, res) => {
  const result = await billingMpesaService.checkBillingMpesaStatusManuallyAsAdmin(req.body);
  res.json(result);
});
