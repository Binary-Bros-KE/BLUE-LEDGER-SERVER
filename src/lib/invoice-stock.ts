import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError } from "./http-error.js";

/** Same id as mobile-checkout-service.ts's OWNER_APP_DEVICE_ID — duplicated (not imported) so this
 * lib module never depends on a service module. */
const OWNER_APP_DEVICE_ID = "owner-app";

export type InvoiceStockSource = "storefront" | "main_store";

/**
 * Stock source is chosen PER INVOICE LINE (client request — one invoice can mix storefront and Main
 * Store lines), stored on each line as items[].stockLocationId: null = the selling storefront (today's
 * behaviour), otherwise the tenant's Main Store id. "main_store" is refused unless the tenant's admin
 * toggle (Tenant.invoiceStockFromMainStore) is on — the APP only shows the picker in that case, this
 * is the enforcement. Mirrors DESKTOP's invoice-stock.ts.
 *
 * Sale.stockLocationId (the earlier whole-invoice version of this feature) is no longer written; it's
 * only read as the fallback for lines saved before items carried their own stockLocationId — see
 * lineStockLocationId below.
 */
async function findMainStoreId(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { invoiceStockFromMainStore: true } });
  if (!tenant.invoiceStockFromMainStore) {
    throw new HttpError(403, "Selling invoice stock from the Main Store isn't enabled for this business");
  }
  // Mirrors DESKTOP's findMainStoreLocationRow — only "distribution_center" is used at runtime.
  const mainStore = await tx.location.findFirst({ where: { tenantId, locationType: "distribution_center" }, select: { id: true } });
  if (!mainStore) throw new HttpError(400, "This business has no Main Store set up");
  return mainStore.id;
}

/** Resolves one stock source per line into the stockLocationId each line stores (null = storefront).
 * The Main Store (and the admin toggle) is only looked up when at least one line actually asks for it. */
export async function resolveLineStockLocationIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sources: InvoiceStockSource[],
): Promise<Array<string | null>> {
  if (!sources.includes("main_store")) return sources.map(() => null);
  const mainStoreId = await findMainStoreId(tx, tenantId);
  return sources.map((source) => (source === "main_store" ? mainStoreId : null));
}

/** The Main Store id when the admin toggle is on (and one exists), else null — for read-only
 * availability displays that shouldn't throw when the feature is simply off. */
export async function findMainStoreIdIfEnabled(tx: Prisma.TransactionClient, tenantId: string): Promise<string | null> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { invoiceStockFromMainStore: true } });
  if (!tenant.invoiceStockFromMainStore) return null;
  const mainStore = await tx.location.findFirst({ where: { tenantId, locationType: "distribution_center" }, select: { id: true } });
  return mainStore?.id ?? null;
}

/** A stored line's stock location: its own stockLocationId when it carries the key, else the sale's
 * legacy whole-invoice Sale.stockLocationId (lines saved by the first version of this feature). */
export function lineStockLocationId(
  item: { stockLocationId?: string | null },
  sale: { stockLocationId: string | null },
): string | null {
  return item.stockLocationId !== undefined ? item.stockLocationId : sale.stockLocationId;
}

export function stockSourceOfLocation(stockLocationId: string | null): InvoiceStockSource {
  return stockLocationId ? "main_store" : "storefront";
}

/** What a Main-Store-sourced invoice line at `storefrontId` could draw per product: that storefront's
 * own earmark + the unallocated pool (never another storefront's earmark) — the same figure
 * deductInvoiceStock validates against. Backs the quotation stock check's Main Store column. */
export async function mainStoreAvailableForStorefront(
  tx: Prisma.TransactionClient,
  tenantId: string,
  mainStoreId: string,
  storefrontId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const [balances, allocations] = await Promise.all([
    tx.inventory.findMany({ where: { tenantId, locationId: mainStoreId, productId: { in: productIds } }, select: { productId: true, quantity: true } }),
    tx.mainStoreAllocation.findMany({ where: { tenantId, productId: { in: productIds }, storefrontId: { not: null } }, select: { productId: true, storefrontId: true, quantity: true } }),
  ]);
  const totalByProduct = new Map(balances.map((b) => [b.productId, b.quantity]));
  const available = new Map<string, number>();
  for (const productId of productIds) {
    const productAllocations = allocations.filter((a) => a.productId === productId);
    const namedTotal = productAllocations.reduce((sum, a) => sum + a.quantity, 0);
    const earmarked = Math.max(0, productAllocations.find((a) => a.storefrontId === storefrontId)?.quantity ?? 0);
    available.set(productId, earmarked + Math.max(0, (totalByProduct.get(productId) ?? 0) - namedTotal));
  }
  return available;
}

async function adjustEarmark(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  storefrontId: string,
  delta: number,
  now: Date,
): Promise<void> {
  const bucketKey = `${productId}:${storefrontId}`;
  const existing = await tx.mainStoreAllocation.findUnique({ where: { tenantId_bucketKey: { tenantId, bucketKey } } });
  if (existing) {
    await tx.mainStoreAllocation.update({
      where: { id: existing.id },
      // syncedAt set explicitly — Prisma only applies @default(now()) on create, and DESKTOP pulls
      // by syncedAt.
      data: { quantity: existing.quantity + delta, localUpdatedAt: now, syncedAt: now },
    });
  } else if (delta > 0) {
    await tx.mainStoreAllocation.create({
      data: {
        id: `main_store_allocation_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        productId,
        storefrontId,
        quantity: delta,
        bucketKey,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
  }
}

type StockLine = { productId: string; quantity: number; stockLocationId: string | null };

/**
 * Deducts an invoice's stock-tracked lines, each from its own stock location. Storefront lines
 * (stockLocationId null): one plain "sale" movement each, exactly today's behaviour. Main Store lines:
 * mirrors DESKTOP's distributeMainStoreStockCore draw order — the selling storefront's own earmark
 * FIRST, then the unallocated pool, never another storefront's earmark — one movement per bucket
 * drawn from (allocationStorefrontId set, allocationExplicit true), decrementing the earmark row so
 * the Main Store breakdown stays in lockstep with its total on every device after sync.
 *
 * `lines` must already be filtered to trackStock && !isLocallySourced — prepareMobileCart's own
 * stockMovementRows are exactly that (as positive quantities here).
 */
export async function deductInvoiceStock(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    storefrontId: string;
    lines: StockLine[];
    referenceId: string;
    now: Date;
  },
): Promise<void> {
  const { tenantId, employeeId, storefrontId, lines, referenceId, now } = params;
  if (lines.length === 0) return;

  const base = {
    tenantId,
    deviceId: OWNER_APP_DEVICE_ID,
    movementType: "sale",
    referenceType: "invoice",
    referenceId,
    performedBy: employeeId,
    localCreatedAt: now,
    localUpdatedAt: now,
  };
  const movements: Prisma.StockMovementCreateManyInput[] = [];

  for (const line of lines.filter((l) => !l.stockLocationId)) {
    movements.push({ ...base, id: randomUUID(), productId: line.productId, locationId: storefrontId, quantityChange: -line.quantity, allocationExplicit: false });
  }

  const mainStoreLines = lines.filter((l): l is StockLine & { stockLocationId: string } => Boolean(l.stockLocationId));
  if (mainStoreLines.length > 0) {
    const mainStoreId = mainStoreLines[0]!.stockLocationId;
    // Two lines of the same product (e.g. two colours of a shared-stock product) draw from ONE balance.
    const requestedByProduct = new Map<string, number>();
    for (const line of mainStoreLines) requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0) + line.quantity);
    const productIds = [...requestedByProduct.keys()];

    const [products, balances, allocations] = await Promise.all([
      tx.product.findMany({ where: { id: { in: productIds }, tenantId }, select: { id: true, name: true, allowNegativeStock: true } }),
      tx.inventory.findMany({ where: { tenantId, locationId: mainStoreId, productId: { in: productIds } }, select: { productId: true, quantity: true } }),
      tx.mainStoreAllocation.findMany({ where: { tenantId, productId: { in: productIds }, storefrontId: { not: null } }, select: { productId: true, storefrontId: true, quantity: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const totalByProduct = new Map(balances.map((b) => [b.productId, b.quantity]));

    for (const [productId, requested] of requestedByProduct) {
      const product = productById.get(productId);
      if (!product) throw new HttpError(400, "One of the selected products is no longer available");

      const productAllocations = allocations.filter((a) => a.productId === productId);
      const namedTotal = productAllocations.reduce((sum, a) => sum + a.quantity, 0);
      const earmarked = Math.max(0, productAllocations.find((a) => a.storefrontId === storefrontId)?.quantity ?? 0);
      // Unallocated is always derived (Main Store total minus every named earmark), never stored —
      // same rule as DESKTOP's trueUnallocatedQuantity.
      const unallocated = Math.max(0, (totalByProduct.get(productId) ?? 0) - namedTotal);

      if (earmarked + unallocated < requested && !product.allowNegativeStock) {
        throw new HttpError(
          400,
          `Not enough Main Store stock for "${product.name}". Earmarked for this storefront: ${earmarked}, unallocated: ${unallocated}, requested: ${requested}`,
        );
      }

      const fromEarmark = Math.min(earmarked, requested);
      const fromUnallocated = requested - fromEarmark;
      const common = { ...base, productId, locationId: mainStoreId, allocationExplicit: true };
      if (fromEarmark > 0) {
        movements.push({ ...common, id: randomUUID(), quantityChange: -fromEarmark, allocationStorefrontId: storefrontId });
        await adjustEarmark(tx, tenantId, productId, storefrontId, -fromEarmark, now);
      }
      if (fromUnallocated > 0) {
        movements.push({ ...common, id: randomUUID(), quantityChange: -fromUnallocated, allocationStorefrontId: null });
      }
    }
  }

  if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
}

/**
 * Puts an invoice's stock back where each line came from — the reverse of deductInvoiceStock.
 * Storefront lines: a plain "return" movement (today's behaviour). Main Store lines: credited back into
 * the selling storefront's own earmark, same as DESKTOP's returnToMainStore ("still logically
 * earmarked for them, just physically back at Main Store").
 *
 * Filters to trackStock && !isLocallySourced itself — a locally-sourced or untracked line was never
 * deducted, so crediting it back would fabricate stock.
 */
export async function restockInvoiceStock(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    sale: { locationId: string; stockLocationId: string | null };
    items: Array<{ productId: string; quantity: number; isLocallySourced: boolean; stockLocationId?: string | null }>;
    referenceType: string;
    referenceId: string;
    now: Date;
  },
): Promise<void> {
  const { tenantId, employeeId, sale, items, referenceType, referenceId, now } = params;
  const storefrontId = sale.locationId;
  const restockRows = items.filter((item) => !item.isLocallySourced);
  if (restockRows.length === 0) return;

  const trackedProducts = await tx.product.findMany({
    where: { id: { in: restockRows.map((i) => i.productId) }, trackStock: true },
    select: { id: true },
  });
  const trackedIds = new Set(trackedProducts.map((p) => p.id));
  const restockLines = restockRows
    .filter((item) => trackedIds.has(item.productId))
    .map((item) => ({ ...item, from: lineStockLocationId(item, sale) }));
  if (restockLines.length === 0) return;

  await tx.stockMovement.createMany({
    data: restockLines.map((item) => ({
      id: randomUUID(),
      tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      productId: item.productId,
      locationId: item.from ?? storefrontId,
      movementType: "return",
      quantityChange: item.quantity,
      referenceType,
      referenceId,
      performedBy: employeeId,
      allocationStorefrontId: item.from ? storefrontId : null,
      allocationExplicit: Boolean(item.from),
      localCreatedAt: now,
      localUpdatedAt: now,
    })),
  });

  for (const item of restockLines) {
    if (item.from) await adjustEarmark(tx, tenantId, item.productId, storefrontId, item.quantity, now);
  }
}
