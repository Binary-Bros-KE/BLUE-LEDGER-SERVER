import { Router } from "express";
import { requireDevice } from "../middleware/device-auth.js";
import * as mpesaService from "../services/mpesa-service.js";
import * as verification from "../services/mpesa-verification-service.js";

export const mpesaRouter = Router();

// Safaricom's own servers call this — no device auth possible, and it must be registered BEFORE
// the requireDevice gate below applies to everything else on this router.
mpesaRouter.post("/callback", async (req, res) => {
  await mpesaService.handleMpesaCallback(req.body);
  // Safaricom only cares that this 2xxs — the body content doesn't matter to them.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

mpesaRouter.use(requireDevice);

mpesaRouter.post("/settings/get", async (req, res) => {
  const result = await mpesaService.getMpesaSettings(req.body);
  res.json(result);
});

mpesaRouter.post("/settings/save", async (req, res) => {
  const result = await mpesaService.saveMpesaSettings(req.body);
  res.json(result);
});

mpesaRouter.post("/configured", async (req, res) => {
  const result = await mpesaService.isMpesaConfigured(req.body);
  res.json(result);
});

/** requireDevice has already proven tenantId + deviceId in the body. */
function deviceActor(body: { tenantId: string; deviceId: string; employeeId?: string }): verification.MpesaActor {
  return { tenantId: body.tenantId, deviceId: body.deviceId, employeeId: body.employeeId ?? null };
}

mpesaRouter.post("/verification/state", async (req, res) => {
  res.json(await verification.getVerificationState(req.body.tenantId, req.body.locationId));
});

mpesaRouter.post("/verification/mode", async (req, res) => {
  res.json(await verification.saveVerificationMode(req.body.tenantId, req.body));
});

mpesaRouter.post("/verification/connect", async (req, res) => {
  res.json(await verification.connectC2b(req.body.tenantId, req.body.locationId));
});

mpesaRouter.post("/verification/check-payment", async (req, res) => {
  res.json(await verification.checkPayment(req.body.tenantId, req.body));
});

mpesaRouter.post("/verification/verify", async (req, res) => {
  res.json(await verification.verifyCode(deviceActor(req.body), req.body));
});

mpesaRouter.post("/verification/attach", async (req, res) => {
  res.json(await verification.attachClaim(req.body.tenantId, req.body));
});

// Admin-only correction is enforced on the till (DESKTOP's permission system lives there).
mpesaRouter.post("/verification/verify-sale", async (req, res) => {
  res.json(await verification.verifySaleCodeForDevice(deviceActor(req.body), req.body));
});

mpesaRouter.post("/stk-push", async (req, res) => {
  const result = await mpesaService.requestStkPush(req.body);
  res.status(201).json(result);
});

// Passive — polled automatically while showing "waiting for customer to enter PIN." Never calls
// Safaricom; only reads this transaction's own current status.
mpesaRouter.post("/status", async (req, res) => {
  const result = await mpesaService.getMpesaStatus(req.body);
  res.json(result);
});

// Manual only — hit exclusively by an explicit cashier "Check Status Now" click when the STK push
// is taking a while. Actively re-queries Safaricom (throttled server-side).
mpesaRouter.post("/status/check", async (req, res) => {
  const result = await mpesaService.checkMpesaStatusManually(req.body);
  res.json(result);
});
