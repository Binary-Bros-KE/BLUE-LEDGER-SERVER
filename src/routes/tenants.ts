import { Router, type Request } from "express";
import { HttpError } from "../lib/http-error.js";
import { requireAuth, requireSuperAdmin, type AuthenticatedAccount } from "../middleware/auth.js";
import * as deviceService from "../services/device-service.js";
import * as licenseService from "../services/license-service.js";
import * as subscriptionPaymentService from "../services/subscription-payment-service.js";
import * as subscriptionService from "../services/subscription-service.js";
import * as tenantService from "../services/tenant-service.js";

export const tenantsRouter = Router();

// Both roles reach this router — MARKETER just gets an outlet-scoped view/create, enforced inside
// tenant-service.ts. PATCH/DELETE additionally require requireSuperAdmin below.
tenantsRouter.use(requireAuth);

/** requireAuth (above) always sets req.account before any handler here runs — this just narrows
 * the type from optional to required so callers don't need a redundant runtime check. */
function requireAccount(req: Request): asserts req is Request & { account: AuthenticatedAccount } {
  if (!req.account) {
    throw new HttpError(401, "Not authenticated");
  }
}

tenantsRouter.get("/", async (req, res) => {
  requireAccount(req);
  const tenants = await tenantService.listTenants(req.account);
  res.json(tenants);
});

tenantsRouter.get("/:id", async (req, res) => {
  requireAccount(req);
  const tenant = await tenantService.getTenant(req.params.id as string, req.account);
  res.json(tenant);
});

tenantsRouter.post("/", async (req, res) => {
  requireAccount(req);
  const tenant = await tenantService.createTenant(req.body, req.account);
  res.status(201).json(tenant);
});

tenantsRouter.patch("/:id", requireSuperAdmin, async (req, res) => {
  const tenant = await tenantService.updateTenant(req.params.id as string, req.body);
  res.json(tenant);
});

tenantsRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  await tenantService.deleteTenant(req.params.id as string);
  res.status(204).send();
});

// --- Subscription --- SUPER_ADMIN only, same sensitivity as editing the tenant itself.
tenantsRouter.patch("/:id/subscription", requireSuperAdmin, async (req, res) => {
  const subscription = await subscriptionService.updateSubscription(req.params.id as string, req.body);
  res.json(subscription);
});

// --- License --- SUPER_ADMIN only.
tenantsRouter.post("/:id/license/suspend", requireSuperAdmin, async (req, res) => {
  const license = await licenseService.suspendLicense(req.params.id as string, req.body);
  res.json(license);
});

tenantsRouter.post("/:id/license/reactivate", requireSuperAdmin, async (req, res) => {
  const license = await licenseService.reactivateLicense(req.params.id as string);
  res.json(license);
});

tenantsRouter.patch("/:id/license", requireSuperAdmin, async (req, res) => {
  const license = await licenseService.updateLicense(req.params.id as string, req.body);
  res.json(license);
});

// --- Devices --- a device is only ever CREATED via /activation/register; renaming its label is
// the one field an admin can edit directly, SUPER_ADMIN only like every other PATCH here.
tenantsRouter.get("/:id/devices", async (req, res) => {
  requireAccount(req);
  const devices = await deviceService.listDevices(req.params.id as string, req.account);
  res.json(devices);
});

tenantsRouter.patch("/:id/devices/:deviceId", requireSuperAdmin, async (req, res) => {
  const device = await deviceService.renameDevice(req.params.id as string, req.params.deviceId as string, req.body);
  res.json(device);
});

// --- Payments --- read follows the same outlet-scoped visibility as the tenant itself; recording
// a payment is SUPER_ADMIN only (a billing-state-changing action, not "create a client").
tenantsRouter.get("/:id/payments", async (req, res) => {
  requireAccount(req);
  const payments = await subscriptionPaymentService.listPayments(req.params.id as string, req.account);
  res.json(payments);
});

tenantsRouter.post("/:id/payments", requireSuperAdmin, async (req, res) => {
  requireAccount(req);
  const payment = await subscriptionPaymentService.recordPayment(req.params.id as string, req.body, req.account);
  res.status(201).json(payment);
});
