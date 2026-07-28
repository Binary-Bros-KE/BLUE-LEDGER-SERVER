import { Router } from "express";
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
