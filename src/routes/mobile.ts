import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireMobileAuth, requireOwnerAppAccess } from "../middleware/mobile-auth.js";
import { mobileDashboardQuerySchema, mobileSalesQuerySchema, mobileShareLinkSchema, salesReportPeriodQuerySchema } from "../schemas/mobile.js";
import * as mobileAuthService from "../services/mobile-auth-service.js";
import * as mobileCustomersService from "../services/mobile-customers-service.js";
import * as mobileDirectoryService from "../services/mobile-directory-service.js";
import * as mobileExpensesService from "../services/mobile-expenses-service.js";
import * as mobileInventoryService from "../services/mobile-inventory-service.js";
import * as mobileMetricsService from "../services/mobile-metrics-service.js";
import * as mobilePurchasesService from "../services/mobile-purchases-service.js";
import * as mobileQuotationsService from "../services/mobile-quotations-service.js";
import * as mobileSalesReportService from "../services/mobile-sales-report-service.js";
import * as mobileSalesService from "../services/mobile-sales-service.js";
import * as mobileStockLedgerService from "../services/mobile-stock-ledger-service.js";
import * as mobileTransactionsService from "../services/mobile-transactions-service.js";
import { createShareLink } from "../services/share-service.js";

/** Read-only Owner App — see plan notes in schema.prisma's MobileLoginAttempt comment. Deliberately
 * NOT behind requireAuth (that's the Blue Ledger Account/JWT system) — this is a tenant Employee
 * logging in with the same credentials they already use on the DESKTOP POS. */
export const mobileRouter = Router();

/** A 6-digit PIN is only 1,000,000 combinations — this is the first credential-guessing surface in
 * SERVER exposed to the public internet (activation's license-key endpoints have no equivalent
 * throttle, but a license key is a full UUID, not a brute-forceable PIN). Generous enough not to
 * lock out a shop's shared wifi; the real per-account lockout is mobile-auth-service.ts's
 * MobileLoginAttempt counter, keyed by (tenant, employeeCode) rather than IP. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this network. Try again later." },
});

mobileRouter.post("/login", loginLimiter, async (req, res) => {
  const result = await mobileAuthService.loginMobile(req.body);
  res.json(result);
});

mobileRouter.get("/me", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.getMe(req.mobileSession!.tenantId, req.mobileSession!.employeeId);
  res.json(result);
});

mobileRouter.get("/dashboard", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileDashboardQuerySchema.parse(req.query);
  const result = await mobileMetricsService.getOwnerDashboard(req.mobileSession!.tenantId, parsed.period, parsed.timezoneOffsetMinutes);
  res.json(result);
});

mobileRouter.get("/employees", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.listEmployees(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/employees/:id/salaries", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileDirectoryService.getEmployeeSalaries(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.get("/locations", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSalesService.listLocations(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/sales", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileSalesService.listSales(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/sales/:id", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSalesService.getSale(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }
  res.json(result);
});

mobileRouter.get("/invoices", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileSalesService.listInvoices(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/customers", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileCustomersService.listCustomers(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/customers/:id/statement", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileCustomersService.getStatement(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(result);
});

mobileRouter.get("/quotations", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileQuotationsService.listQuotations(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/quotations/:id", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileQuotationsService.getQuotation(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Quotation not found" });
    return;
  }
  res.json(result);
});

mobileRouter.get("/transactions", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileTransactionsService.listTransactions(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/sales-report/overview", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = salesReportPeriodQuerySchema.parse(req.query);
  const result = await mobileSalesReportService.getSalesReportOverview(req.mobileSession!.tenantId, parsed);
  res.json(result);
});

mobileRouter.get("/sales-report/trend", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = salesReportPeriodQuerySchema.parse(req.query);
  const result = await mobileSalesReportService.getSalesTrend(req.mobileSession!.tenantId, parsed);
  res.json(result);
});

mobileRouter.get("/sales-report/breakdowns", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = salesReportPeriodQuerySchema.parse(req.query);
  const result = await mobileSalesReportService.getSalesBreakdowns(req.mobileSession!.tenantId, parsed);
  res.json(result);
});

mobileRouter.get("/sales-report/tax", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = salesReportPeriodQuerySchema.parse(req.query);
  const result = await mobileSalesReportService.getSalesTaxBreakdown(req.mobileSession!.tenantId, parsed);
  res.json(result);
});

mobileRouter.get("/products", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileInventoryService.listProducts(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/purchases", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobilePurchasesService.listPurchases(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/purchases/:id", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobilePurchasesService.getPurchase(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Purchase not found" });
    return;
  }
  res.json(result);
});

mobileRouter.get("/expenses", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileExpensesService.listExpenses(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

mobileRouter.get("/stock-ledger", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileStockLedgerService.listStockMovements(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

/** Same createShareLink DESKTOP's ShareModal calls (share-service.ts) — deviceId is a required field
 * on that schema only because requireDevice's own auth check needs it; createShareLink itself never
 * reads it, so a constant placeholder is fine here where requireMobileAuth is the real gate instead. */
mobileRouter.post("/share-links", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileShareLinkSchema.parse(req.body);
  const result = await createShareLink({
    tenantId: req.mobileSession!.tenantId,
    deviceId: "owner-app",
    entity: parsed.entity,
    entityId: parsed.entityId,
    includePreview: parsed.includePreview,
  });
  res.status(201).json(result);
});
