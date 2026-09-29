import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/http-error.js";
import { readTemplateId, readThemeColors } from "../lib/storefront-templates.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import type { ShopContext } from "../middleware/shop-tenant.js";
import type { CatalogQuery } from "../schemas/shop.js";

// --- Public shapes (what the storefront receives; deliberately a curated subset of the Product
//     row — no cost prices, no supplier data, no local-sourcing flags). ---

export type StockBadge = "in_stock" | "low" | "out_of_stock" | "made_to_order";

export type OnlineContentBlock = {
  type: "paragraph" | "specs" | "notes";
  heading: string | null;
  body: string | null;
  items: string[];
};

export type OnlineContent = {
  quickSpecs: string[];
  blocks: OnlineContentBlock[];
};

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
  /** Every category this product shows under online — its POS `categoryId` plus any online-only
   * extras (`onlineCategoryIds`), deduped. */
  categoryIds: string[];
  unitOfMeasure: string | null;
  images: unknown; // [{ url, thumbUrl }] once the P3 upload pipeline is wired
  /** Rich detail-page content (quick specs + ordered paragraph/specs/notes blocks). */
  content: OnlineContent;
  stock: StockBadge;
  brand: string | null;
  /** online "was" price — only set when it's genuinely above priceCents (a real saving) */
  compareAtPriceCents: number | null;
};

export type ShopCategory = { id: string; name: string; count: number };

function toImages(value: Prisma.JsonValue | null): unknown {
  return Array.isArray(value) ? value : [];
}

/** A JSON column that's meant to be a string array — tolerate anything else as empty. */
function toIdArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0)
    : [];
}

/** Normalise the free-form onlineContentJson blob into the exact OnlineContent shape. Anything
 * malformed degrades to empty rather than throwing on a page render. */
function toOnlineContent(value: Prisma.JsonValue | null): OnlineContent {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const blocksRaw = Array.isArray(o.blocks) ? o.blocks : [];
  const blocks: OnlineContentBlock[] = blocksRaw
    .map((b): OnlineContentBlock | null => {
      const bb = b && typeof b === "object" ? (b as Record<string, unknown>) : {};
      const type = bb.type === "specs" || bb.type === "notes" ? bb.type : "paragraph";
      const heading = typeof bb.heading === "string" && bb.heading.trim() ? bb.heading.trim() : null;
      const body = typeof bb.body === "string" && bb.body.trim() ? bb.body.trim() : null;
      const items = toStringList(bb.items);
      if (type === "specs" ? items.length === 0 : !body) return null;
      return { type, heading, body, items };
    })
    .filter((b): b is OnlineContentBlock => b !== null)
    .slice(0, 12);
  return { quickSpecs: toStringList(o.quickSpecs).slice(0, 20), blocks };
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
  const extra = toIdArray(row.onlineCategoryIds);
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
    categoryIds: [...new Set([...(row.categoryId ? [row.categoryId] : []), ...extra])],
    unitOfMeasure: row.unitOfMeasure,
    images: toImages(row.onlineImageUrls),
    content: toOnlineContent(row.onlineContentJson),
    stock: stockBadge(qty, row),
    brand: row.brand?.trim() || null,
    compareAtPriceCents:
      row.onlineCompareAtPriceCents && row.onlineCompareAtPriceCents > (row.onlinePriceCents ?? row.sellingPriceCents)
        ? row.onlineCompareAtPriceCents
        : null,
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
    // Look & feel (admin-set) — the storefront picks its template module + CSS colour tokens off these.
    template: readTemplateId(ctx.store.templateId),
    colors: readThemeColors(ctx.store.themeColorsJson),
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
    // AND of independent OR-groups: [published+active] AND [in this category, POS or online-extra]
    // AND [matches the search term].
    const and: Prisma.ProductWhereInput[] = [{ publishedOnline: true, status: "active" }];
    if (query.categoryId) {
      and.push({
        OR: [
          { categoryId: query.categoryId },
          { onlineCategoryIds: { array_contains: query.categoryId } },
        ],
      });
    }
    if (query.search) {
      and.push({
        OR: [
          { name: { contains: query.search, mode: "insensitive" } },
          { sku: { contains: query.search, mode: "insensitive" } },
          { barcode: { contains: query.search, mode: "insensitive" } },
        ],
      });
    }
    const where: Prisma.ProductWhereInput = { AND: and };

    // The price a shopper sees is `onlinePriceCents ?? sellingPriceCents` — a coalesce Prisma can't
    // sort or range-filter on. So: one light pass over the matching set (id + the fields that order
    // it; the public catalog is small), sort/filter here, then load full rows for just this page.
    // Rows come back name-ordered by the DB, so "featured" keeps exactly the order it always had.
    const lite = (
      await tx.product.findMany({
        where,
        orderBy: { name: "asc" },
        select: { id: true, onlinePriceCents: true, sellingPriceCents: true, localCreatedAt: true, brand: true },
      })
    ).map((r) => ({
      id: r.id,
      price: r.onlinePriceCents ?? r.sellingPriceCents,
      created: r.localCreatedAt.getTime(),
      brand: r.brand?.trim() || null,
    }));

    // Bounds BEFORE the price filter, so a price slider's range doesn't collapse onto the selection.
    const priceRange = lite.length
      ? { minCents: Math.min(...lite.map((r) => r.price)), maxCents: Math.max(...lite.map((r) => r.price)) }
      : null;

    const inPrice = lite.filter(
      (r) =>
        (query.minPriceCents === undefined || r.price >= query.minPriceCents) &&
        (query.maxPriceCents === undefined || r.price <= query.maxPriceCents),
    );
    // Brand facet: counts over everything else that's selected (category/search/price), but NOT the
    // brand filter itself — so picking one brand still lists the others to switch to.
    const brandCounts = new Map<string, { name: string; count: number }>();
    for (const r of inPrice) {
      if (!r.brand) continue;
      const key = r.brand.toLowerCase();
      const hit = brandCounts.get(key);
      if (hit) hit.count++;
      else brandCounts.set(key, { name: r.brand, count: 1 });
    }
    const brands = [...brandCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const wantBrand = query.brand?.toLowerCase();
    let matched = wantBrand ? inPrice.filter((r) => r.brand?.toLowerCase() === wantBrand) : inPrice;
    // Array.prototype.sort is stable → ties keep the name order.
    if (query.sort === "price-asc") matched = [...matched].sort((a, b) => a.price - b.price);
    else if (query.sort === "price-desc") matched = [...matched].sort((a, b) => b.price - a.price);
    else if (query.sort === "newest") matched = [...matched].sort((a, b) => b.created - a.created);

    const total = matched.length;
    const pageIds = matched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((r) => r.id);
    const byId = new Map(
      (pageIds.length ? await tx.product.findMany({ where: { id: { in: pageIds } } }) : []).map((r) => [r.id, r]),
    );
    const rows = pageIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });

    const [stockByProduct, names] = await Promise.all([
      readStock(tx, ctx.store.fulfilmentLocationId, rows.map((r) => r.id)),
      categoryNames(tx, rows.map((r) => r.categoryId ?? "")),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      priceRange,
      brands,
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

export type DeliveryOption = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
};

/** Active storefront delivery options, in display order — the checkout's "Shipping method" list. */
export async function listDeliveryMethods(ctx: ShopContext): Promise<DeliveryOption[]> {
  return withTenantContext(ctx.tenantId, async (tx) => {
    const rows = await tx.webDeliveryMethod.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }, { name: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      priceCents: r.priceCents,
    }));
  });
}

/** Published-product count per category — feeds the storefront's category grid. Counts a product
 * under its POS `categoryId` AND every id in `onlineCategoryIds` (a product in "Aerials" +
 * "Best Sellers" counts once for each). Can't be a groupBy because of the JSON array — one scan of
 * the published set (bounded) and tally in memory. */
export async function listCategories(ctx: ShopContext): Promise<ShopCategory[]> {
  return withTenantContext(ctx.tenantId, async (tx) => {
    const rows = await tx.product.findMany({
      where: { publishedOnline: true, status: "active" },
      select: { categoryId: true, onlineCategoryIds: true },
    });

    const counts = new Map<string, number>();
    for (const r of rows) {
      const ids = new Set<string>();
      if (r.categoryId) ids.add(r.categoryId);
      for (const id of toIdArray(r.onlineCategoryIds)) ids.add(id);
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const names = await categoryNames(tx, [...counts.keys()]);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: names.get(id) ?? "Uncategorised", count }))
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
