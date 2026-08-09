import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { registerIPN } from "../lib/pesapal-client.js";
import { env } from "../env.js";
import * as billingPesapalService from "../services/billing-pesapal-service.js";

/** License-key-authenticated throughout (like billing-mpesa.ts) — no requireDevice/requireAuth on
 * the tenant-facing routes below. This is a tenant paying Blue Ledger for their OWN subscription,
 * which can legitimately happen before any employee is logged in (Pay Now from the lockout screen
 * itself). */
export const billingPesapalRouter = Router();

// Pesapal's own servers call this — GET, per Pesapal's documented IPN convention (unlike Safaricom's
// POST callback). No auth possible, must be registered before anything else. The IPN carries no
// payment result itself — handlePesapalIPN always follows up with a live GetTransactionStatus call.
billingPesapalRouter.get("/ipn", async (req, res) => {
  const orderTrackingId = typeof req.query.OrderTrackingId === "string" ? req.query.OrderTrackingId : undefined;
  const orderMerchantReference = typeof req.query.OrderMerchantReference === "string" ? req.query.OrderMerchantReference : undefined;
  const orderNotificationType = typeof req.query.OrderNotificationType === "string" ? req.query.OrderNotificationType : "IPNCHANGE";

  await billingPesapalService.handlePesapalIPN(orderTrackingId, orderMerchantReference);

  // Pesapal requires this exact acknowledgment shape back, regardless of what happened internally —
  // DESKTOP's own passive/active polling (never this response) is what actually surfaces the result
  // to the tenant, so there's nothing more useful to return here even on an internal error.
  res.json({
    orderNotificationType,
    orderTrackingId,
    orderMerchantReference,
    status: 200,
  });
});

// Where the tenant's own browser lands after completing (or abandoning) checkout on Pesapal's hosted
// page — DESKTOP has no web frontend to redirect into, and the real result is already being polled
// from inside the app itself (same passive/active pattern as M-Pesa), so this is just a static "you
// can close this tab" page, same inline-HTML style as app.ts's own /download/mac picker page.
billingPesapalRouter.get("/callback", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8" /><title>Blue Ledger POS — Payment</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #0b1d4d; color: #fff; display: flex;
    align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #12275f; border-radius: 16px; padding: 32px 36px; text-align: center; max-width: 380px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { font-size: 13px; color: #b7c1e0; margin: 0; line-height: 1.5; }
</style></head>
<body><div class="card">
  <h1>Thanks — you can close this tab</h1>
  <p>Blue Ledger POS is checking your payment status automatically. Go back to the app to see it confirmed.</p>
</div></body></html>`);
});

billingPesapalRouter.post("/submit-order", async (req, res) => {
  const result = await billingPesapalService.initiateBillingPesapalOrder(req.body);
  res.status(201).json(result);
});

// Passive — polled automatically. Never calls Pesapal.
billingPesapalRouter.post("/status", async (req, res) => {
  const result = await billingPesapalService.getPesapalStatus(req.body);
  res.json(result);
});

// Manual only — an explicit "Check Status Now" click.
billingPesapalRouter.post("/status/check", async (req, res) => {
  const result = await billingPesapalService.checkPesapalStatusManually(req.body);
  res.json(result);
});

// --- Admin-dashboard equivalents --- same shape/reasoning as billing-mpesa.ts's own admin routes:
// any authenticated staff account, identified by tenantId instead of a license key. Must come AFTER
// requireAuth (this router has no blanket .use(requireAuth) — the license-key routes above are
// deliberately reachable pre-login).
billingPesapalRouter.post("/admin/submit-order", requireAuth, async (req, res) => {
  const result = await billingPesapalService.initiateBillingPesapalOrderAsAdmin(req.body);
  res.status(201).json(result);
});

billingPesapalRouter.post("/admin/status", requireAuth, async (req, res) => {
  const result = await billingPesapalService.getPesapalStatusAsAdmin(req.body);
  res.json(result);
});

billingPesapalRouter.post("/admin/status/check", requireAuth, async (req, res) => {
  const result = await billingPesapalService.checkPesapalStatusManuallyAsAdmin(req.body);
  res.json(result);
});

// One-time setup — registers this server's own /billing-pesapal/ipn URL with Pesapal and returns a
// fresh ipn_id to put in PESAPAL_IPN_ID. Must be re-run any time SERVER_PUBLIC_URL changes. Gated
// behind requireAuth only (not requireSuperAdmin) purely to keep this consistent with the other
// admin/* routes here — in practice only ever called once, by hand, right after a deploy.
billingPesapalRouter.post("/admin/register-ipn", requireAuth, async (_req, res) => {
  const result = await registerIPN(`${env.SERVER_PUBLIC_URL}/billing-pesapal/ipn`);
  res.json({ ipn_id: result.ipn_id, registered_url: result.url, note: "Set PESAPAL_IPN_ID to ipn_id above and restart the server." });
});
