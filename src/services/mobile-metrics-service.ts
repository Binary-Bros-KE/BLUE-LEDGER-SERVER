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
type SaleServiceChargeEntry = { costCents: number };
type SaleDeliveryEntry = { costCents: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Returns the ms offset such that `date.getTime() + offset` reads as the same wall-clock moment
 * in `timeZone`. All four tenant timezone choices (Kenya/Uganda/Tanzania/Ethiopia) are fixed-offset
 * (no DST), so this is exact for this app's real timezone list, and a reasonable approximation
 * (computed from "now") for any DST zone too. */
function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function startOfDayInZone(reference: Date, timeZone: string): Date {
  const offsetMs = getTimezoneOffsetMs(reference, timeZone);
  const zonedNow = new Date(reference.getTime() + offsetMs);
  const zonedMidnight = new Date(Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate()));
  return new Date(zonedMidnight.getTime() - offsetMs);
}

export type MobilePeriod = "today" | "week" | "month";

export type PeriodRange = { start: Date; endExclusive: Date };

/** Resolves a client-selected period to a concrete [start, endExclusive) instant range in the
 * tenant's own timezone — a Kenyan business's "today" must mean Nairobi's today, not UTC's. */
export function resolvePeriodRange(period: MobilePeriod, timezone: string, now: Date = new Date()): PeriodRange {
  const todayStart = startOfDayInZone(now, timezone);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  if (period === "today") {
    return { start: todayStart, endExclusive: tomorrowStart };
  }

  if (period === "week") {
    const offsetMs = getTimezoneOffsetMs(now, timezone);
    const zonedToday = new Date(todayStart.getTime() + offsetMs);
    const dayOfWeek = zonedToday.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const mondayStart = new Date(todayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    return { start: mondayStart, endExclusive: tomorrowStart };
  }

  // month
  const offsetMs = getTimezoneOffsetMs(now, timezone);
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
  deliveryServiceCostsCents: number;
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

export type OwnerDashboardResult = {
  period: MobilePeriod;
  periodStart: string;
  periodEnd: string;
  currency: string;
  sales: SalesSnapshot;
  expensesAndProfit: ExpensesAndProfit;
  stock: StockAlerts;
  credit: OutstandingCredit;
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
): Promise<{ sales: SalesSnapshot; profit: ExpensesAndProfit }> {
  const { start, endExclusive } = range;

  const [voidedSales, salesInRange, invoiceCandidates, approvedReturnsInRange, expenseAgg, purchases, salaries, productRows, paymentMethods] =
    await Promise.all([
      tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
      tx.sale.findMany({
        where: {
          tenantId,
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
        select: { items: true },
      }),
      tx.expense.aggregate({
        where: {
          tenantId,
          status: "active",
          expenseDate: { gte: start.toISOString().slice(0, 10), lte: endExclusive.toISOString().slice(0, 10) },
        },
        _sum: { amountCents: true },
      }),
      tx.purchase.findMany({
        where: { tenantId, status: { not: "cancelled" }, amountPaidCents: { gt: 0 } },
        select: { payments: true },
      }),
      tx.salary.aggregate({
        where: { tenantId, status: "active", localCreatedAt: { gte: start, lt: endExclusive } },
        _sum: { netPayCents: true },
      }),
      tx.product.findMany({ where: { tenantId }, select: { id: true, name: true, buyingPriceCents: true } }),
      tx.paymentMethod.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);

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

    const fractionPaid =
      sale.invoiceNumber === null ? 1 : sale.grandTotalCents > 0 ? Math.min(1, sale.amountPaidCents / sale.grandTotalCents) : 0;
    netRevenueCents += (saleRevenue - saleCost) * fractionPaid;
    transactionCount += 1;
  }
  netRevenueCents = Math.round(netRevenueCents);

  const topProducts = [...productMap.values()].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, TOP_PRODUCTS_LIMIT);

  // --- Total expenses: general categorized expenses + suppliers paid + salaries paid + hidden
  // service-charge/delivery costs on completed sales in range. ---
  let purchasesPaidCents = 0;
  for (const purchase of purchases) {
    for (const payment of asArray<PurchasePaymentEntry>(purchase.payments)) {
      if (payment.paidAt >= start.toISOString() && payment.paidAt < endExclusive.toISOString()) {
        purchasesPaidCents += payment.amountCents;
      }
    }
  }

  let deliveryServiceCostsCents = 0;
  for (const sale of liveSales) {
    for (const charge of asArray<SaleServiceChargeEntry>(sale.serviceCharges)) {
      deliveryServiceCostsCents += charge.costCents;
    }
    const delivery = sale.delivery as SaleDeliveryEntry | null;
    if (delivery) deliveryServiceCostsCents += delivery.costCents;
  }

  const expensesCents = expenseAgg._sum.amountCents ?? 0;
  const salariesPaidCents = salaries._sum.netPayCents ?? 0;
  const totalExpensesCents = expensesCents + purchasesPaidCents + salariesPaidCents + deliveryServiceCostsCents;
  const netProfitCents = netRevenueCents - totalExpensesCents;

  return {
    sales: { revenueCents, transactionCount, grossSalesCents, itemsSold, paymentMethodBreakdown, topProducts },
    profit: {
      expensesCents,
      purchasesPaidCents,
      salariesPaidCents,
      deliveryServiceCostsCents,
      totalExpensesCents,
      netRevenueCents,
      netProfitCents,
    },
  };
}

async function computeStockAlerts(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
): Promise<StockAlerts> {
  const [products, movementSums] = await Promise.all([
    tx.product.findMany({
      where: { tenantId, trackStock: true, status: "active" },
      select: { id: true, name: true, reorderLevel: true },
    }),
    tx.stockMovement.groupBy({ by: ["productId"], where: { tenantId }, _sum: { quantityChange: true } }),
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
): Promise<OutstandingCredit> {
  const [voidedSales, openInvoices, approvedReturns, customers] = await Promise.all([
    tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
    tx.sale.findMany({
      where: { tenantId, saleStatus: "completed", invoiceNumber: { not: null }, paymentStatus: { notIn: ["paid", "cancelled"] } },
      select: { id: true, customerId: true, grandTotalCents: true, amountPaidCents: true },
    }),
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
export async function getOwnerDashboard(tenantId: string, period: MobilePeriod): Promise<OwnerDashboardResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, currency: true } });
  const range = resolvePeriodRange(period, tenant.timezone);

  const { sales, profit, stock, credit } = await withTenantContext(tenantId, async (tx) => {
    const [{ sales, profit }, stock, credit] = await Promise.all([
      computeSalesAndProfit(tx, tenantId, range),
      computeStockAlerts(tx, tenantId),
      computeOutstandingCredit(tx, tenantId),
    ]);
    return { sales, profit, stock, credit };
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
  };
}
