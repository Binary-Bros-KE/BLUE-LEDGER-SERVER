import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireMobileAuth, requireMobilePermission, requireOwnerAppAccess, requireSuperAdmin } from "../middleware/mobile-auth.js";
import {
  mobileCancellationDecisionSchema,
  mobileDashboardQuerySchema,
  mobileQuotationStatusSchema,
  mobileRequestCancelSchema,
  mobileSalesQuerySchema,
  mobileShareLinkSchema,
  salesReportPeriodQuerySchema,
} from "../schemas/mobile.js";
import * as mobileAuthService from "../services/mobile-auth-service.js";
import * as mobileCheckoutService from "../services/mobile-checkout-service.js";
import * as mobileCustomersService from "../services/mobile-customers-service.js";
import * as mobileDirectoryService from "../services/mobile-directory-service.js";
import * as mobileExpensesService from "../services/mobile-expenses-service.js";
import * as mobileInventoryService from "../services/mobile-inventory-service.js";
import * as mobileInvoicesService from "../services/mobile-invoices-service.js";
import * as mobileMetricsService from "../services/mobile-metrics-service.js";
import * as mobilePurchasesService from "../services/mobile-purchases-service.js";
import * as mobileQuotationsService from "../services/mobile-quotations-service.js";
import * as mobileRidersService from "../services/mobile-riders-service.js";
import * as mobileSalesReportService from "../services/mobile-sales-report-service.js";
import * as mobileSalesService from "../services/mobile-sales-service.js";
import * as mobileStockLedgerService from "../services/mobile-stock-ledger-service.js";
import * as mobileSuppliersService from "../services/mobile-suppliers-service.js";
import * as mobileTransactionsService from "../services/mobile-transactions-service.js";
import * as mobileWorkingHoursService from "../services/mobile-working-hours-service.js";
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
  const result = await mobileMetricsService.getOwnerDashboard(
    req.mobileSession!.tenantId,
    parsed.period,
    parsed.timezoneOffsetMinutes,
    parsed.locationId ?? null,
  );
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

mobileRouter.get("/storefronts", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSalesService.listActiveStorefronts(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/sales", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileSalesService.listSales(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

/** Real, from-scratch checkout — see mobile-checkout-service.ts's own doc comment for why this is a
 * dedicated endpoint rather than routed through the generic /sync/push pipeline. Gated by
 * "sales"/"create" specifically (beyond the base owner_app.view every mobile route already
 * requires) — the same permission DESKTOP's own completeSale() checks, so granting a role
 * mobile-checkout access is just the normal Roles & Permissions screen, nothing mobile-specific to
 * configure. */
mobileRouter.post("/sales", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const result = await mobileCheckoutService.checkout(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.body);
  res.status(201).json(result);
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

mobileRouter.post(
  "/invoices",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "create"),
  async (req, res) => {
    const result = await mobileInvoicesService.createInvoice(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.get("/invoices/:id/edit", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileInvoicesService.getInvoiceEditData(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.put(
  "/invoices/:id",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const result = await mobileInvoicesService.updateInvoice(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, req.body);
    res.json(result);
  },
);

mobileRouter.post(
  "/invoices/:id/payments",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const result = await mobileInvoicesService.recordPayment(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.post(
  "/invoices/:id/mark-paid",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const result = await mobileInvoicesService.markPaid(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.post(
  "/invoices/:id/duplicate",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "create"),
  async (req, res) => {
    const result = await mobileInvoicesService.duplicateInvoice(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string);
    res.status(201).json(result);
  },
);

// Self-approved direct cancel — same "approvals":"approve" gate DESKTOP's own cancelInvoiceDirect
// requires (not "sales":"edit"); a plain Cashier won't have this by default. See the async
// request/approve/reject routes below for the lower-permission-staff workflow.
mobileRouter.post(
  "/invoices/:id/cancel",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("approvals", "approve"),
  async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const result = await mobileInvoicesService.cancelInvoice(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, reason);
    res.json(result);
  },
);

// A cashier's request to cancel an invoice — gated by "sales":"edit" (the permission a normal
// Cashier already has), not "approvals":"approve". Mirrors DESKTOP's own requestInvoiceCancel route.
mobileRouter.post(
  "/invoices/:id/request-cancel",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const { reason, notes } = mobileRequestCancelSchema.parse(req.body);
    const result = await mobileInvoicesService.requestInvoiceCancel(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, reason, notes);
    res.status(201).json(result);
  },
);

// Approvals inbox — every invoice-cancellation request still awaiting a decision, tenant-wide.
mobileRouter.get(
  "/approvals/invoice-cancellations",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("approvals", "approve"),
  async (req, res) => {
    const result = await mobileInvoicesService.listPendingInvoiceCancellations(req.mobileSession!.tenantId);
    res.json(result);
  },
);

mobileRouter.post(
  "/approvals/invoice-cancellations/:id/approve",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("approvals", "approve"),
  async (req, res) => {
    const { notes } = mobileCancellationDecisionSchema.parse(req.body);
    const result = await mobileInvoicesService.approveInvoiceCancel(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, notes);
    res.json(result);
  },
);

mobileRouter.post(
  "/approvals/invoice-cancellations/:id/reject",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("approvals", "approve"),
  async (req, res) => {
    const { notes } = mobileCancellationDecisionSchema.parse(req.body);
    const result = await mobileInvoicesService.rejectInvoiceCancel(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, notes);
    res.json(result);
  },
);

mobileRouter.get("/customers", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileCustomersService.listCustomers(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.post(
  "/customers",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("customers", "create"),
  async (req, res) => {
    const result = await mobileCustomersService.createCustomer(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.get("/riders", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileRidersService.listRiders(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.post(
  "/riders",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("riders", "create"),
  async (req, res) => {
    const result = await mobileRidersService.createRider(req.mobileSession!.tenantId, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.get("/suppliers", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSuppliersService.listSuppliers(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.post(
  "/suppliers",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("suppliers", "create"),
  async (req, res) => {
    const result = await mobileSuppliersService.createSupplier(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.body);
    res.status(201).json(result);
  },
);

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

mobileRouter.post(
  "/quotations",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "create"),
  async (req, res) => {
    const result = await mobileQuotationsService.createQuotation(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.get("/quotations/:id/edit", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileQuotationsService.getQuotationEditData(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.put(
  "/quotations/:id",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "edit"),
  async (req, res) => {
    const result = await mobileQuotationsService.updateQuotation(req.mobileSession!.tenantId, req.params.id as string, req.body);
    res.json(result);
  },
);

mobileRouter.delete(
  "/quotations/:id",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "delete"),
  async (req, res) => {
    const result = await mobileQuotationsService.deleteQuotation(req.mobileSession!.tenantId, req.params.id as string);
    res.json(result);
  },
);

mobileRouter.post(
  "/quotations/:id/status",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "edit"),
  async (req, res) => {
    const parsed = mobileQuotationStatusSchema.parse(req.body);
    const result = await mobileQuotationsService.setQuotationStatus(req.mobileSession!.tenantId, req.params.id as string, parsed.status);
    res.json(result);
  },
);

mobileRouter.get("/quotations/:id/stock-check", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileQuotationsService.checkQuotationStock(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.post(
  "/quotations/:id/convert-to-sale",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "create"),
  async (req, res) => {
    const result = await mobileQuotationsService.convertQuotationToSale(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.post(
  "/quotations/:id/convert-to-invoice",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "create"),
  async (req, res) => {
    const result = await mobileQuotationsService.convertQuotationToInvoice(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, req.body);
    res.status(201).json(result);
  },
);

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

mobileRouter.get("/payment-methods", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileCheckoutService.listPaymentMethods(req.mobileSession!.tenantId);
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

// --- Working Hours lockout (Super Admin only — see requireSuperAdmin's own doc comment for why
// this is a hardcoded flag check rather than a normal module/action permission). ---

mobileRouter.get("/working-hours", requireMobileAuth, requireOwnerAppAccess, requireSuperAdmin, async (req, res) => {
  const result = await mobileWorkingHoursService.listWorkingHours(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/working-hours/:locationId", requireMobileAuth, requireOwnerAppAccess, requireSuperAdmin, async (req, res) => {
  const result = await mobileWorkingHoursService.getWorkingHours(req.mobileSession!.tenantId, req.params.locationId as string);
  res.json(result);
});

mobileRouter.put("/working-hours/:locationId", requireMobileAuth, requireOwnerAppAccess, requireSuperAdmin, async (req, res) => {
  const result = await mobileWorkingHoursService.upsertWorkingHours(req.mobileSession!.tenantId, req.params.locationId as string, req.body);
  res.json(result);
});

mobileRouter.post(
  "/working-hours/:locationId/toggle-manual-lock",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireSuperAdmin,
  async (req, res) => {
    const result = await mobileWorkingHoursService.toggleManualLock(req.mobileSession!.tenantId, req.params.locationId as string, req.body);
    res.json(result);
  },
);
