import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireMobileAuth, requireMobilePermission, requireOwnerAppAccess, requireSuperAdmin } from "../middleware/mobile-auth.js";
import {
  mobileBooleanValueSchema,
  mobileCancellationDecisionSchema,
  mobileDashboardQuerySchema,
  mobileMpesaStatusSchema,
  mobileQuotationStatusSchema,
  mobileSaleReturnRequestSchema,
  mobileRequestCancelSchema,
  mobileSalesQuerySchema,
  mobileShareLinkSchema,
  mobileStkPushSchema,
  salesReportPeriodQuerySchema,
} from "../schemas/mobile.js";
import * as mobileAuthService from "../services/mobile-auth-service.js";
import * as mobileCashUpService from "../services/mobile-cashup-service.js";
import * as mobileCheckoutService from "../services/mobile-checkout-service.js";
import * as mobileCustomersService from "../services/mobile-customers-service.js";
import * as mobileDirectoryService from "../services/mobile-directory-service.js";
import * as mobileEmployeesService from "../services/mobile-employees-service.js";
import * as mobileExpensesService from "../services/mobile-expenses-service.js";
import * as mobileInventoryService from "../services/mobile-inventory-service.js";
import * as mobileInvoicesService from "../services/mobile-invoices-service.js";
import * as mobileMetricsService from "../services/mobile-metrics-service.js";
import * as mobilePurchasesService from "../services/mobile-purchases-service.js";
import * as mobileProductsService from "../services/mobile-products-service.js";
import * as mobileQuotationsService from "../services/mobile-quotations-service.js";
import * as mobileRidersService from "../services/mobile-riders-service.js";
import * as mobileSalesReportService from "../services/mobile-sales-report-service.js";
import * as mobileSalesService from "../services/mobile-sales-service.js";
import * as mobileSettingsService from "../services/mobile-settings-service.js";
import * as mobileStockLedgerService from "../services/mobile-stock-ledger-service.js";
import * as mobileSuppliersService from "../services/mobile-suppliers-service.js";
import * as mobileTransactionsService from "../services/mobile-transactions-service.js";
import * as mobileWorkingHoursService from "../services/mobile-working-hours-service.js";
import * as mpesaService from "../services/mpesa-service.js";
import { createShareLink } from "../services/share-service.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { OWNER_APP_DEVICE_ID, resolveMobileLocation } from "../services/mobile-checkout-service.js";

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
    req.mobileSession!.employeeId,
  );
  res.json(result);
});

// employees.view on both directory reads — same grant APP's Employees tab already requires to be
// visible at all (navigation.ts); previously only the UI enforced it.
mobileRouter.get("/employees", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("employees", "view"), async (req, res) => {
  const result = await mobileDirectoryService.listEmployees(req.mobileSession!.tenantId);
  res.json(result);
});

/** Backs the Employees tab's role picker (Add employee / Edit access). Same employees.view gate the
 * tab itself needs — a role's bare name and Super Admin flag aren't sensitive beyond that. */
mobileRouter.get("/roles", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("employees", "view"), async (req, res) => {
  const result = await mobileEmployeesService.listRoles(req.mobileSession!.tenantId);
  res.json(result);
});

/** System-access management — see mobile-employees-service.ts's own doc comment for the guard rules
 * (branch scope, Super-Admin-only-by-Super-Admin, no self-lockout). Same employees.create/edit
 * actions DESKTOP's own employee-service.ts checks. */
mobileRouter.post("/employees", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("employees", "create"), async (req, res) => {
  const result = await mobileEmployeesService.createEmployee(req.mobileSession!, req.body);
  res.status(201).json(result);
});

mobileRouter.patch(
  "/employees/:id/access",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("employees", "edit"),
  async (req, res) => {
    const result = await mobileEmployeesService.updateEmployeeAccess(req.mobileSession!, req.params.id as string, req.body);
    res.json(result);
  },
);

/** Changing your OWN PIN needs no employees.edit grant (any employee can do that, same as on the
 * POS itself); resetting anyone else's does. */
mobileRouter.post(
  "/employees/:id/pin",
  requireMobileAuth,
  requireOwnerAppAccess,
  async (req, res, next) => {
    if (req.params.id === req.mobileSession!.employeeId) return next();
    return requireMobilePermission("employees", "edit")(req, res, next);
  },
  async (req, res) => {
    const result = await mobileEmployeesService.resetEmployeePin(req.mobileSession!, req.params.id as string, req.body);
    res.json(result);
  },
);

mobileRouter.get("/employees/:id/salaries", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("employees", "view"), async (req, res) => {
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

mobileRouter.get("/sales/:id/delivery-note", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSalesService.getSaleDeliveryNote(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Delivery note not found" });
    return;
  }
  res.json(result);
});

mobileRouter.post(
  "/sales/:id/include-tax-breakdown",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileSalesService.setSaleIncludeTaxBreakdown(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

mobileRouter.post(
  "/sales/:id/include-business-info",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileSalesService.setSaleIncludeBusinessInfo(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

mobileRouter.post(
  "/sales/:id/delivery/delivered",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileSalesService.setSaleDeliveryDelivered(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

mobileRouter.get("/sales/:id/returnable-items", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileSalesService.getSaleReturnableItems(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.post(
  "/sales/:id/request-return",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const parsed = mobileSaleReturnRequestSchema.parse(req.body);
    const result = await mobileSalesService.requestSaleReturn(req.mobileSession!.tenantId, req.mobileSession!.employeeId, req.params.id as string, parsed);
    res.status(201).json(result);
  },
);

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

// Customer debt — see mobile-customers-service.ts. Seeing balances needs customers.view; collecting
// a payment needs sales.edit, the same grant as recording a payment on a single invoice.
mobileRouter.get("/customers/balances", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("customers", "view"), async (req, res) => {
  const result = await mobileCustomersService.listCustomersWithBalances(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/customers/:id/debt", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("customers", "view"), async (req, res) => {
  const result = await mobileCustomersService.getCustomerDebt(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.post("/customers/:id/payments", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "edit"), async (req, res) => {
  const result = await mobileCustomersService.collectCustomerPayment(
    req.mobileSession!.tenantId,
    req.mobileSession!.employeeId,
    req.params.id as string,
    req.body,
  );
  res.json(result);
});

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

// Supplier balances — see mobile-suppliers-service.ts. Same suppliers.view / suppliers.edit grants
// DESKTOP's own supplier-balance-service.ts checks.
mobileRouter.get("/suppliers/balances", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("suppliers", "view"), async (req, res) => {
  const result = await mobileSuppliersService.listSuppliersWithBalances(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.get("/suppliers/:id/balance-entries", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("suppliers", "view"), async (req, res) => {
  const result = await mobileSuppliersService.listSupplierBalanceEntries(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.post("/suppliers/:id/balance-adjustments", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("suppliers", "edit"), async (req, res) => {
  const result = await mobileSuppliersService.adjustSupplierBalance(
    req.mobileSession!.tenantId,
    req.mobileSession!.employeeId,
    req.params.id as string,
    req.body,
  );
  res.status(201).json(result);
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

mobileRouter.get("/quotations/:id/delivery-note", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileQuotationsService.getQuotationDeliveryNote(req.mobileSession!.tenantId, req.params.id as string);
  if (!result) {
    res.status(404).json({ error: "Delivery note not found" });
    return;
  }
  res.json(result);
});

mobileRouter.post(
  "/quotations/:id/include-tax-breakdown",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileQuotationsService.setQuotationIncludeTaxBreakdown(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

mobileRouter.post(
  "/quotations/:id/include-business-info",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("quotations", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileQuotationsService.setQuotationIncludeBusinessInfo(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

// "sales":"edit" here on purpose, not "quotations":"edit" — mirrors DESKTOP's own
// setDeliveryNoteDelivered, which uses a single permission gate for a delivery regardless of whether
// it's attached to a sale or a quotation (delivery-note-service.ts).
mobileRouter.post(
  "/quotations/:id/delivery/delivered",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("sales", "edit"),
  async (req, res) => {
    const parsed = mobileBooleanValueSchema.parse(req.body);
    const result = await mobileQuotationsService.setQuotationDeliveryDelivered(req.mobileSession!.tenantId, req.params.id as string, parsed.value);
    res.json(result);
  },
);

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
  const result = await mobileTransactionsService.listTransactions(req.mobileSession!.tenantId, parsed.locationId ?? null, {
    employeeId: req.mobileSession!.employeeId,
    isSuperAdmin: req.mobileSession!.isSuperAdmin ?? false,
  });
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
  const result = await mobileInventoryService.listProducts(req.mobileSession!.tenantId, { includeAll: req.query.includeAll === "1" });
  res.json(result);
});

// Catalog + stock management — see mobile-products-service.ts. Same module/action pairs DESKTOP's
// own product-service.ts / category-service.ts / inventory-service.ts check.
mobileRouter.get("/categories", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileProductsService.listCategories(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.post("/categories", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("categories", "create"), async (req, res) => {
  const result = await mobileProductsService.createCategory(req.mobileSession!.tenantId, req.body);
  res.status(201).json(result);
});

mobileRouter.post("/products", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("products", "create"), async (req, res) => {
  const result = await mobileProductsService.createProduct(req.mobileSession!, req.body);
  res.status(201).json(result);
});

mobileRouter.get("/products/:id/edit", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("products", "edit"), async (req, res) => {
  const result = await mobileProductsService.getProductForEdit(req.mobileSession!.tenantId, req.params.id as string);
  res.json(result);
});

mobileRouter.put("/products/:id", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("products", "edit"), async (req, res) => {
  const result = await mobileProductsService.updateProduct(req.mobileSession!, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.post("/products/:id/status", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("products", "edit"), async (req, res) => {
  const result = await mobileProductsService.setProductStatus(req.mobileSession!.tenantId, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.post("/stock-adjustments", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("inventory", "edit"), async (req, res) => {
  const result = await mobileProductsService.recordStockAdjustment(req.mobileSession!, req.body);
  res.status(201).json(result);
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

// Purchase lifecycle — see mobile-purchases-service.ts's write-actions section. Same
// purchases.create / purchases.edit grants DESKTOP's own purchase-service.ts checks.
mobileRouter.post("/purchases", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("purchases", "create"), async (req, res) => {
  const result = await mobilePurchasesService.createPurchase(req.mobileSession!, req.body);
  res.status(201).json(result);
});

mobileRouter.post("/purchases/:id/order", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("purchases", "edit"), async (req, res) => {
  const result = await mobilePurchasesService.markPurchaseOrdered(req.mobileSession!, req.params.id as string);
  res.json(result);
});

mobileRouter.post("/purchases/:id/cancel", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("purchases", "edit"), async (req, res) => {
  const result = await mobilePurchasesService.cancelPurchase(req.mobileSession!, req.params.id as string);
  res.json(result);
});

mobileRouter.post("/purchases/:id/receive", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("purchases", "edit"), async (req, res) => {
  const result = await mobilePurchasesService.receivePurchaseGoods(req.mobileSession!, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.post("/purchases/:id/payments", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("purchases", "edit"), async (req, res) => {
  const result = await mobilePurchasesService.recordPurchasePayment(req.mobileSession!, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.get("/expenses", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const parsed = mobileSalesQuerySchema.parse(req.query);
  const result = await mobileExpensesService.listExpenses(req.mobileSession!.tenantId, parsed.locationId ?? null);
  res.json(result);
});

// Expense writes — see mobile-expenses-service.ts. Same expenses.create/edit/delete and
// expense_categories.create grants DESKTOP checks; "delete" is always an archive.
mobileRouter.get("/expense-categories", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const result = await mobileExpensesService.listExpenseCategories(req.mobileSession!.tenantId);
  res.json(result);
});

mobileRouter.post(
  "/expense-categories",
  requireMobileAuth,
  requireOwnerAppAccess,
  requireMobilePermission("expense_categories", "create"),
  async (req, res) => {
    const result = await mobileExpensesService.createExpenseCategory(req.mobileSession!.tenantId, req.body);
    res.status(201).json(result);
  },
);

mobileRouter.post("/expenses", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("expenses", "create"), async (req, res) => {
  const result = await mobileExpensesService.createExpense(req.mobileSession!, req.body);
  res.status(201).json(result);
});

mobileRouter.put("/expenses/:id", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("expenses", "edit"), async (req, res) => {
  const result = await mobileExpensesService.updateExpense(req.mobileSession!, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.post("/expenses/:id/archive", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("expenses", "delete"), async (req, res) => {
  const result = await mobileExpensesService.archiveExpense(req.mobileSession!, req.params.id as string);
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

// Settings — see mobile-settings-service.ts. Each section checks the same module DESKTOP's own screen
// does (business_profile / locations / payment_methods); reading needs any one of them.
mobileRouter.get("/settings", requireMobileAuth, requireOwnerAppAccess, async (req, res) => {
  const session = req.mobileSession!;
  const perms = session.permissions ?? {};
  const allowed = session.isSuperAdmin || ["business_profile", "locations", "payment_methods"].some((m) => (perms[m] ?? []).length > 0);
  if (!allowed) {
    res.status(403).json({ error: "Your account doesn't have access to settings — ask your Super Admin." });
    return;
  }
  const result = await mobileSettingsService.getSettings(session.tenantId);
  res.json(result);
});

mobileRouter.put("/settings/business-profile", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("business_profile", "edit"), async (req, res) => {
  const result = await mobileSettingsService.updateBusinessProfile(req.mobileSession!.tenantId, req.body);
  res.json(result);
});

mobileRouter.put("/settings/storefronts/:id", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("locations", "edit"), async (req, res) => {
  const result = await mobileSettingsService.updateStorefrontDetails(req.mobileSession!.tenantId, req.params.id as string, req.body);
  res.json(result);
});

mobileRouter.post("/settings/payment-methods", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("payment_methods", "create"), async (req, res) => {
  const result = await mobileSettingsService.createPaymentMethod(req.mobileSession!.tenantId, req.body);
  res.status(201).json(result);
});

mobileRouter.patch("/settings/payment-methods/:id", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("payment_methods", "edit"), async (req, res) => {
  const result = await mobileSettingsService.updatePaymentMethod(req.mobileSession!.tenantId, req.params.id as string, req.body);
  res.json(result);
});

// M-Pesa STK push from mobile Checkout — the exact same mpesa-service.ts functions DESKTOP's own
// /mpesa routes call (Till credentials never leave the server), with the tenant taken from the
// mobile session and deviceId "owner-app" recorded on the transaction. Gated by sales.create, the
// same grant as checkout itself. A branch-scoped cashier always pushes from their own storefront.
async function resolveStkLocation(tenantId: string, employeeId: string, requested: string | undefined): Promise<string> {
  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { branchId: true } });
    return resolveMobileLocation(tx, tenantId, employee.branchId, requested);
  });
}

mobileRouter.get("/mpesa/configured", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const session = req.mobileSession!;
  const requested = typeof req.query.locationId === "string" && req.query.locationId ? req.query.locationId : undefined;
  const locationId = await resolveStkLocation(session.tenantId, session.employeeId, requested);
  const result = await mpesaService.isMpesaConfigured({ tenantId: session.tenantId, deviceId: OWNER_APP_DEVICE_ID, locationId });
  res.json(result);
});

mobileRouter.post("/mpesa/stk-push", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const session = req.mobileSession!;
  const parsed = mobileStkPushSchema.parse(req.body);
  const locationId = await resolveStkLocation(session.tenantId, session.employeeId, parsed.locationId);
  const result = await mpesaService.requestStkPush({
    tenantId: session.tenantId,
    deviceId: OWNER_APP_DEVICE_ID,
    employeeId: session.employeeId,
    locationId,
    phone: parsed.phone,
    amountCents: parsed.amountCents,
  });
  res.status(201).json(result);
});

// Passive — polled while "waiting for the customer to enter their PIN". Never calls Safaricom.
mobileRouter.post("/mpesa/status", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const { checkoutRequestId } = mobileMpesaStatusSchema.parse(req.body);
  const result = await mpesaService.getMpesaStatus({ tenantId: req.mobileSession!.tenantId, deviceId: OWNER_APP_DEVICE_ID, checkoutRequestId });
  res.json(result);
});

// Manual "Check now" — actively re-queries Safaricom (throttled server-side), same as DESKTOP's.
mobileRouter.post("/mpesa/status/check", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const { checkoutRequestId } = mobileMpesaStatusSchema.parse(req.body);
  const result = await mpesaService.checkMpesaStatusManually({ tenantId: req.mobileSession!.tenantId, deviceId: OWNER_APP_DEVICE_ID, checkoutRequestId });
  res.json(result);
});

/** End-of-day cash-up (mobile-cashup-service.ts). Anyone who can sell (sales.create) gets THEIR OWN
 * cash-up; seeing everyone's, or another employee's, needs reports.view — the same grant the
 * dashboard's revenue figures need. A branch-scoped employee is always held to their own storefront. */
mobileRouter.get("/cash-up", requireMobileAuth, requireOwnerAppAccess, requireMobilePermission("sales", "create"), async (req, res) => {
  const session = req.mobileSession!;
  const canSeeAll = session.isSuperAdmin || (session.permissions?.["reports"] ?? []).includes("view");
  const { branchId } = await withTenantContext(session.tenantId, (tx) =>
    tx.employee.findUniqueOrThrow({ where: { id: session.employeeId }, select: { branchId: true } }),
  );
  const forcedEmployeeId = canSeeAll ? null : session.employeeId;
  const forcedLocationId = session.isSuperAdmin ? null : branchId;
  const result = await mobileCashUpService.getCashUp(session.tenantId, req.query, forcedEmployeeId, forcedLocationId);
  res.json(result);
});
