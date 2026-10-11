import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError } from "./http-error.js";

/** Same id as mobile-checkout-service.ts's OWNER_APP_DEVICE_ID — duplicated (not imported) so this
 * lib module never depends on a service module. */
const OWNER_APP_DEVICE_ID = "owner-app";

export type InvoiceStockSource = "storefront" | "main_store";

/**
 * Turns an invoice's requested stock source into the Sale.stockLocationId to store: null for the
 * selling storefront itself (today's behaviour), or the tenant's Main Store id. "main_store" is
 * refused unless the tenant's admin toggle (Tenant.invoiceStockFromMainStore) is on — the APP only
 * shows the picker in that case, this is the server-side enforcement. Mirrors DESKTOP's own
 * resolveInvoiceStockLocationId (invoice-service.ts).
 */
export async function resolveInvoiceStockLocationId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  source: InvoiceStockSource,
): Promise<string | null> {
  if (source === "storefront") return null;
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { invoiceStockFromMainStore: true } });
  if (!tenant.invoiceStockFromMainStore) {
    throw new HttpError(403, "Selling invoice stock from the Main Store isn't enabled for this business");
  }
  // Mirrors DESKTOP's findMainStoreLocationRow — only "distribution_center" is used at runtime.
  const mainStore = await tx.location.findFirst({ where: { tenantId, locationType: "distribution_center" }, select: { id: true } });
  if (!mainStore) throw new HttpError(400, "This business has no Main Store set up");
  return mainStore.id;
}

/** "storefront" | "main_store" for a stored Sale row — what the APP's edit form pre-selects. */
export function invoiceStockSourceOf(row: { stockLocationId: string | null }): InvoiceStockSource {
  return row.stockLocationId ? "main_store" : "storefront";
}

/** What a Main-Store-sourced invoice at `storefrontId` could actually draw per product: that
 * storefront's own earmark + the unallocated pool (never another storefront's earmark) — the same
 * figure deductInvoiceStock validates against. Backs the quotation stock check's "main_store" mode. */
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

type StockLine = { productId: string; quantity: number };

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
      // syncedAt set explicitly — see mobile-invoices-service.ts updateInvoice's own note: Prisma
      // only applies @default(now()) on create, and DESKTOP pulls by syncedAt.
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

/**
 * Deducts an invoice's stock-tracked lines from wherever the invoice draws stock (see
 * resolveInvoiceStockLocationId). Storefront: one plain "sale" movement per line, exactly today's
 * behaviour. Main Store: mirrors DESKTOP's distributeMainStoreStockCore draw order — the selling
 * storefront's own earmark FIRST, then the unallocated pool, never another storefront's earmark —
 * writing one movement per bucket drawn from (allocationStorefrontId set, allocationExplicit true)
 * and decrementing the earmark row, so the Main Store breakdown stays in lockstep with its total on
 * every device after sync.
 *
 * `lines` must already be filtered to trackStock && !isLocallySourced (prepareMobileCart's own
 * stockMovementRows are exactly that, as positive quantities here).
 */
export async function deductInvoiceStock(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    storefrontId: string;
    stockLocationId: string | null;
    lines: StockLine[];
    referenceId: string;
    now: Date;
  },
): Promise<void> {
  const { tenantId, employeeId, storefrontId, stockLocationId, lines, referenceId, now } = params;
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

  if (!stockLocationId) {
    await tx.stockMovement.createMany({
      data: lines.map((line) => ({
        ...base,
        id: randomUUID(),
        productId: line.productId,
        locationId: storefrontId,
        quantityChange: -line.quantity,
        allocationExplicit: false,
      })),
    });
    return;
  }

  // Two lines of the same product (e.g. two colours of a shared-stock product) draw from ONE balance.
  const requestedByProduct = new Map<string, number>();
  for (const line of lines) requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0) + line.quantity);
  const productIds = [...requestedByProduct.keys()];

  const [products, balances, allocations] = await Promise.all([
    tx.product.findMany({ where: { id: { in: productIds }, tenantId }, select: { id: true, name: true, allowNegativeStock: true } }),
    tx.inventory.findMany({ where: { tenantId, locationId: stockLocationId, productId: { in: productIds } }, select: { productId: true, quantity: true } }),
    tx.mainStoreAllocation.findMany({ where: { tenantId, productId: { in: productIds }, storefrontId: { not: null } }, select: { productId: true, storefrontId: true, quantity: true } }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const totalByProduct = new Map(balances.map((b) => [b.productId, b.quantity]));

  const movements: Prisma.StockMovementCreateManyInput[] = [];
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
    const common = { ...base, productId, locationId: stockLocationId, allocationExplicit: true };
    if (fromEarmark > 0) {
      movements.push({ ...common, id: randomUUID(), quantityChange: -fromEarmark, allocationStorefrontId: storefrontId });
      await adjustEarmark(tx, tenantId, productId, storefrontId, -fromEarmark, now);
    }
    if (fromUnallocated > 0) {
      movements.push({ ...common, id: randomUUID(), quantityChange: -fromUnallocated, allocationStorefrontId: null });
    }
  }
  if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
}

/**
 * Puts an invoice's stock back where it came from — the reverse of deductInvoiceStock. Storefront:
 * one plain "return" movement per line (today's behaviour). Main Store: credited back into the
 * selling storefront's own earmark, same as DESKTOP's returnToMainStore ("still logically earmarked
 * for them, just physically back at Main Store") and DESKTOP's own restockInvoiceStock.
 *
 * Filters to trackStock && !isLocallySourced itself — a locally-sourced or untracked line was never
 * deducted, so crediting it back would fabricate stock.
 */
export async function restockInvoiceStock(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    storefrontId: string;
    stockLocationId: string | null;
    items: Array<{ productId: string; quantity: number; isLocallySourced: boolean }>;
    referenceType: string;
    referenceId: string;
    now: Date;
  },
): Promise<void> {
  const { tenantId, employeeId, storefrontId, stockLocationId, items, referenceType, referenceId, now } = params;
  const restockRows = items.filter((item) => !item.isLocallySourced);
  if (restockRows.length === 0) return;

  const trackedProducts = await tx.product.findMany({
    where: { id: { in: restockRows.map((i) => i.productId) }, trackStock: true },
    select: { id: true },
  });
  const trackedIds = new Set(trackedProducts.map((p) => p.id));
  const restockMovements = restockRows.filter((item) => trackedIds.has(item.productId));
  if (restockMovements.length === 0) return;

  await tx.stockMovement.createMany({
    data: restockMovements.map((item) => ({
      id: randomUUID(),
      tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      productId: item.productId,
      locationId: stockLocationId ?? storefrontId,
      movementType: "return",
      quantityChange: item.quantity,
      referenceType,
      referenceId,
      performedBy: employeeId,
      allocationStorefrontId: stockLocationId ? storefrontId : null,
      allocationExplicit: Boolean(stockLocationId),
      localCreatedAt: now,
      localUpdatedAt: now,
    })),
  });

  if (stockLocationId) {
    for (const item of restockMovements) {
      await adjustEarmark(tx, tenantId, item.productId, storefrontId, item.quantity, now);
    }
  }
}
