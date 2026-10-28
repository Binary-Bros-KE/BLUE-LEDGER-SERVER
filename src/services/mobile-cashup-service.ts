import { NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { mobileCashUpQuerySchema } from "../schemas/mobile.js";

/**
 * End-of-day cash-up — what came in at a storefront on one day, by payment method, and how much cash
 * should be in the drawer. New with the Owner App (DESKTOP has no equivalent screen); built from the
 * same rows and the same cash-recognition rules as mobile-metrics-service.ts's computeSalesAndProfit,
 * so its figures agree with the dashboard for the same day:
 *  - counter sales (no invoice number) count by completedAt — split-aware: a sale paid with several
 *    methods is spread across them using its own payments list;
 *  - invoice money counts by each payment's own receivedAt (so money collected today on an old
 *    invoice is in today's drawer), credited to whoever actually RECEIVED it (payment.receivedBy) —
 *    for a cashier's own cash-up, that's what matters, not who wrote the invoice;
 *  - voided sales never count; approved returns (by approvedAt) are money handed back;
 *  - cash expenses dated that day at that storefront are money paid out of the till.
 * "Cash" is the tenant's CASH-coded payment method (DESKTOP's own seeded code).
 */

const CASH_CODE = "CASH";

type SalePaymentEntry = { paymentMethodId?: string; paymentMethodName?: string; amountCents: number; receivedAt?: string; receivedBy?: string };
type ReturnItemEntry = { lineTotalCents?: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export type CashUpMethodLine = { paymentMethodId: string; name: string; isCash: boolean; amountCents: number; count: number };
export type CashUpCashierLine = { employeeId: string; name: string; amountCents: number; salesCount: number };

export type MobileCashUp = {
  date: string;
  locationId: string | null;
  locationName: string | null;
  /** Null = every employee; set = just that one (a cashier's own cash-up). */
  employeeId: string | null;
  currency: string;
  byMethod: CashUpMethodLine[];
  totalCollectedCents: number;
  /** Completed, non-voided counter sales + invoices with money received that day. */
  salesCount: number;
  voidedCount: number;
  refundsCents: number;
  cashExpensesCents: number;
  /** Cash collected − refunds − cash paid out for expenses. Refunds are assumed paid in cash (the
   * only way to hand money back over a counter); the screen says so. */
  expectedCashCents: number;
  /** Per cashier — only when not already scoped to one employee. */
  byCashier: CashUpCashierLine[] | null;
};

export async function getCashUp(tenantId: string, query: unknown, forcedEmployeeId: string | null, forcedLocationId: string | null): Promise<MobileCashUp> {
  const parsed = mobileCashUpQuerySchema.parse(query);
  const employeeId = forcedEmployeeId ?? parsed.employeeId ?? null;
  const locationId = forcedLocationId ?? parsed.locationId ?? null;

  // The phone's own calendar day, as UTC instants: local midnight = UTC midnight + offset minutes
  // (JS getTimezoneOffset convention — Nairobi is -180).
  const start = new Date(Date.parse(`${parsed.date}T00:00:00.000Z`) + parsed.timezoneOffsetMinutes * 60_000);
  const endExclusive = new Date(start.getTime() + 86_400_000);
  const startIso = start.toISOString();
  const endIso = endExclusive.toISOString();

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const locationWhere = locationId ? { locationId } : {};
    const [location, methods, employees, voids, counterSales, invoices, returns, expenses] = await Promise.all([
      locationId ? tx.location.findUnique({ where: { id: locationId }, select: { tenantId: true, locationName: true } }) : Promise.resolve(null),
      tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true, code: true } }),
      tx.employee.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
      tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
      tx.sale.findMany({
        where: {
          tenantId,
          ...locationWhere,
          ...(employeeId ? { employeeId } : {}),
          saleStatus: "completed",
          invoiceNumber: null,
          completedAt: { gte: start, lt: endExclusive },
        },
        select: { id: true, employeeId: true, grandTotalCents: true, paymentMethodId: true, payments: true },
      }),
      // Any invoice that could hold a payment received today — narrowed per payment below. One
      // cashier's own till counts every payment THEY received, whichever storefront the invoice
      // belongs to (the money is in their drawer); the storefront filter applies to "everyone" views.
      tx.sale.findMany({
        where: {
          tenantId,
          ...(employeeId ? {} : locationWhere),
          saleStatus: "completed",
          invoiceNumber: { not: null },
          paymentStatus: { not: "cancelled" },
          amountPaidCents: { gt: 0 },
          // An invoice missing completedAt (created on the phone before that was set) still counts.
          OR: [{ completedAt: { lt: endExclusive } }, { completedAt: null }],
        },
        select: { id: true, payments: true },
      }),
      tx.saleReturn.findMany({ where: { tenantId, status: "approved", approvedAt: { gte: start, lt: endExclusive } }, select: { saleId: true, items: true } }),
      tx.expense.findMany({
        where: { tenantId, status: "active", expenseDate: parsed.date, ...(locationId ? { storefrontId: locationId } : {}) },
        select: { amountCents: true, paymentMethodId: true },
      }),
    ]);
    if (locationId && (!location || location.tenantId !== tenantId)) throw new NotFoundError("Storefront not found");

    const methodById = new Map(methods.map((m) => [m.id, m]));
    const employeeName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const voided = new Set(voids.map((v) => v.saleId));
    const lines = new Map<string, CashUpMethodLine>();
    const cashiers = new Map<string, CashUpCashierLine>();

    const credit = (methodId: string | null | undefined, fallbackName: string | undefined, cents: number, cashierId: string | null | undefined, countsAsSale: boolean) => {
      const id = methodId ?? "other";
      const method = methodById.get(id);
      // One line per method NAME — several desktops can each have seeded their own "Cash" (same
      // reason as mobile-metrics-service.ts's addToBucket).
      const name = method?.name ?? fallbackName ?? "Other";
      const key = name.trim().toLowerCase();
      const line = lines.get(key) ?? { paymentMethodId: id, name, isCash: false, amountCents: 0, count: 0 };
      line.isCash = line.isCash || method?.code === CASH_CODE;
      line.amountCents += cents;
      line.count += 1;
      lines.set(key, line);
      if (cashierId) {
        const c = cashiers.get(cashierId) ?? { employeeId: cashierId, name: employeeName.get(cashierId) ?? "Unknown", amountCents: 0, salesCount: 0 };
        c.amountCents += cents;
        if (countsAsSale) c.salesCount += 1;
        cashiers.set(cashierId, c);
      }
    };

    let salesCount = 0;
    let voidedCount = 0;
    for (const sale of counterSales) {
      if (voided.has(sale.id)) {
        voidedCount += 1;
        continue;
      }
      salesCount += 1;
      const split = asArray<SalePaymentEntry>(sale.payments);
      if (split.length > 0) {
        split.forEach((p, i) => credit(p.paymentMethodId, p.paymentMethodName, p.amountCents, sale.employeeId, i === 0));
      } else {
        credit(sale.paymentMethodId, undefined, sale.grandTotalCents, sale.employeeId, true);
      }
    }

    for (const invoice of invoices) {
      if (voided.has(invoice.id)) continue;
      let countedThisInvoice = false;
      for (const p of asArray<SalePaymentEntry>(invoice.payments)) {
        if (!p.receivedAt || p.receivedAt < startIso || p.receivedAt >= endIso) continue;
        if (employeeId && p.receivedBy !== employeeId) continue;
        credit(p.paymentMethodId, p.paymentMethodName, p.amountCents, p.receivedBy, !countedThisInvoice);
        if (!countedThisInvoice) salesCount += 1;
        countedThisInvoice = true;
      }
    }

    // Returns carry only a saleId — keep the ones whose sale is in this cash-up's scope.
    let refundsCents = 0;
    if (returns.length > 0) {
      const inScope = new Set(
        (
          await tx.sale.findMany({
            where: { tenantId, ...locationWhere, ...(employeeId ? { employeeId } : {}), id: { in: [...new Set(returns.map((r) => r.saleId))] } },
            select: { id: true },
          })
        ).map((s) => s.id),
      );
      for (const r of returns) {
        if (!inScope.has(r.saleId)) continue;
        refundsCents += asArray<ReturnItemEntry>(r.items).reduce((sum, item) => sum + (item.lineTotalCents ?? 0), 0);
      }
    }

    // A cashier's own cash-up doesn't include the shop's expenses (expenses carry no "paid by" link).
    const cashExpensesCents = employeeId ? 0 : expenses.filter((e) => methodById.get(e.paymentMethodId)?.code === CASH_CODE).reduce((sum, e) => sum + e.amountCents, 0);

    const byMethod = [...lines.values()].sort((a, b) => Number(b.isCash) - Number(a.isCash) || b.amountCents - a.amountCents);
    const cashCollectedCents = byMethod.filter((l) => l.isCash).reduce((sum, l) => sum + l.amountCents, 0);

    return {
      date: parsed.date,
      locationId,
      locationName: location?.locationName ?? null,
      employeeId,
      currency: tenant.currency,
      byMethod,
      totalCollectedCents: byMethod.reduce((sum, l) => sum + l.amountCents, 0),
      salesCount,
      voidedCount,
      refundsCents,
      cashExpensesCents,
      expectedCashCents: cashCollectedCents - refundsCents - cashExpensesCents,
      byCashier: employeeId ? null : [...cashiers.values()].sort((a, b) => b.amountCents - a.amountCents),
    };
  });
}
