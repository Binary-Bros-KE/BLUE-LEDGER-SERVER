import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";

export type MobileTransactionDirection = "in" | "out";
export type MobileTransactionSourceType = "sale" | "purchase" | "expense" | "salary";
export type MobileTransactionPartyLabel = "Customer" | "Supplier" | "Employee" | "For";

export type MobileTransactionRow = {
  id: string;
  transactionCode: string;
  occurredAt: string;
  locationName: string;
  paymentMethodName: string | null;
  processedByName: string;
  partyName: string | null;
  partyLabel: MobileTransactionPartyLabel;
  sourceType: MobileTransactionSourceType;
  direction: MobileTransactionDirection;
  amountCents: number;
  status: "complete" | "failed";
  currency: string;
};

type RawSalePayment = {
  id: string;
  paymentMethodName: string;
  reference: string | null;
  receivedByName: string;
  receivedAt: string;
  amountCents: number;
};

type RawPurchasePayment = {
  id: string;
  paymentMethodName: string;
  reference: string | null;
  paidByName: string;
  paidAt: string;
  amountCents: number;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Every actual money-movement event across the whole business, not just sales — money IN (sales/
 * invoice payments) and money OUT (purchase payments, expenses, salary payouts), each flagged with
 * a `direction`. Ports DESKTOP's own getPaymentTransactions (report-service.ts), widened the same
 * way. No per-category permission gating here (unlike DESKTOP, which gates each OUT category on its
 * own "purchases"/"expenses"/"salaries" view permission for Cashier-safety) — the whole Owner App is
 * already Super-Admin-only, so there's no narrower audience to protect this from.
 *
 * Scans the 300 most recent qualifying rows PER SOURCE (not 200 final rows, since one invoice/
 * purchase can expand into several payment rows) — same recency-cap philosophy as
 * listSales/listInvoices, not real pagination.
 */
export async function listTransactions(tenantId: string, locationId: string | null): Promise<MobileTransactionRow[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });
  const currency = tenant.currency;

  return withTenantContext(tenantId, async (tx) => {
    const [locations, employees, paymentMethods] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.employee.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true, branchId: true } }),
      tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const employeeBranchById = new Map(employees.map((e) => [e.id, e.branchId]));
    const paymentMethodNameById = new Map(paymentMethods.map((p) => [p.id, p.name]));

    const rows: MobileTransactionRow[] = [];

    // Money IN — sales/invoice payments.
    const sales = await tx.sale.findMany({
      where: {
        tenantId,
        saleStatus: "completed",
        transactionType: { in: ["retail_sale", "wholesale_sale", "invoice"] },
        OR: [{ invoiceNumber: null }, { amountPaidCents: { gt: 0 } }],
        ...(locationId ? { locationId } : {}),
      },
      orderBy: { completedAt: "desc" },
      take: 300,
    });
    const [voids, customers] = await Promise.all([
      tx.saleVoid.findMany({ where: { tenantId, saleId: { in: sales.map((s) => s.id) }, status: "approved" }, select: { saleId: true } }),
      tx.customer.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const voidedSaleIds = new Set(voids.map((v) => v.saleId));
    const customerNameById = new Map(customers.map((c) => [c.id, c.name]));

    for (const sale of sales) {
      const status: "complete" | "failed" = sale.paymentStatus === "cancelled" || voidedSaleIds.has(sale.id) ? "failed" : "complete";
      const locationName = locationNameById.get(sale.locationId) ?? "—";
      const partyName = (sale.customerId ? customerNameById.get(sale.customerId) : null) ?? "Walk-in customer";

      if (sale.invoiceNumber !== null) {
        for (const payment of asArray<RawSalePayment>(sale.payments)) {
          rows.push({
            id: `${sale.id}:${payment.id}`,
            transactionCode: payment.reference ?? sale.invoiceNumber,
            occurredAt: payment.receivedAt,
            locationName,
            paymentMethodName: payment.paymentMethodName,
            processedByName: payment.receivedByName,
            partyName,
            partyLabel: "Customer",
            sourceType: "sale",
            direction: "in",
            amountCents: payment.amountCents,
            status,
            currency,
          });
        }
      } else {
        rows.push({
          id: sale.id,
          transactionCode: sale.paymentReference ?? sale.receiptNumber ?? sale.id,
          occurredAt: (sale.completedAt ?? sale.localCreatedAt).toISOString(),
          locationName,
          paymentMethodName: sale.paymentMethodId ? (paymentMethodNameById.get(sale.paymentMethodId) ?? null) : null,
          processedByName: employeeNameById.get(sale.employeeId) ?? "—",
          partyName,
          partyLabel: "Customer",
          sourceType: "sale",
          direction: "in",
          amountCents: sale.grandTotalCents,
          status,
          currency,
        });
      }
    }

    // Money OUT — purchase payments.
    const purchases = await tx.purchase.findMany({
      where: { tenantId, status: { not: "cancelled" }, amountPaidCents: { gt: 0 }, ...(locationId ? { locationId } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 300,
    });
    const supplierIds = [...new Set(purchases.map((p) => p.supplierId))];
    const suppliers = await tx.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, businessName: true } });
    const supplierNameById = new Map(suppliers.map((s) => [s.id, s.businessName]));

    for (const purchase of purchases) {
      const locationName = locationNameById.get(purchase.locationId) ?? "—";
      const supplierName = supplierNameById.get(purchase.supplierId) ?? "—";
      for (const payment of asArray<RawPurchasePayment>(purchase.payments)) {
        rows.push({
          id: `${purchase.id}:${payment.id}`,
          transactionCode: payment.reference ?? purchase.purchaseNumber,
          occurredAt: payment.paidAt,
          locationName,
          paymentMethodName: payment.paymentMethodName,
          processedByName: payment.paidByName,
          partyName: supplierName,
          partyLabel: "Supplier",
          sourceType: "purchase",
          direction: "out",
          amountCents: payment.amountCents,
          status: "complete",
          currency,
        });
      }
    }

    // Money OUT — expenses (single flat payment each, unlike Sale/Purchase).
    const expenses = await tx.expense.findMany({
      where: {
        tenantId,
        status: "active",
        ...(locationId ? { OR: [{ storefrontId: locationId }, { storefrontId: null }] } : {}),
      },
      orderBy: { expenseDate: "desc" },
      take: 300,
    });
    const categoryIds = [...new Set(expenses.map((e) => e.categoryId))];
    const categories = await tx.expenseCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } });
    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

    for (const expense of expenses) {
      const description = expense.description?.trim();
      rows.push({
        id: expense.id,
        transactionCode: expense.reference ?? expense.expenseNumber,
        occurredAt: expense.expenseDate,
        locationName: expense.storefrontId ? (locationNameById.get(expense.storefrontId) ?? "—") : "General",
        paymentMethodName: paymentMethodNameById.get(expense.paymentMethodId) ?? null,
        // Expense.createdBy isn't synced to Postgres (a deliberate Phase-1 gap — see the model's own
        // schema comment) — DESKTOP can show who recorded it locally, the Owner App can't.
        processedByName: "—",
        partyName: description || (categoryNameById.get(expense.categoryId) ?? null),
        partyLabel: "For",
        sourceType: "expense",
        direction: "out",
        amountCents: expense.amountCents,
        status: "complete",
        currency,
      });
    }

    // Money OUT — salary payouts (single flat payment each). Branch scoping is only approximate,
    // via the PAID employee's own assigned branch — salaries have no location column of their own,
    // same convention DESKTOP's own report-repository.ts uses.
    const salaries = await tx.salary.findMany({
      where: { tenantId, status: { in: ["active", "voided"] } },
      orderBy: { localCreatedAt: "desc" },
      take: 300,
    });
    for (const salary of salaries) {
      const employeeBranchId = employeeBranchById.get(salary.employeeId) ?? null;
      if (locationId && employeeBranchId !== locationId) continue;
      rows.push({
        id: salary.id,
        transactionCode: salary.paymentReference ?? salary.payslipNumber,
        occurredAt: salary.localCreatedAt.toISOString(),
        locationName: employeeBranchId ? (locationNameById.get(employeeBranchId) ?? "Unassigned") : "Unassigned",
        paymentMethodName: salary.paymentMethodId ? (paymentMethodNameById.get(salary.paymentMethodId) ?? null) : null,
        processedByName: "Payroll",
        partyName: employeeNameById.get(salary.employeeId) ?? "—",
        partyLabel: "Employee",
        sourceType: "salary",
        direction: "out",
        amountCents: salary.netPayCents,
        status: salary.status === "voided" ? "failed" : "complete",
        currency,
      });
    }

    return rows.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()).slice(0, 200);
  });
}
