import { Router } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireAuth } from "../middleware/auth.js";
import * as authService from "../services/auth-service.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const result = await authService.login(req.body);
  res.json(result);
});

authRouter.get("/me", requireAuth, async (req, res) => {
  if (!req.account) {
    throw new HttpError(401, "Not authenticated");
  }
  const account = await authService.getCurrentAccount(req.account.id);
  res.json(account);
});
