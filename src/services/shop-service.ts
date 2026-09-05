import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import type { ShopContext } from "../middleware/shop-tenant.js";
import type { CatalogQuery } from "../schemas/shop.js";

// --- Public shapes (what the storefront receives; deliberately a curated subset of the Product
//     row — no cost prices, no supplier data, no local-sourcing flags). ---

export type StockBadge = "in_stock" | "low" | "out_of_stock" | "made_to_order";

export type CatalogItem = {
  id: string;
  name: string;
  shortName: string | null;
  description: string | null;
  priceCents: number;
  wholesalePriceCents: number | null;
  wholesaleMinQuantity: number;
  categoryId: string | null;
  categoryName: string | null;
  unitOfMeasure: string | null;
  images: unknown; // [{ url, thumbUrl }] once the P3 upload pipeline is wired
  stock: StockBadge;
};

export type ShopCategory = { id: string; name: string; count: number };

function toImages(value: Prisma.JsonValue | null): unknown {
  return Array.isArray(value) ? value : [];
}

function stockBadge(
  qty: number | null,
  product: { trackStock: boolean; allowNegativeStock: boolean; reorderLevel: number },
): StockBadge {
  if (!product.trackStock || qty === null) return "made_to_order";
  if (qty <= 0) return product.allowNegativeStock ? "in_stock" : "out_of_stock";
  if (qty <= product.reorderLevel) return "low";
  return "in_stock";
}

type ProductRow = Prisma.ProductGetPayload<Record<string, never>>;

function toCatalogItem(row: ProductRow, qty: number | null, categoryName: string | null): CatalogItem {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    description: row.onlineDescription ?? row.description,
    priceCents: row.onlinePriceCents ?? row.sellingPriceCents,
    wholesalePriceCents: row.wholesalePriceCents,
    wholesaleMinQuantity: row.wholesaleMinQuantity,
    categoryId: row.categoryId,
    categoryName,
    unitOfMeasure: row.unitOfMeasure,
    images: toImages(row.onlineImageUrls),
    stock: stockBadge(qty, row),
  };
}

/** id → name for the given category ids, in one query. */
async function categoryNames(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return map;
  const rows = await tx.category.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  for (const row of rows) map.set(row.id, row.name);
  return map;
}

// --- Store config -----------------------------------------------------------------------------

export async function getStorePayload(ctx: ShopContext) {
  // Tenant is a registry table (not RLS'd) — bare client, same as every other pre-context lookup.
  const tenant = await prisma.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: {
      name: true,
      contactPhone: true,
      contactEmail: true,
      email: true,
      website: true,
      physicalAddress: true,
      cityTown: true,
      countyState: true,
      country: true,
    },
  });

  const address = [tenant?.physicalAddress, tenant?.cityTown, tenant?.countyState, tenant?.country]
    .filter(Boolean)
    .join(", ");

  return {
    name: tenant?.name ?? "Shop",
    currency: ctx.store.currency,
    subdomain: ctx.store.subdomain,
    customDomain: ctx.store.customDomain,
    domainStatus: ctx.store.domainStatus,
    theme: ctx.store.themeJson,
    delivery: ctx.store.deliveryJson,
    paymentOptions: ctx.store.paymentOptionsJson,
    contact: {
      phone: tenant?.contactPhone ?? null,
      email: tenant?.email ?? tenant?.contactEmail ?? null,
      website: tenant?.website ?? null,
      address: address || null,
    },
  };
}

// --- Catalog --------------------------------------------------------------------------------------

export async function listCatalog(ctx: ShopContext, query: CatalogQuery) {
  return withTenantContext(ctx.tenantId, async (tx) => {
    const where: Prisma.ProductWhereInput = {
      publishedOnline: true,
      status: "active",
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { sku: { contains: query.search, mode: "insensitive" } },
              { barcode: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      tx.product.count({ where }),
      tx.product.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const [stockByProduct, names] = await Promise.all([
      readStock(tx, ctx.store.fulfilmentLocationId, rows.map((r) => r.id)),
      categoryNames(tx, rows.map((r) => r.categoryId ?? "")),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      products: rows.map((r) =>
        toCatalogItem(r, stockByProduct.get(r.id) ?? null, r.categoryId ? (names.get(r.categoryId) ?? null) : null),
      ),
    };
  });
}

export async function getProductDetail(ctx: ShopContext, productId: string) {
  return withTenantContext(ctx.tenantId, async (tx) => {
    const row = await tx.product.findFirst({
      where: { id: productId, publishedOnline: true, status: "active" },
    });
    if (!row) {
      throw new HttpError(404, "Product not found");
    }
    const [stockByProduct, names] = await Promise.all([
      readStock(tx, ctx.store.fulfilmentLocationId, [row.id]),
      categoryNames(tx, [row.categoryId ?? ""]),
    ]);
    return toCatalogItem(
      row,
      stockByProduct.get(row.id) ?? null,
      row.categoryId ? (names.get(row.categoryId) ?? null) : null,
    );
  });
}

/** Published-product count per category — feeds the storefront's category grid. */
export async function listCategories(ctx: ShopContext): Promise<ShopCategory[]> {
  return withTenantContext(ctx.tenantId, async (tx) => {
    const grouped = await tx.product.groupBy({
      by: ["categoryId"],
      where: { publishedOnline: true, status: "active", categoryId: { not: null } },
      _count: { _all: true },
    });

    const ids = grouped.map((g) => g.categoryId).filter((id): id is string => Boolean(id));
    const names = await categoryNames(tx, ids);

    return grouped
      .map((g) => ({
        id: g.categoryId as string,
        name: names.get(g.categoryId as string) ?? "Uncategorised",
        count: g._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  });
}

/** Reads the server-maintained `inventory` table (see migration 20260831210000) for the store's
 * fulfilment location — O(1) per product, never a stock_movements aggregation. Returns an empty
 * map when the store has no fulfilment location set yet (everything then reads as made-to-order). */
async function readStock(
  tx: Prisma.TransactionClient,
  locationId: string | null,
  productIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!locationId || productIds.length === 0) return map;
  const rows = await tx.inventory.findMany({
    where: { locationId, productId: { in: productIds } },
    select: { productId: true, quantity: true },
  });
  for (const row of rows) map.set(row.productId, row.quantity);
  return map;
}
