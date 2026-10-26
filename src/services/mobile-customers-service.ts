import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { type MobileCreateCustomerInput, mobileCollectCustomerPaymentSchema, mobileCreateCustomerSchema } from "../schemas/mobile.js";
import { applyPayment } from "./mobile-invoices-service.js";
import { buildSharedStatement, type SharedStatementResult } from "./share-service.js";

/** Same synthetic deviceId used by every other Owner-App-originated write — see
 * mobile-checkout-service.ts's own doc comment for why. */
const OWNER_APP_DEVICE_ID = "owner-app";

/** Matches DESKTOP's own customer-service.ts prefix exactly ("CUST", 5 digits). */
const CUSTOMER_CODE_PREFIX = "CUST";
const CUSTOMER_CODE_DIGITS = 5;

export type MobileCustomer = { id: string; name: string; phone: string; customerCode: string };

/** The Customers tab's list item — MobileCustomer plus what they currently owe. */
export type MobileCustomerWithBalance = MobileCustomer & { balanceDueCents: number; unpaidInvoiceCount: number };

const CUSTOMER_SELECT = { id: true, name: true, phone: true, customerCode: true } as const;

/** Backs the Owner App's "Generate Statement" customer picker AND the Checkout customer picker AND
 * the Customers tab — one list, same shape, reused everywhere a mobile screen needs "which customer
 * is this" (same convention DESKTOP's own customer.list() IPC handler serves every one of its own
 * equivalent pickers from). */
export async function listCustomers(tenantId: string): Promise<MobileCustomer[]> {
  return withTenantContext(tenantId, async (tx) =>
    tx.customer.findMany({
      where: { tenantId, status: "active" },
      select: CUSTOMER_SELECT,
      orderBy: { name: "asc" },
    }),
  );
}

/** The fast path for adding a customer mid-checkout — mirrors DESKTOP's own createCustomer
 * (customer-service.ts): name + phone only, customerType hardcoded to "retail", customerCode
 * auto-minted. Unlike DESKTOP, doesn't enforce phone uniqueness per tenant — mobile has no edit UI
 * to fix a rejected duplicate on the spot, and a duplicate phone is a soft data-quality issue a
 * Super Admin can merge later from DESKTOP, not something worth blocking a cashier's sale over. */
export async function createCustomer(tenantId: string, employeeId: string, input: unknown): Promise<MobileCustomer> {
  const parsed: MobileCreateCustomerInput = mobileCreateCustomerSchema.parse(input);
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const mobileDeviceSequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
    const customerCode = await mintMobileDocumentNumber(tx, tenantId, mobileDeviceSequence, CUSTOMER_CODE_PREFIX, CUSTOMER_CODE_DIGITS);

    return tx.customer.create({
      data: {
        id: `customer_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        customerCode,
        customerType: "retail",
        name: parsed.name,
        phone: parsed.phone,
        status: "active",
        locationId: employee.branchId,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: CUSTOMER_SELECT,
    });
  });
}

/** The owner viewing their own tenant's own customer's statement — a plain authenticated read via
 * the exact same view-model the Share feature renders (buildSharedStatement), not a public-token
 * lookup, same reasoning as mobile-sales-service.ts's getSale. */
export async function getStatement(tenantId: string, customerId: string): Promise<SharedStatementResult | null> {
  return buildSharedStatement(tenantId, customerId);
}

// ---------------------------------------------------------------------------------------------
// Customer debt — what a customer owes is the unpaid balance across their invoices (DESKTOP has no
// separate account balance), computed exactly like DESKTOP's own customer-repository.ts
// reconcileAllCustomerBalances / report-repository.ts findOutstandingDebtors: completed invoices
// not paid/cancelled and not voided, each one's total − paid − approved returns, floored at 0.
// Collecting a payment applies it oldest invoice first, each slice recorded as an ordinary invoice
// payment through mobile-invoices-service.ts's applyPayment — so DESKTOP sees nothing but normal
// invoice payments, no new data shape to sync.
// ---------------------------------------------------------------------------------------------

export type MobileOutstandingInvoice = {
  id: string;
  invoiceNumber: string;
  issuedAt: string;
  dueDate: string | null;
  grandTotalCents: number;
  amountPaidCents: number;
  /** total − paid − approved returns, never below 0 — what's actually still owed on it. */
  outstandingCents: number;
  paymentStatus: string;
};

export type MobileCustomerDebt = {
  customerId: string;
  customerName: string;
  totalDueCents: number;
  invoices: MobileOutstandingInvoice[];
};

/** Every invoice still owing something, oldest first. Optionally scoped to one customer. */
async function findOutstandingInvoices(tx: Prisma.TransactionClient, tenantId: string, customerId?: string) {
  const sales = await tx.sale.findMany({
    where: {
      tenantId,
      ...(customerId ? { customerId } : { customerId: { not: null } }),
      saleStatus: "completed",
      invoiceNumber: { not: null },
      paymentStatus: { notIn: ["paid", "cancelled"] },
    },
    orderBy: { localCreatedAt: "asc" },
  });
  if (sales.length === 0) return [];

  const saleIds = sales.map((s) => s.id);
  const [voids, returns] = await Promise.all([
    tx.saleVoid.findMany({ where: { tenantId, status: "approved", saleId: { in: saleIds } }, select: { saleId: true } }),
    tx.saleReturn.findMany({ where: { tenantId, status: "approved", saleId: { in: saleIds } }, select: { saleId: true, items: true } }),
  ]);
  const voided = new Set(voids.map((v) => v.saleId));
  const returnedBySale = new Map<string, number>();
  for (const r of returns) {
    const items = Array.isArray(r.items) ? (r.items as Array<{ lineTotalCents?: number }>) : [];
    const value = items.reduce((sum, item) => sum + (item.lineTotalCents ?? 0), 0);
    returnedBySale.set(r.saleId, (returnedBySale.get(r.saleId) ?? 0) + value);
  }

  return sales
    .filter((s) => !voided.has(s.id))
    .map((s) => ({
      sale: s,
      outstandingCents: Math.max(0, s.grandTotalCents - s.amountPaidCents - (returnedBySale.get(s.id) ?? 0)),
    }))
    .filter((entry) => entry.outstandingCents > 0);
}

/** Customers tab list — every active customer with what they owe, debtors first. */
export async function listCustomersWithBalances(tenantId: string): Promise<MobileCustomerWithBalance[]> {
  return withTenantContext(tenantId, async (tx) => {
    const [customers, outstanding] = await Promise.all([
      tx.customer.findMany({ where: { tenantId, status: "active" }, select: CUSTOMER_SELECT, orderBy: { name: "asc" } }),
      findOutstandingInvoices(tx, tenantId),
    ]);
    const dueByCustomer = new Map<string, { cents: number; count: number }>();
    for (const { sale, outstandingCents } of outstanding) {
      const current = dueByCustomer.get(sale.customerId as string) ?? { cents: 0, count: 0 };
      dueByCustomer.set(sale.customerId as string, { cents: current.cents + outstandingCents, count: current.count + 1 });
    }
    return customers
      .map((c) => ({ ...c, balanceDueCents: dueByCustomer.get(c.id)?.cents ?? 0, unpaidInvoiceCount: dueByCustomer.get(c.id)?.count ?? 0 }))
      .sort((a, b) => b.balanceDueCents - a.balanceDueCents || a.name.localeCompare(b.name));
  });
}

async function loadCustomerDebt(tx: Prisma.TransactionClient, tenantId: string, customerId: string): Promise<MobileCustomerDebt> {
  const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, tenantId: true, name: true } });
  if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");
  const outstanding = await findOutstandingInvoices(tx, tenantId, customerId);
  return {
    customerId: customer.id,
    customerName: customer.name,
    totalDueCents: outstanding.reduce((sum, e) => sum + e.outstandingCents, 0),
    invoices: outstanding.map(({ sale, outstandingCents }) => ({
      id: sale.id,
      invoiceNumber: sale.invoiceNumber as string,
      issuedAt: sale.localCreatedAt.toISOString(),
      dueDate: sale.dueDate,
      grandTotalCents: sale.grandTotalCents,
      amountPaidCents: sale.amountPaidCents,
      outstandingCents,
      paymentStatus: sale.paymentStatus,
    })),
  };
}

export async function getCustomerDebt(tenantId: string, customerId: string): Promise<MobileCustomerDebt> {
  return withTenantContext(tenantId, (tx) => loadCustomerDebt(tx, tenantId, customerId));
}

export type MobileCollectPaymentResult = {
  /** One entry per invoice this payment was applied to, oldest first. */
  allocations: Array<{ saleId: string; invoiceNumber: string; amountCents: number }>;
  remainingDueCents: number;
};

/**
 * Applies one payment from a customer across their outstanding invoices, oldest first — the
 * mobile counterpart of a cashier walking through DESKTOP's Invoices screen recording a payment on
 * each one in turn. Never more than what's owed. Idempotent on the client-minted `id`: each slice
 * is stored as invoice payment "<id>_<n>", and a retry that finds any of them already on record
 * returns the earlier result instead of charging the customer twice.
 */
export async function collectCustomerPayment(tenantId: string, employeeId: string, customerId: string, input: unknown): Promise<MobileCollectPaymentResult> {
  const parsed = mobileCollectCustomerPaymentSchema.parse(input);
  const paymentKey = parsed.id.startsWith("payment_") ? parsed.id : `payment_${parsed.id}`;

  return withTenantContext(tenantId, async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { tenantId: true } });
    if (!customer || customer.tenantId !== tenantId) throw new NotFoundError("Customer not found");

    // Retry check: any invoice of this customer already carrying a slice of this payment?
    const invoices = await tx.sale.findMany({ where: { tenantId, customerId, invoiceNumber: { not: null } }, select: { id: true, invoiceNumber: true, payments: true } });
    const earlier: MobileCollectPaymentResult["allocations"] = [];
    for (const inv of invoices) {
      const entries = Array.isArray(inv.payments) ? (inv.payments as Array<{ id?: string; amountCents?: number }>) : [];
      for (const p of entries) {
        if (p.id?.startsWith(`${paymentKey}_`)) earlier.push({ saleId: inv.id, invoiceNumber: inv.invoiceNumber as string, amountCents: p.amountCents ?? 0 });
      }
    }
    if (earlier.length > 0) {
      const debt = await loadCustomerDebt(tx, tenantId, customerId);
      return { allocations: earlier, remainingDueCents: debt.totalDueCents };
    }

    const debt = await loadCustomerDebt(tx, tenantId, customerId);
    if (debt.totalDueCents <= 0) throw new HttpError(400, "This customer doesn't owe anything right now");
    if (parsed.amountCents > debt.totalDueCents) {
      throw new HttpError(400, `That's more than the ${(debt.totalDueCents / 100).toFixed(2)} this customer owes`);
    }

    let remaining = parsed.amountCents;
    const allocations: MobileCollectPaymentResult["allocations"] = [];
    for (const invoice of debt.invoices) {
      if (remaining <= 0) break;
      const slice = Math.min(remaining, invoice.outstandingCents);
      await applyPayment(tx, tenantId, employeeId, invoice.id, {
        id: `${paymentKey}_${allocations.length + 1}`,
        paymentMethodId: parsed.paymentMethodId,
        amountCents: slice,
        reference: parsed.reference,
        notes: parsed.notes,
      });
      allocations.push({ saleId: invoice.id, invoiceNumber: invoice.invoiceNumber, amountCents: slice });
      remaining -= slice;
    }
    return { allocations, remainingDueCents: debt.totalDueCents - parsed.amountCents };
  });
}
