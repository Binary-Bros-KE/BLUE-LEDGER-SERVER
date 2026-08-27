import { prisma } from "../prisma.js";
import { withTenantContext } from "../lib/tenant-context.js";

/**
 * Ports the exact cash-recognition/net-profit rules DESKTOP's own Sales Report already uses
 * (src/main/services/report-service.ts + report-repository.ts), operating over the same fields
 * synced to Postgres, so the Owner App's numbers never silently disagree with the desktop view for
 * the same period. Sale/Purchase/SaleReturn store line items and payments as JSON blobs rather than
 * normalized rows (see schema.prisma), so anything needing per-line/per-payment detail is fetched
 * and reduced here in JS, exactly like the desktop service already does over SQLite rows.
 */

const TOP_PRODUCTS_LIMIT = 10;
const STOCK_ALERT_LIST_LIMIT = 20;
const CREDIT_ALERT_LIST_LIMIT = 20;

type SalePaymentEntry = {
  paymentMethodId: string | null;
  paymentMethodName: string;
  amountCents: number;
  receivedAt: string;
};
type SaleItemEntry = { productId: string; quantity: number; lineTotalCents: number };
type SaleReturnItemEntry = { productId: string; quantity: number; lineTotalCents: number };
type PurchasePaymentEntry = { amountCents: number; paidAt: string };
type SaleServiceChargeEntry = { feeCents: number; costCents: number };
type SaleDeliveryEntry = { feeCents: number; costCents: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** The ms offset such that `date.getTime() + offset` reads as the requesting device's own wall-clock
 * moment — derived from the client-supplied `offsetMinutes` (same value as JS's own
 * Date.prototype.getTimezoneOffset(), sign-inverted here to match this module's "+offset = ahead of
 * UTC" convention), NEVER from the tenant's stored business-record timezone or this server's own
 * host timezone. A phone's offset is effectively constant for the days-long windows this covers, so
 * one value per request is all that's needed — no IANA zone/DST lookup required. */
function offsetMsFromClientMinutes(offsetMinutes: number): number {
  return -offsetMinutes * 60 * 1000;
}

function startOfDayInZone(reference: Date, offsetMs: number): Date {
  const zonedNow = new Date(reference.getTime() + offsetMs);
  const zonedMidnight = new Date(Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()));
  return new Date(zonedMidnight.getTime() - offsetMs);
}

export type MobilePeriod = "today" | "week" | "month";

export type PeriodRange = { start: Date; endExclusive: Date };

/** Resolves a client-selected period to a concrete [start, endExclusive) instant range on the
 * REQUESTING DEVICE's own clock — a business owner's "today" must mean today wherever their phone
 * actually is right now, not the tenant's stored onboarding timezone and not the server's own host
 * timezone. */
export function resolvePeriodRange(period: MobilePeriod, offsetMinutes: number, now: Date = new Date()): PeriodRange {
  const offsetMs = offsetMsFromClientMinutes(offsetMinutes);
  const todayStart = startOfDayInZone(now, offsetMs);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  if (period === "today") {
    return { start: todayStart, endExclusive: tomorrowStart };
  }

  if (period === "week") {
    const zonedToday = new Date(todayStart.getTime() + offsetMs);
    const dayOfWeek = zonedToday.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const mondayStart = new Date(todayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    return { start: mondayStart, endExclusive: tomorrowStart };
  }

  // month
  const zonedToday = new Date(todayStart.getTime() + offsetMs);
  const monthStartZoned = new Date(Date.UTC(zonedToday.getUTCFullYear(), zonedToday.getUTCMonth(), 1));
  const monthStart = new Date(monthStartZoned.getTime() - offsetMs);
  return { start: monthStart, endExclusive: tomorrowStart };
}

export type PaymentMethodBreakdownEntry = {
  paymentMethodName: string;
  revenueCents: number;
  transactionCount: number;
  percentOfTotal: number;
};

export type SalesTopProduct = {
  productId: string;
  productName: string;
  quantitySold: number;
  revenueCents: number;
};

export type SalesSnapshot = {
  revenueCents: number;
  transactionCount: number;
  /** Sum of every sold line's lineTotalCents — an ACCRUAL figure (what was sold), unlike
   * revenueCents above which is CASH (what was actually collected). Added for
   * mobile-sales-report-service.ts's averageSaleCents/averageDailyRevenueCents, which DESKTOP's own
   * Sales Report also derives from gross sales, not cash revenue. */
  grossSalesCents: number;
  itemsSold: number;
  paymentMethodBreakdown: PaymentMethodBreakdownEntry[];
  topProducts: SalesTopProduct[];
};

export type ExpensesAndProfit = {
  expensesCents: number;
  purchasesPaidCents: number;
  salariesPaidCents: number;
  serviceChargeCostsCents: number;
  totalExpensesCents: number;
  netRevenueCents: number;
  netProfitCents: number;
};

export type StockAlertProduct = { productId: string; productName: string; quantity: number; reorderLevel: number };

export type StockAlerts = {
  lowStockCount: number;
  outOfStockCount: number;
  lowStockProducts: StockAlertProduct[];
  outOfStockProducts: { productId: string; productName: string }[];
};

export type CustomerOverLimit = {
  customerId: string;
  customerName: string;
  outstandingCents: number;
  creditLimitCents: number;
};

export type OutstandingCredit = {
  totalOutstandingCents: number;
  debtorCount: number;
  customersOverLimit: CustomerOverLimit[];
};

export type MyRecentSale = {
  id: string;
  documentNumber: string | null;
  occurredAt: string;
  amountCents: number;
};

export type OwnerDashboardResult = {
  period: MobilePeriod;
  periodStart: string;
  periodEnd: string;
  currency: string;
  sales: SalesSnapshot;
  expensesAndProfit: ExpensesAndProfit;
  stock: StockAlerts;
  credit: OutstandingCredit;
  /** Only present when the request names an employeeId (the Owner App's Cashier dashboard variant)
   * — the exact same SalesSnapshot shape as `sales` above, scoped to just that one employee's own
   * sales, via computeSalesAndProfit's own employeeId parameter. Null for every other caller. */
  mySales: SalesSnapshot | null;
  /** The individual transactions behind mySales above — ports DESKTOP's own
   * window.blueLedger.report.mySales (CashierDashboard.tsx's "My sales today" table). Most recent
   * first, capped at 20 — a personal activity feed, not a full report. Null alongside mySales. */
  myRecentSales: MyRecentSale[] | null;
};

/** Fetches sale rows + the approved-void exclusion set + item/return/product context shared by both
 * the sales snapshot and the expenses/profit sections, then computes both from the same raw
 * material — mirrors getSalesFinancialOverview's own single-fetch-many-derivations shape.
 * Exported so mobile-sales-report-service.ts can reuse the exact same cash-recognition/net-profit
 * math for the Sales Report's overview cards and trend points — one source of truth, so the two
 * screens' numbers can never quietly disagree for the same period. */
export async function computeSalesAndProfit(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  range: PeriodRange,
  locationId?: string | null,
  /** Scopes both the retail/wholesale sales AND the invoice-payment lookups to one employee — used
   * by getOwnerDashboard's mySales, so a Cashier's personal figure reuses this exact same
   * cash-recognition/refund-netting math rather than a second, simpler (and possibly
   * inconsistent) reimplementation. Sale.employeeId is "who owns/created the sale", same semantics
   * DESKTOP's own CashierDashboard filters salesByEmployee by. */
  employeeId?: string | null,
): Promise<{ sales: SalesSnapshot; profit: ExpensesAndProfit }> {
  const { start, endExclusive } = range;
  const locationWhere = locationId ? { locationId } : {};
  const employeeWhere = employeeId ? { employeeId } : {};

  const [
    voidedSales,
    salesInRange,
    invoiceCandidates,
    approvedReturnsInRange,
    expenseAgg,
    purchases,
    salaries,
    productRows,
    paymentMethods,
  ] = await Promise.all([
    tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
    tx.sale.findMany({
      where: {
        tenantId,
        ...locationWhere,
        ...employeeWhere,
        saleStatus: "completed",
        completedAt: { gte: start, lt: endExclusive },
        OR: [{ invoiceNumber: null }, { amountPaidCents: { gt: 0 } }],
      },
      select: {
        id: true,
        invoiceNumber: true,
        grandTotalCents: true,
        amountPaidCents: true,
        paymentMethodId: true,
        items: true,
        serviceCharges: true,
        delivery: true,
      },
    }),
    tx.sale.findMany({
      where: {
        tenantId,
        ...locationWhere,
        ...employeeWhere,
        saleStatus: "completed",
        invoiceNumber: { not: null },
        paymentStatus: { not: "cancelled" },
        amountPaidCents: { gt: 0 },
        completedAt: { lt: endExclusive },
      },
      select: { id: true, payments: true },
    }),
    tx.saleReturn.findMany({
      where: { tenantId, status: "approved", approvedAt: { gte: start, lt: endExclusive } },
      select: { saleId: true, items: true },
    }),
    tx.expense.aggregate({
      where: {
        tenantId,
        // Expense's location analog is storefrontId (nullable — a company-wide expense has none),
        // unlike Sale/Purchase's non-nullable locationId.
        ...(locationId ? { storefrontId: locationId } : {}),
        status: "active",
        expenseDate: { gte: start.toISOString().slice(0, 10), lte: endExclusive.toISOString().slice(0, 10) },
      },
      _sum: { amountCents: true },
    }),
    tx.purchase.findMany({
      where: { tenantId, ...locationWhere, status: { not: "cancelled" }, amountPaidCents: { gt: 0 } },
      select: { payments: true },
    }),
    // Salary has no location field at all (payroll isn't storefront-scoped) — always company-wide,
    // regardless of the requested locationId.
    tx.salary.aggregate({
      where: { tenantId, status: "active", localCreatedAt: { gte: start, lt: endExclusive } },
      _sum: { netPayCents: true },
    }),
    tx.product.findMany({ where: { tenantId }, select: { id: true, name: true, buyingPriceCents: true } }),
    tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);

  // SaleReturn has no locationId/employeeId of its own (an opaque saleId reference, same convention
  // as its other FK-avoidance fields elsewhere in this app) — when scoping to one storefront and/or
  // one employee, resolve which of these returns' underlying sales actually belong to that scope via
  // one extra lookup, so a filtered dashboard's refund netting doesn't pull in another storefront's
  // (or, critically, another EMPLOYEE'S) returns. Missing the employeeId half of this exact guard is
  // what let mySales (getOwnerDashboard's Cashier figure) go negative for an employee who made zero
  // sales — any return approved anywhere in the tenant that day was being subtracted from every
  // employee's personal total, not just the one who actually made the returned sale.
  let returnSaleIdsInScope: Set<string> | null = null;
  if (locationId || employeeId) {
    const candidateSaleIds = [...new Set(approvedReturnsInRange.map((r) => r.saleId))];
    const matchingSales =
      candidateSaleIds.length > 0
        ? await tx.sale.findMany({ where: { tenantId, ...locationWhere, ...employeeWhere, id: { in: candidateSaleIds } }, select: { id: true } })
        : [];
    returnSaleIdsInScope = new Set(matchingSales.map((s) => s.id));
  }

  const voidedSaleIds = new Set(voidedSales.map((v) => v.saleId));
  const liveSales = salesInRange.filter((s) => !voidedSaleIds.has(s.id));

  const productById = new Map(productRows.map((p) => [p.id, p]));
  const paymentMethodNameById = new Map(paymentMethods.map((p) => [p.id, p.name]));

  // --- Cash revenue: retail/wholesale sales counted by completedAt (already range-bounded above),
  // invoice cash counted by each individual payment's receivedAt, minus approved-return refunds
  // dated by approvedAt (both already range-bounded above). ---
  const buckets = new Map<string, { name: string; revenueCents: number; transactionCount: number }>();
  const addToBucket = (id: string, name: string, cents: number) => {
    const existing = buckets.get(id) ?? { name, revenueCents: 0, transactionCount: 0 };
    existing.revenueCents += cents;
    existing.transactionCount += 1;
    buckets.set(id, existing);
  };

  let retailWholesaleCents = 0;
  const nonInvoiceSales = liveSales.filter((s) => s.invoiceNumber === null);
  for (const sale of nonInvoiceSales) {
    const methodName = sale.paymentMethodId ? (paymentMethodNameById.get(sale.paymentMethodId) ?? "Other") : "Other";
    addToBucket(sale.paymentMethodId ?? "other", methodName, sale.grandTotalCents);
    retailWholesaleCents += sale.grandTotalCents;
  }

  let invoicePaymentCents = 0;
  const invoiceIdsInRange = new Set(liveSales.filter((s) => s.invoiceNumber !== null).map((s) => s.id));
  for (const invoice of invoiceCandidates) {
    if (voidedSaleIds.has(invoice.id)) continue;
    for (const payment of asArray<SalePaymentEntry>(invoice.payments)) {
      if (payment.receivedAt >= start.toISOString() && payment.receivedAt < endExclusive.toISOString()) {
        addToBucket(payment.paymentMethodId ?? "other", payment.paymentMethodName || "Other", payment.amountCents);
        invoicePaymentCents += payment.amountCents;
        invoiceIdsInRange.add(invoice.id);
      }
    }
  }

  let refundCents = 0;
  for (const ret of approvedReturnsInRange) {
    if (returnSaleIdsInScope && !returnSaleIdsInScope.has(ret.saleId)) continue;
    for (const item of asArray<SaleReturnItemEntry>(ret.items)) {
      refundCents += item.lineTotalCents;
    }
  }

  const grossCents = retailWholesaleCents + invoicePaymentCents;
  const revenueCents = grossCents - refundCents;
  const paymentMethodBreakdown: PaymentMethodBreakdownEntry[] = [...buckets.values()]
    .map((bucket) => ({
      paymentMethodName: bucket.name,
      revenueCents: bucket.revenueCents,
      transactionCount: bucket.transactionCount,
      percentOfTotal: grossCents > 0 ? Math.round((bucket.revenueCents / grossCents) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);

  // --- Net revenue (gross profit, cash-recognized): item-level margin, recognized only to the
  // fraction of the sale actually paid so far. Uses each product's CURRENT buying price as a proxy
  // for cost at sale time (no per-line cost snapshot exists in the synced data — same limitation
  // desktop's own report already has). ---
  const productMap = new Map<string, SalesTopProduct>();
  let netRevenueCents = 0;
  let transactionCount = 0;
  let grossSalesCents = 0;
  let itemsSold = 0;
  for (const sale of liveSales) {
    const items = asArray<SaleItemEntry>(sale.items);
    let saleRevenue = 0;
    let saleCost = 0;
    for (const item of items) {
      saleRevenue += item.lineTotalCents;
      saleCost += item.quantity * (productById.get(item.productId)?.buyingPriceCents ?? 0);
      itemsSold += item.quantity;

      const existing = productMap.get(item.productId) ?? {
        productId: item.productId,
        productName: productById.get(item.productId)?.name ?? "Unknown product",
        quantitySold: 0,
        revenueCents: 0,
      };
      existing.quantitySold += item.quantity;
      existing.revenueCents += item.lineTotalCents;
      productMap.set(item.productId, existing);
    }
    grossSalesCents += saleRevenue;

    // Delivery/service-charge FEE (what the customer was charged, e.g. a delivery fee) counted as
    // real revenue here — matching DESKTOP's own report-service.ts computeNetRevenueCents exactly.
    // The COST side (e.g. what the rider was actually paid) is deliberately NOT subtracted again
    // here — service-charge cost is deducted once via serviceChargeCostsCents below feeding
    // totalExpensesCents; delivery cost is booked as a real "Delivery Costs" expense instead (see
    // DESKTOP's expense-service.ts createDeliveryCostExpenseIfNeeded), already counted via
    // expensesCents. Before this fix, the fee showed up in Total Revenue (baked into grandTotalCents)
    // but never anywhere in Net Revenue, while its cost always was — this was the exact gap that made
    // mobile's Net Revenue disagree with DESKTOP's for the same period.
    let saleFeeRevenue = 0;
    for (const charge of asArray<SaleServiceChargeEntry>(sale.serviceCharges)) {
      saleFeeRevenue += charge.feeCents;
    }
    const saleDelivery = sale.delivery as SaleDeliveryEntry | null;
    if (saleDelivery) saleFeeRevenue += saleDelivery.feeCents;

    const fractionPaid =
      sale.invoiceNumber === null ? 1 : sale.grandTotalCents > 0 ? Math.min(1, sale.amountPaidCents / sale.grandTotalCents) : 0;
    netRevenueCents += (saleRevenue + saleFeeRevenue - saleCost) * fractionPaid;
    transactionCount += 1;
  }
  netRevenueCents = Math.round(netRevenueCents);

  const topProducts = [...productMap.values()].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, TOP_PRODUCTS_LIMIT);

  // --- Total expenses: general categorized expenses (now including any auto-booked "Delivery
  // Costs" rows) + suppliers paid + salaries paid + hidden service-charge cost on completed sales
  // in range. Delivery cost is NOT summed separately here anymore — see the comment above. ---
  let purchasesPaidCents = 0;
  for (const purchase of purchases) {
    for (const payment of asArray<PurchasePaymentEntry>(purchase.payments)) {
      if (payment.paidAt >= start.toISOString() && payment.paidAt < endExclusive.toISOString()) {
        purchasesPaidCents += payment.amountCents;
      }
    }
  }

  let serviceChargeCostsCents = 0;
  for (const sale of liveSales) {
    for (const charge of asArray<SaleServiceChargeEntry>(sale.serviceCharges)) {
      serviceChargeCostsCents += charge.costCents;
    }
  }

  const expensesCents = expenseAgg._sum.amountCents ?? 0;
  const salariesPaidCents = salaries._sum.netPayCents ?? 0;
  // Capital (a purchase's goods + shipping, once paid) is deliberately never counted as an
  // "expense" here — netRevenueCents above already nets out the cost of what actually sold, so
  // also subtracting the full cash cost of inventory the moment it's bought would double-count it.
  // Mirrors DESKTOP's report-service.ts (getSalesFinancialOverview) exactly. purchasesPaidCents is
  // still returned below as its own "Total Capital Invested" figure — informational only, never
  // folded into profit.
  const totalExpensesCents = expensesCents + salariesPaidCents + serviceChargeCostsCents;
  const netProfitCents = netRevenueCents - totalExpensesCents;

  return {
    sales: { revenueCents, transactionCount, grossSalesCents, itemsSold, paymentMethodBreakdown, topProducts },
    profit: {
      expensesCents,
      purchasesPaidCents,
      salariesPaidCents,
      serviceChargeCostsCents,
      totalExpensesCents,
      netRevenueCents,
      netProfitCents,
    },
  };
}

async function computeStockAlerts(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  locationId?: string | null,
): Promise<StockAlerts> {
  const [products, movementSums] = await Promise.all([
    tx.product.findMany({
      where: { tenantId, trackStock: true, status: "active" },
      select: { id: true, name: true, reorderLevel: true },
    }),
    // Scoped to one storefront, "quantity" becomes that location's own stock rather than the
    // company-wide total across every location — matches DESKTOP's own per-location Inventory
    // Report philosophy once a storefront filter is applied.
    tx.stockMovement.groupBy({ by: ["productId"], where: { tenantId, ...(locationId ? { locationId } : {}) }, _sum: { quantityChange: true } }),
  ]);

  const quantityByProduct = new Map(movementSums.map((row) => [row.productId, row._sum.quantityChange ?? 0]));

  const lowStockProducts: StockAlertProduct[] = [];
  const outOfStockProducts: { productId: string; productName: string }[] = [];

  for (const product of products) {
    const quantity = quantityByProduct.get(product.id) ?? 0;
    if (quantity <= 0) {
      outOfStockProducts.push({ productId: product.id, productName: product.name });
    } else if (product.reorderLevel > 0 && quantity < product.reorderLevel) {
      lowStockProducts.push({ productId: product.id, productName: product.name, quantity, reorderLevel: product.reorderLevel });
    }
  }

  return {
    lowStockCount: lowStockProducts.length,
    outOfStockCount: outOfStockProducts.length,
    lowStockProducts: lowStockProducts.slice(0, STOCK_ALERT_LIST_LIMIT),
    outOfStockProducts: outOfStockProducts.slice(0, STOCK_ALERT_LIST_LIMIT),
  };
}

async function computeOutstandingCredit(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  locationId?: string | null,
): Promise<OutstandingCredit> {
  const [voidedSales, openInvoices, approvedReturns, customers] = await Promise.all([
    tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
    tx.sale.findMany({
      where: {
        tenantId,
        ...(locationId ? { locationId } : {}),
        saleStatus: "completed",
        invoiceNumber: { not: null },
        paymentStatus: { notIn: ["paid", "cancelled"] },
      },
      select: { id: true, customerId: true, grandTotalCents: true, amountPaidCents: true },
    }),
    // Not location-filtered — the loop below only ever looks up a return by an openInvoices.id key,
    // so a return against an invoice from another storefront simply never matches once openInvoices
    // is itself scoped above; no separate join needed here (unlike the refund netting in
    // computeSalesAndProfit, which isn't keyed off an already-filtered id set).
    tx.saleReturn.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true, items: true } }),
    tx.customer.findMany({ where: { tenantId }, select: { id: true, name: true, creditLimitCents: true } }),
  ]);

  const voidedSaleIds = new Set(voidedSales.map((v) => v.saleId));
  const returnedValueBySale = new Map<string, number>();
  for (const ret of approvedReturns) {
    const value = asArray<SaleReturnItemEntry>(ret.items).reduce((sum, item) => sum + item.lineTotalCents, 0);
    returnedValueBySale.set(ret.saleId, (returnedValueBySale.get(ret.saleId) ?? 0) + value);
  }

  const balanceByCustomer = new Map<string, number>();
  for (const invoice of openInvoices) {
    if (voidedSaleIds.has(invoice.id) || !invoice.customerId) continue;
    const returnedValue = returnedValueBySale.get(invoice.id) ?? 0;
    const balance = Math.max(0, invoice.grandTotalCents - invoice.amountPaidCents - returnedValue);
    if (balance <= 0) continue;
    balanceByCustomer.set(invoice.customerId, (balanceByCustomer.get(invoice.customerId) ?? 0) + balance);
  }

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const totalOutstandingCents = [...balanceByCustomer.values()].reduce((sum, v) => sum + v, 0);

  const customersOverLimit: CustomerOverLimit[] = [...balanceByCustomer.entries()]
    .map(([customerId, outstandingCents]) => ({ customerId, outstandingCents, customer: customerById.get(customerId) }))
    .filter(
      (entry): entry is { customerId: string; outstandingCents: number; customer: { id: string; name: string; creditLimitCents: number | null } } =>
        entry.customer !== undefined && entry.customer.creditLimitCents !== null && entry.outstandingCents > entry.customer.creditLimitCents,
    )
    .map((entry) => ({
      customerId: entry.customerId,
      customerName: entry.customer.name,
      outstandingCents: entry.outstandingCents,
      creditLimitCents: entry.customer.creditLimitCents as number,
    }))
    .sort((a, b) => b.outstandingCents - a.outstandingCents)
    .slice(0, CREDIT_ALERT_LIST_LIMIT);

  return {
    totalOutstandingCents,
    debtorCount: balanceByCustomer.size,
    customersOverLimit,
  };
}

/** Everything the Owner App's home screen needs, in one call — a single withTenantContext
 * transaction covering every RLS-protected read (sales, expenses, products, customers, etc.),
 * exactly the discipline that fixed the earlier Storefronts-empty-query bug (see
 * tenant-service.ts's findTenantLocations). */
export async function getOwnerDashboard(
  tenantId: string,
  period: MobilePeriod,
  timezoneOffsetMinutes: number,
  locationId?: string | null,
  /** The Cashier dashboard variant's own employee id — computes an additional employee-scoped
   * `mySales` snapshot alongside the normal business-wide one. Omitted/null for every other caller
   * (Admin/Manager, Storekeeper). */
  employeeId?: string | null,
): Promise<OwnerDashboardResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });
  const range = resolvePeriodRange(period, timezoneOffsetMinutes);

  const { sales, profit, stock, credit, mySales, myRecentSales } = await withTenantContext(tenantId, async (tx) => {
    const [{ sales, profit }, stock, credit, mySalesResult, myRecentSalesRows, myVoidedSaleIds] = await Promise.all([
      computeSalesAndProfit(tx, tenantId, range, locationId),
      computeStockAlerts(tx, tenantId, locationId),
      computeOutstandingCredit(tx, tenantId, locationId),
      employeeId ? computeSalesAndProfit(tx, tenantId, range, locationId, employeeId) : Promise.resolve(null),
      employeeId
        ? tx.sale.findMany({
            where: {
              tenantId,
              employeeId,
              ...(locationId ? { locationId } : {}),
              saleStatus: "completed",
              completedAt: { gte: range.start, lt: range.endExclusive },
            },
            select: { id: true, receiptNumber: true, invoiceNumber: true, grandTotalCents: true, completedAt: true },
            orderBy: { completedAt: "desc" },
            take: 20,
          })
        : Promise.resolve([]),
      employeeId ? tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }) : Promise.resolve([]),
    ]);
    const voidedIds = new Set(myVoidedSaleIds.map((v) => v.saleId));
    const myRecentSales: MyRecentSale[] | null = employeeId
      ? myRecentSalesRows
          .filter((row) => !voidedIds.has(row.id))
          .map((row) => ({
            id: row.id,
            documentNumber: row.invoiceNumber ?? row.receiptNumber,
            occurredAt: (row.completedAt ?? range.start).toISOString(),
            amountCents: row.grandTotalCents,
          }))
      : null;
    return { sales, profit, stock, credit, mySales: mySalesResult ? mySalesResult.sales : null, myRecentSales };
  });

  return {
    period,
    periodStart: range.start.toISOString(),
    periodEnd: range.endExclusive.toISOString(),
    currency: tenant.currency,
    sales,
    expensesAndProfit: profit,
    stock,
    credit,
    mySales,
    myRecentSales,
  };
}
