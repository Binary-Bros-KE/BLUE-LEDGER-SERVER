import { Router } from "express";
import * as verification from "../services/mpesa-verification-service.js";

/** Safaricom's C2B callbacks. Public, authenticated only by the secret token in the URL. The path
 * deliberately avoids "mpesa": Daraja refuses to register URLs containing it. */
export const lipaRouter = Router();

lipaRouter.post("/c2b/:token/confirm", async (req, res) => {
  try {
    await verification.handleC2bConfirmation(req.params.token as string, req.body);
  } catch (err) {
    // Still acknowledged: Pull Transactions can recover a missed row, retries can't fix a bug here.
    console.error("[mpesa-c2b] failed to record a confirmation:", err instanceof Error ? err.message : err);
  }
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// Only called if external validation is switched on for the till. We never block a customer's payment.
lipaRouter.post("/c2b/:token/validate", (_req, res) => {
  res.json({ ResultCode: "0", ResultDesc: "Accepted" });
});
