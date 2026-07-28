import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { computeSalesAndProfit, type PaymentMethodBreakdownEntry, type SalesTopProduct } from "./mobile-metrics-service.js";

/**
 * Ports DESKTOP's Sales Report (report-service.ts's getSalesFinancialOverview/getSalesTrendWindow/
 * getSalesByStorefront/getSalesByEmployee) to Postgres for the Owner App — same period-grain model
 * (Daily/Weekly/Monthly/Yearly/Custom, steppable through history), same cash-recognition rules
 * (reused directly via computeSalesAndProfit, not re-derived), same period-over-period comparison.
 *
 * One deliberate improvement over DESKTOP: period boundaries are resolved in the TENANT's own
 * timezone (via the same offset trick mobile-metrics-service.ts's resolvePeriodRange already uses),
 * not raw UTC date strings — a Kenyan business's "today" should mean Nairobi's today.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_RADIUS = 5;

export type SalesReportMode = "daily" | "weekly" | "monthly" | "yearly" | "custom";

export type SalesReportPeriodInput =
  | { mode: "daily" | "weekly" | "monthly" | "yearly"; anchor: string }
  | { mode: "custom"; startDate: string; endDate: string };

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

/** The UTC instant corresponding to local midnight Y-M-D in `timezone`. */
function zonedInstant(year: number, month: number, day: number, timezone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day));
  const offsetMs = getTimezoneOffsetMs(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const offsetMs = getTimezoneOffsetMs(date, timezone);
  const zoned = new Date(date.getTime() + offsetMs);
  return { year: zoned.getUTCFullYear(), month: zoned.getUTCMonth() + 1, day: zoned.getUTCDate() };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function mondayOfDateString(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const diff = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return toIsoDate(date);
}

function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

type ResolvedRange = { start: Date; endExclusive: Date; startDate: string; endDate: string; label: string };

function labelFor(dateStr: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${dateStr}T00:00:00.000Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

/** anchor/mode -> a concrete [start, endExclusive) instant range, resolved in the tenant's own
 * timezone. Mirrors DESKTOP's rangeForAnchor, but timezone-real instead of UTC-naive. */
function resolveFixedRange(mode: Exclude<SalesReportMode, "custom">, anchor: string, timezone: string): ResolvedRange {
  if (mode === "daily") {
    const [year, month, day] = anchor.split("-").map(Number);
    const start = zonedInstant(year ?? 0, month ?? 1, day ?? 1, timezone);
    return { start, endExclusive: new Date(start.getTime() + DAY_MS), startDate: anchor, endDate: anchor, label: labelFor(anchor, { month: "short", day: "numeric", year: "numeric" }) };
  }
  if (mode === "weekly") {
    const [year, month, day] = anchor.split("-").map(Number);
    const start = zonedInstant(year ?? 0, month ?? 1, day ?? 1, timezone);
    const endDate = addUtcDays(anchor, 6);
    const label = `${labelFor(anchor, { month: "short", day: "numeric" })} – ${labelFor(endDate, { month: "short", day: "numeric", year: "numeric" })}`;
    return { start, endExclusive: new Date(start.getTime() + 7 * DAY_MS), startDate: anchor, endDate, label };
  }
  if (mode === "monthly") {
    const [year, month] = anchor.split("-").map(Number);
    const y = year ?? 0;
    const m = month ?? 1;
    const start = zonedInstant(y, m, 1, timezone);
    const nextYear = m === 12 ? y + 1 : y;
    const nextMonth = m === 12 ? 1 : m + 1;
    const endExclusive = zonedInstant(nextYear, nextMonth, 1, timezone);
    const lastDay = new Date(Date.UTC(nextYear, nextMonth - 1, 0)).getUTCDate();
    return {
      start,
      endExclusive,
      startDate: `${anchor}-01`,
      endDate: `${anchor}-${pad2(lastDay)}`,
      label: labelFor(`${anchor}-01`, { month: "long", year: "numeric" }),
    };
  }
  // yearly
  const year = Number(anchor);
  return {
    start: zonedInstant(year, 1, 1, timezone),
    endExclusive: zonedInstant(year + 1, 1, 1, timezone),
    startDate: `${anchor}-01-01`,
    endDate: `${anchor}-12-31`,
    label: anchor,
  };
}

function resolveCustomRange(startDate: string, endDate: string, timezone: string): ResolvedRange {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const start = zonedInstant(sy ?? 0, sm ?? 1, sd ?? 1, timezone);
  const endDayStart = zonedInstant(ey ?? 0, em ?? 1, ed ?? 1, timezone);
  return {
    start,
    endExclusive: new Date(endDayStart.getTime() + DAY_MS),
    startDate,
    endDate,
    label: `${labelFor(startDate, { month: "short", day: "numeric" })} – ${labelFor(endDate, { month: "short", day: "numeric", year: "numeric" })}`,
  };
}

function resolveRange(input: SalesReportPeriodInput, timezone: string): ResolvedRange {
  if (input.mode === "custom") return resolveCustomRange(input.startDate, input.endDate, timezone);
  return resolveFixedRange(input.mode, input.anchor, timezone);
}

function previousRangeOf(range: ResolvedRange): { start: Date; endExclusive: Date } {
  const spanMs = range.endExclusive.getTime() - range.start.getTime();
  return { start: new Date(range.start.getTime() - spanMs), endExclusive: range.start };
}

export type SalesReportOverview = {
  mode: SalesReportMode;
  label: string;
  startDate: string;
  endDate: string;
  currency: string;
  totalRevenueCents: number;
  totalRevenueChangePercent: number | null;
  netRevenueCents: number;
  netRevenueChangePercent: number | null;
  totalExpensesCents: number;
  totalExpensesChangePercent: number | null;
  netProfitCents: number;
  netProfitChangePercent: number | null;
  transactionCount: number;
  averageSaleCents: number;
  itemsSold: number;
  spansMultipleDays: boolean;
  averageDailyRevenueCents: number;
  topProducts: SalesTopProduct[];
  paymentSplit: PaymentMethodBreakdownEntry[];
};

export async function getSalesReportOverview(tenantId: string, input: SalesReportPeriodInput): Promise<SalesReportOverview> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, currency: true } });
  const range = resolveRange(input, tenant.timezone);
  const previous = previousRangeOf(range);

  return withTenantContext(tenantId, async (tx) => {
    const [current, prior] = await Promise.all([
      computeSalesAndProfit(tx, tenantId, { start: range.start, endExclusive: range.endExclusive }),
      computeSalesAndProfit(tx, tenantId, previous),
    ]);

    const spanDays = Math.round((range.endExclusive.getTime() - range.start.getTime()) / DAY_MS);
    const averageSaleCents = current.sales.transactionCount > 0 ? Math.round(current.sales.grossSalesCents / current.sales.transactionCount) : 0;
    const averageDailyRevenueCents = spanDays > 0 ? Math.round(current.sales.grossSalesCents / spanDays) : 0;

    return {
      mode: input.mode,
      label: range.label,
      startDate: range.startDate,
      endDate: range.endDate,
      currency: tenant.currency,
      totalRevenueCents: current.sales.revenueCents,
      totalRevenueChangePercent: percentChange(current.sales.revenueCents, prior.sales.revenueCents),
      netRevenueCents: current.profit.netRevenueCents,
      netRevenueChangePercent: percentChange(current.profit.netRevenueCents, prior.profit.netRevenueCents),
      totalExpensesCents: current.profit.totalExpensesCents,
      totalExpensesChangePercent: percentChange(current.profit.totalExpensesCents, prior.profit.totalExpensesCents),
      netProfitCents: current.profit.netProfitCents,
      netProfitChangePercent: percentChange(current.profit.netProfitCents, prior.profit.netProfitCents),
      transactionCount: current.sales.transactionCount,
      averageSaleCents,
      itemsSold: current.sales.itemsSold,
      spansMultipleDays: spanDays > 1,
      averageDailyRevenueCents,
      topProducts: current.sales.topProducts,
      paymentSplit: current.sales.paymentMethodBreakdown,
    };
  });
}

export type SalesTrendPoint = { periodLabel: string; periodStart: string; revenueCents: number; transactionCount: number; isSelected: boolean };
export type SalesTrendResult = { mode: SalesReportMode; points: SalesTrendPoint[] };

function shiftAnchor(mode: Exclude<SalesReportMode, "custom">, anchor: string, steps: number): string {
  if (mode === "daily") return addUtcDays(anchor, steps);
  if (mode === "weekly") return addUtcDays(anchor, steps * 7);
  if (mode === "monthly") {
    const [year, month] = anchor.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + steps, 1));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
  }
  return String(Number(anchor) + steps);
}

function currentAnchorForMode(mode: Exclude<SalesReportMode, "custom">, timezone: string, now: Date): string {
  const { year, month, day } = zonedParts(now, timezone);
  if (mode === "daily") return `${year}-${pad2(month)}-${pad2(day)}`;
  if (mode === "weekly") return mondayOfDateString(`${year}-${pad2(month)}-${pad2(day)}`);
  if (mode === "monthly") return `${year}-${pad2(month)}`;
  return String(year);
}

function windowAnchors(mode: Exclude<SalesReportMode, "custom">, anchor: string, timezone: string): string[] {
  const maxAnchor = currentAnchorForMode(mode, timezone, new Date());
  const result: string[] = [];
  for (let step = -WINDOW_RADIUS; step <= WINDOW_RADIUS; step++) {
    const shifted = shiftAnchor(mode, anchor, step);
    if (shifted <= maxAnchor) result.push(shifted);
  }
  return result;
}

function resolveGroupBy(startDate: string, endDate: string): "day" | "week" | "month" {
  const spanDays = Math.round((new Date(`${endDate}T00:00:00.000Z`).getTime() - new Date(`${startDate}T00:00:00.000Z`).getTime()) / DAY_MS) + 1;
  if (spanDays <= 31) return "day";
  if (spanDays <= 180) return "week";
  return "month";
}

function generateCustomBuckets(startDate: string, endDate: string, groupBy: "day" | "week" | "month", timezone: string): ResolvedRange[] {
  const buckets: ResolvedRange[] = [];
  if (groupBy === "day") {
    let cursor = startDate;
    while (cursor <= endDate) {
      buckets.push(resolveFixedRange("daily", cursor, timezone));
      cursor = addUtcDays(cursor, 1);
    }
  } else if (groupBy === "week") {
    let cursor = mondayOfDateString(startDate);
    while (cursor <= endDate) {
      buckets.push(resolveFixedRange("weekly", cursor, timezone));
      cursor = addUtcDays(cursor, 7);
    }
  } else {
    let cursor = startDate.slice(0, 7);
    while (`${cursor}-01` <= endDate) {
      buckets.push(resolveFixedRange("monthly", cursor, timezone));
      const [year, month] = cursor.split("-").map(Number);
      cursor = month === 12 ? `${(year ?? 0) + 1}-01` : `${year}-${pad2((month ?? 1) + 1)}`;
    }
  }
  return buckets;
}

/** Daily/Weekly/Monthly/Yearly: a window of nearby periods (5 before, 5 after, clamped so nothing
 * beyond "now" ever renders) with the selected one flagged. Custom: day/week/month auto-bucketing
 * across the exact range. Every point reuses computeSalesAndProfit — the exact same cash-basis
 * figure the overview card's Total Revenue uses — so the selected/highlighted point always matches. */
export async function getSalesTrend(tenantId: string, input: SalesReportPeriodInput): Promise<SalesTrendResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  const timezone = tenant.timezone;

  if (input.mode === "custom") {
    const range = resolveCustomRange(input.startDate, input.endDate, timezone);
    const groupBy = resolveGroupBy(range.startDate, range.endDate);
    const buckets = generateCustomBuckets(range.startDate, range.endDate, groupBy, timezone);

    const points = await withTenantContext(tenantId, async (tx) =>
      Promise.all(
        buckets.map(async (bucket) => {
          const { sales } = await computeSalesAndProfit(tx, tenantId, { start: bucket.start, endExclusive: bucket.endExclusive });
          return { periodLabel: bucket.label, periodStart: bucket.startDate, revenueCents: sales.revenueCents, transactionCount: sales.transactionCount, isSelected: false };
        }),
      ),
    );
    return { mode: "custom", points };
  }

  const mode = input.mode;
  const anchors = windowAnchors(mode, input.anchor, timezone);

  const points = await withTenantContext(tenantId, async (tx) =>
    Promise.all(
      anchors.map(async (anchor) => {
        const range = resolveFixedRange(mode, anchor, timezone);
        const { sales } = await computeSalesAndProfit(tx, tenantId, { start: range.start, endExclusive: range.endExclusive });
        return {
          periodLabel: range.label,
          periodStart: range.startDate,
          revenueCents: sales.revenueCents,
          transactionCount: sales.transactionCount,
          isSelected: anchor === input.anchor,
        };
      }),
    ),
  );
  return { mode, points };
}

export type SalesByStorefrontRow = {
  locationId: string;
  locationName: string;
  revenueCents: number;
  transactionCount: number;
  averageSaleCents: number;
  percentOfTotal: number;
};

export type SalesByEmployeeRow = {
  employeeId: string;
  employeeName: string;
  branchName: string | null;
  revenueCents: number;
  transactionCount: number;
  averageSaleCents: number;
  percentOfTotal: number;
};

export type SalesReportBreakdowns = { byStorefront: SalesByStorefrontRow[]; byEmployee: SalesByEmployeeRow[] };

/** Accrual-based (sum of grand_total_cents on completed sale documents), NOT cash-basis — matches
 * DESKTOP's own getSalesByStorefront/getSalesByEmployee exactly, which deliberately differ from the
 * Overview card's cash-basis Total Revenue (an invoice counts here the moment it's completed, not
 * only once actually paid). */
export async function getSalesBreakdowns(tenantId: string, input: SalesReportPeriodInput): Promise<SalesReportBreakdowns> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  const range = resolveRange(input, tenant.timezone);

  return withTenantContext(tenantId, async (tx) => {
    const [voids, sales] = await Promise.all([
      tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
      tx.sale.findMany({
        where: {
          tenantId,
          saleStatus: "completed",
          transactionType: { in: ["retail_sale", "wholesale_sale", "invoice"] },
          completedAt: { gte: range.start, lt: range.endExclusive },
          OR: [{ invoiceNumber: null }, { amountPaidCents: { gt: 0 } }],
        },
        select: { id: true, locationId: true, employeeId: true, grandTotalCents: true },
      }),
    ]);
    const voidedSaleIds = new Set(voids.map((v) => v.saleId));
    const liveSales = sales.filter((s) => !voidedSaleIds.has(s.id));

    const [locations, employees] = await Promise.all([
      tx.location.findMany({ where: { tenantId }, select: { id: true, locationName: true } }),
      tx.employee.findMany({ where: { tenantId }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    const locationNameById = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeNameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

    const totalRevenueCents = liveSales.reduce((sum, s) => sum + s.grandTotalCents, 0);

    const storefrontBuckets = new Map<string, { revenueCents: number; transactionCount: number }>();
    for (const sale of liveSales) {
      const bucket = storefrontBuckets.get(sale.locationId) ?? { revenueCents: 0, transactionCount: 0 };
      bucket.revenueCents += sale.grandTotalCents;
      bucket.transactionCount += 1;
      storefrontBuckets.set(sale.locationId, bucket);
    }
    const byStorefront: SalesByStorefrontRow[] = [...storefrontBuckets.entries()]
      .map(([locationId, bucket]) => ({
        locationId,
        locationName: locationNameById.get(locationId) ?? "—",
        revenueCents: bucket.revenueCents,
        transactionCount: bucket.transactionCount,
        averageSaleCents: bucket.transactionCount > 0 ? Math.round(bucket.revenueCents / bucket.transactionCount) : 0,
        percentOfTotal: totalRevenueCents > 0 ? Math.round((bucket.revenueCents / totalRevenueCents) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.revenueCents - a.revenueCents);

    const employeeBuckets = new Map<string, { revenueCents: number; transactionCount: number; branches: Set<string> }>();
    for (const sale of liveSales) {
      const bucket = employeeBuckets.get(sale.employeeId) ?? { revenueCents: 0, transactionCount: 0, branches: new Set<string>() };
      bucket.revenueCents += sale.grandTotalCents;
      bucket.transactionCount += 1;
      bucket.branches.add(locationNameById.get(sale.locationId) ?? "—");
      employeeBuckets.set(sale.employeeId, bucket);
    }
    const byEmployee: SalesByEmployeeRow[] = [...employeeBuckets.entries()]
      .map(([employeeId, bucket]) => ({
        employeeId,
        employeeName: employeeNameById.get(employeeId) ?? "—",
        branchName: bucket.branches.size > 1 ? "Multiple Branches" : ([...bucket.branches][0] ?? null),
        revenueCents: bucket.revenueCents,
        transactionCount: bucket.transactionCount,
        averageSaleCents: bucket.transactionCount > 0 ? Math.round(bucket.revenueCents / bucket.transactionCount) : 0,
        percentOfTotal: totalRevenueCents > 0 ? Math.round((bucket.revenueCents / totalRevenueCents) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.revenueCents - a.revenueCents);

    return { byStorefront, byEmployee };
  });
}
