import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { mobileProductPerformanceQuerySchema, mobileStockValueQuerySchema } from "../schemas/mobile.js";

/**
 * The Owner App's Reports tab — ports of the two DESKTOP reports the Sales Report doesn't already
 * cover: the Inventory Report's stock value (inventory-report-service.ts) and the Products Report's
 * best sellers / slow movers (product-report-service.ts). Same definitions as DESKTOP so the two
 * apps agree for the same data:
 *  - stock value is quantity × the product's CURRENT buying price (no per-batch cost exists);
 *  - a sale counts when completed, a retail/wholesale sale or invoice, not cancelled, not voided, and
 *    — for an invoice — only once something has been paid on it; approved returns are netted out of
 *    quantity and revenue; cost uses the current buying price, same limitation DESKTOP documents.
 */

const SLOW_MOVING_LIMIT = 20;
/** How far back "days since last sale" looks. DESKTOP scans all history; on a phone-facing API that
 * would read every sale ever made, so older than this shows as "no sale in 180+ days". */
const LAST_SOLD_LOOKBACK_DAYS = 180;
const DAY_MS = 86_400_000;

type SaleItemEntry = { id?: string; productId: string; quantity: number; lineTotalCents: number };
type ReturnItemEntry = { saleItemId?: string; quantity?: number; lineTotalCents?: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------------------------
// Stock value
// ---------------------------------------------------------------------------------------------

export type StockValueLocation = {
  locationId: string;
  locationName: string;
  isMainStore: boolean;
  productCount: number;
  totalUnits: number;
  costValueCents: number;
  retailValueCents: number;
  lowStockCount: number;
  outOfStockCount: number;
};

export type StockValueProduct = {
  productId: string;
  name: string;
  sku: string;
  units: number;
  costValueCents: number;
  retailValueCents: number;
};

export type MobileStockValueReport = {
  currency: string;
  totalUnits: number;
  costValueCents: number;
  retailValueCents: number;
  locations: StockValueLocation[];
  /** Highest cost value first — where the money is sitting. */
  topProducts: StockValueProduct[];
};

export async function getStockValueReport(tenantId: string, query: unknown, forcedLocationId: string | null): Promise<MobileStockValueReport> {
  const parsed = mobileStockValueQuerySchema.parse(query);
  const locationId = forcedLocationId ?? parsed.locationId ?? null;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const [locations, products, balances] = await Promise.all([
      tx.location.findMany({ where: { tenantId, status: "active", ...(locationId ? { id: locationId } : {}) }, select: { id: true, locationName: true, locationType: true } }),
      tx.product.findMany({
        where: { tenantId, status: "active", trackStock: true },
        select: { id: true, name: true, sku: true, buyingPriceCents: true, sellingPriceCents: true, reorderLevel: true },
      }),
      tx.inventory.findMany({ where: { tenantId, ...(locationId ? { locationId } : {}) }, select: { productId: true, locationId: true, quantity: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const byProduct = new Map<string, StockValueProduct>();

    const locationRows: StockValueLocation[] = locations.map((location) => {
      const rows = balances.filter((b) => b.locationId === location.id && productById.has(b.productId));
      let totalUnits = 0;
      let costValueCents = 0;
      let retailValueCents = 0;
      let lowStockCount = 0;
      let outOfStockCount = 0;
      for (const row of rows) {
        const product = productById.get(row.productId)!;
        // Negative stock (a queued-offline sale, or allowNegativeStock) is a counting problem, not value.
        const units = Math.max(0, row.quantity);
        totalUnits += units;
        costValueCents += units * product.buyingPriceCents;
        retailValueCents += units * product.sellingPriceCents;
        if (row.quantity <= 0) outOfStockCount += 1;
        else if (product.reorderLevel > 0 && row.quantity < product.reorderLevel) lowStockCount += 1;
        const agg = byProduct.get(product.id) ?? { productId: product.id, name: product.name, sku: product.sku, units: 0, costValueCents: 0, retailValueCents: 0 };
        agg.units += units;
        agg.costValueCents += units * product.buyingPriceCents;
        agg.retailValueCents += units * product.sellingPriceCents;
        byProduct.set(product.id, agg);
      }
      return {
        locationId: location.id,
        locationName: location.locationName,
        isMainStore: location.locationType === "distribution_center",
        productCount: rows.filter((r) => r.quantity > 0).length,
        totalUnits,
        costValueCents,
        retailValueCents,
        lowStockCount,
        outOfStockCount,
      };
    });

    return {
      currency: tenant.currency,
      totalUnits: locationRows.reduce((s, l) => s + l.totalUnits, 0),
      costValueCents: locationRows.reduce((s, l) => s + l.costValueCents, 0),
      retailValueCents: locationRows.reduce((s, l) => s + l.retailValueCents, 0),
      locations: locationRows.sort((a, b) => Number(b.isMainStore) - Number(a.isMainStore) || b.costValueCents - a.costValueCents),
      topProducts: [...byProduct.values()].sort((a, b) => b.costValueCents - a.costValueCents).slice(0, 15),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Product performance
// ---------------------------------------------------------------------------------------------

export type ProductPerformanceRow = {
  productId: string;
  name: string;
  sku: string;
  quantitySold: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
};

export type SlowMovingRow = {
  productId: string;
  name: string;
  sku: string;
  quantitySoldInPeriod: number;
  /** Null = no sale within LAST_SOLD_LOOKBACK_DAYS. */
  daysSinceLastSale: number | null;
};

export type MobileProductPerformanceReport = {
  currency: string;
  startDate: string;
  endDate: string;
  /** Every product that sold in the period, most units first (the app re-sorts by revenue/profit). */
  bestSelling: ProductPerformanceRow[];
  slowMoving: SlowMovingRow[];
  lookbackDays: number;
};

export async function getProductPerformanceReport(tenantId: string, query: unknown, forcedLocationId: string | null): Promise<MobileProductPerformanceReport> {
  const parsed = mobileProductPerformanceQuerySchema.parse(query);
  const locationId = forcedLocationId ?? parsed.locationId ?? null;
  // The phone's own calendar days (getTimezoneOffset convention — Nairobi is -180).
  const offsetMs = parsed.timezoneOffsetMinutes * 60_000;
  const start = new Date(Date.parse(`${parsed.startDate}T00:00:00.000Z`) + offsetMs);
  const endExclusive = new Date(Date.parse(`${parsed.endDate}T00:00:00.000Z`) + DAY_MS + offsetMs);
  const lookbackStart = new Date(Math.min(start.getTime(), Date.now() - LAST_SOLD_LOOKBACK_DAYS * DAY_MS));
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });

  return withTenantContext(tenantId, async (tx) => {
    const [voids, sales, products] = await Promise.all([
      tx.saleVoid.findMany({ where: { tenantId, status: "approved" }, select: { saleId: true } }),
      // One read covers both the period and the last-sold lookback.
      tx.sale.findMany({
        where: {
          tenantId,
          ...(locationId ? { locationId } : {}),
          saleStatus: "completed",
          transactionType: { in: ["retail_sale", "wholesale_sale", "invoice"] },
          paymentStatus: { not: "cancelled" },
          OR: [{ invoiceNumber: null }, { amountPaidCents: { gt: 0 } }],
          completedAt: { gte: lookbackStart, lt: endExclusive },
        },
        select: { id: true, completedAt: true, items: true },
      }),
      tx.product.findMany({ where: { tenantId }, select: { id: true, name: true, sku: true, buyingPriceCents: true, status: true, trackStock: true } }),
    ]);
    const voided = new Set(voids.map((v) => v.saleId));
    const live = sales.filter((s) => !voided.has(s.id));
    const inPeriod = live.filter((s) => s.completedAt && s.completedAt >= start && s.completedAt < endExclusive);

    // Approved returns net out per sale item — DESKTOP's RETURN_NETTING_JOIN, whenever approved.
    const returned = new Map<string, { quantity: number; lineTotalCents: number }>();
    if (inPeriod.length > 0) {
      const returns = await tx.saleReturn.findMany({ where: { tenantId, status: "approved", saleId: { in: inPeriod.map((s) => s.id) } }, select: { items: true } });
      for (const r of returns) {
        for (const item of asArray<ReturnItemEntry>(r.items)) {
          if (!item.saleItemId) continue;
          const agg = returned.get(item.saleItemId) ?? { quantity: 0, lineTotalCents: 0 };
          agg.quantity += item.quantity ?? 0;
          agg.lineTotalCents += item.lineTotalCents ?? 0;
          returned.set(item.saleItemId, agg);
        }
      }
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const sold = new Map<string, { quantity: number; revenueCents: number }>();
    for (const sale of inPeriod) {
      for (const item of asArray<SaleItemEntry>(sale.items)) {
        const ret = item.id ? returned.get(item.id) : undefined;
        const agg = sold.get(item.productId) ?? { quantity: 0, revenueCents: 0 };
        agg.quantity += item.quantity - (ret?.quantity ?? 0);
        agg.revenueCents += item.lineTotalCents - (ret?.lineTotalCents ?? 0);
        sold.set(item.productId, agg);
      }
    }

    const lastSold = new Map<string, Date>();
    for (const sale of live) {
      if (!sale.completedAt) continue;
      for (const item of asArray<SaleItemEntry>(sale.items)) {
        const prev = lastSold.get(item.productId);
        if (!prev || sale.completedAt > prev) lastSold.set(item.productId, sale.completedAt);
      }
    }

    const bestSelling: ProductPerformanceRow[] = [...sold.entries()]
      .filter(([, agg]) => agg.quantity > 0 || agg.revenueCents !== 0)
      .map(([productId, agg]) => {
        const product = productById.get(productId);
        const costCents = agg.quantity * (product?.buyingPriceCents ?? 0);
        return {
          productId,
          name: product?.name ?? "Unknown product",
          sku: product?.sku ?? "",
          quantitySold: agg.quantity,
          revenueCents: agg.revenueCents,
          costCents,
          profitCents: agg.revenueCents - costCents,
        };
      })
      .sort((a, b) => b.quantitySold - a.quantitySold);

    const now = Date.now();
    const slowMoving: SlowMovingRow[] = products
      .filter((p) => p.status === "active" && p.trackStock)
      .map((p) => {
        const last = lastSold.get(p.id);
        return {
          productId: p.id,
          name: p.name,
          sku: p.sku,
          quantitySoldInPeriod: sold.get(p.id)?.quantity ?? 0,
          daysSinceLastSale: last ? Math.floor((now - last.getTime()) / DAY_MS) : null,
        };
      })
      .sort(
        (a, b) =>
          a.quantitySoldInPeriod - b.quantitySoldInPeriod ||
          (b.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, SLOW_MOVING_LIMIT);

    return { currency: tenant.currency, startDate: parsed.startDate, endDate: parsed.endDate, bestSelling, slowMoving, lookbackDays: LAST_SOLD_LOOKBACK_DAYS };
  });
}
