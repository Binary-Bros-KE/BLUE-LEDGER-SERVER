import { Router } from "express";
import * as activationService from "../services/activation-service.js";

/** Deliberately NOT behind requireAuth — a fresh desktop install has no Account/JWT at all. The
 * license key itself is the credential these two endpoints authenticate against. */
export const activationRouter = Router();

activationRouter.post("/register", async (req, res) => {
  const result = await activationService.registerDevice(req.body);
  res.status(201).json(result);
});

activationRouter.post("/heartbeat", async (req, res) => {
  const result = await activationService.heartbeat(req.body);
  res.json(result);
});

activationRouter.post("/profile", async (req, res) => {
  const result = await activationService.updateProfile(req.body);
  res.json(result);
});

activationRouter.post("/payments", async (req, res) => {
  const result = await activationService.listPayments(req.body);
  res.json(result);
});
