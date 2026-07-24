import { Router } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import * as accountService from "../services/account-service.js";

export const accountsRouter = Router();

// SUPER_ADMIN only, for the whole router — a MARKETER can't reach any of these, not even to view.
accountsRouter.use(requireAuth, requireSuperAdmin);

accountsRouter.get("/", async (_req, res) => {
  const accounts = await accountService.listAccounts();
  res.json(accounts);
});

accountsRouter.get("/:id", async (req, res) => {
  const account = await accountService.getAccount(req.params.id as string);
  res.json(account);
});

accountsRouter.post("/", async (req, res) => {
  const account = await accountService.createAccount(req.body);
  res.status(201).json(account);
});

accountsRouter.patch("/:id", async (req, res) => {
  const account = await accountService.updateAccount(req.params.id as string, req.body);
  res.json(account);
});

accountsRouter.delete("/:id", async (req, res) => {
  if (!req.account) {
    throw new HttpError(401, "Not authenticated");
  }
  await accountService.deleteAccount(req.params.id as string, req.account.id);
  res.status(204).send();
});
