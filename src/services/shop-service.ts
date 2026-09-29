import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/http-error.js";
import { readTemplateId, readThemeColors } from "../lib/storefront-templates.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import type { ShopContext } from "../middleware/shop-tenant.js";
import type { CatalogQuery } from "../schemas/shop.js";
import {
  activeSharedVariants,
  parseVariantConfig,
  parseVariantOptions,
  sharedVariantPrice,
  variantLabel,
  type VariantOption,
} from "../lib/variants.js";

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
  /** Set when the product has variants (lib/variants.ts): how many, and the price range across
   * them — cards show "From …" and send the shopper to the product page to choose. */
  variantSummary: { count: number; minPriceCents: number; maxPriceCents: number } | null;
  /** Product page only (null in listings): every variant with its own price and stock. */
  variants: ShopVariants | null;
};

export type ShopVariant = {
  /** shared stock: the variant's key · separate stock: the variant product's id */
  key: string;
  /** the product to order — the same product for shared stock, the variant's own for separate */
  productId: string;
  /** what the cart line is called: the product's name (shared) or the variant product's own name */
  name: string;
  label: string;
  values: Record<string, string>;
  priceCents: number;
  compareAtPriceCents: number | null;
  stock: StockBadge;
};

export type ShopVariants = {
  mode: "shared" | "separate";
  title: string | null;
  options: VariantOption[];
  /** separate stock: the variant this page is (its product id) · shared: null (shopper picks) */
  selectedKey: string | null;
  variants: ShopVariant[];
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
    variantSummary: null,
    variants: null,
  };
}

/** Only the option values some variant actually has, in the option's own order — so the website
 * never offers a value nothing can be bought in. */
function usedOptions(options: VariantOption[], variants: Array<{ values: Record<string, string> }>): VariantOption[] {
  return options
    .map((o) => ({ name: o.name, values: o.values.filter((v) => variants.some((x) => x.values[o.name] === v)) }))
    .filter((o) => o.values.length > 0);
}

function summaryOf(prices: number[]): { count: number; minPriceCents: number; maxPriceCents: number } {
  return { count: prices.length, minPriceCents: Math.min(...prices), maxPriceCents: Math.max(...prices) };
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
    const liteRows = (
      await tx.product.findMany({
        where,
        orderBy: { name: "asc" },
        select: {
          id: true,
          onlinePriceCents: true,
          sellingPriceCents: true,
          localCreatedAt: true,
          brand: true,
          variantGroupId: true,
          variantConfigJson: true,
        },
      })
    ).map((r) => {
      // A shared-stock product is priced by its cheapest variant ("From …"); its range is kept.
      const shopper = r.onlinePriceCents ?? r.sellingPriceCents;
      const shared = activeSharedVariants(parseVariantConfig(r.variantConfigJson));
      const prices = shared.length ? shared.map((v) => sharedVariantPrice(v, shopper)) : [shopper];
      return {
        id: r.id,
        groupId: r.variantGroupId,
        prices,
        variantCount: shared.length,
        created: r.localCreatedAt.getTime(),
        brand: r.brand?.trim() || null,
      };
    });

    // Separate-stock variant groups show as ONE card: the group's main product when it's in this
    // set, else its first member; priced by the cheapest member. (Groups are formed within the
    // filtered set, so a search for one size still finds the group.)
    const members = new Map<string, typeof liteRows>();
    for (const r of liteRows) {
      if (r.groupId) members.set(r.groupId, [...(members.get(r.groupId) ?? []), r]);
    }
    const summaryById = new Map<string, { count: number; minPriceCents: number; maxPriceCents: number }>();
    const shown = new Set<string>();
    const lite: Array<{ id: string; price: number; created: number; brand: string | null }> = [];
    for (const r of liteRows) {
      const group = r.groupId ? (members.get(r.groupId) ?? []) : [];
      if (group.length < 2) {
        if (r.variantCount > 0) summaryById.set(r.id, { ...summaryOf(r.prices), count: r.variantCount });
        lite.push({ id: r.id, price: Math.min(...r.prices), created: r.created, brand: r.brand });
        continue;
      }
      if (shown.has(r.groupId!)) continue;
      shown.add(r.groupId!);
      const rep = group.find((m) => m.id === r.groupId) ?? group[0]!;
      const prices = group.flatMap((m) => m.prices);
      summaryById.set(rep.id, { ...summaryOf(prices), count: group.length });
      lite.push({ id: rep.id, price: Math.min(...prices), created: Math.max(...group.map((m) => m.created)), brand: rep.brand });
    }

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
      readStock(tx, rows.map((r) => r.id)),
      categoryNames(tx, rows.map((r) => r.categoryId ?? "")),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      priceRange,
      brands,
      products: rows.map((r) => ({
        ...toCatalogItem(r, stockByProduct.get(r.id) ?? null, r.categoryId ? (names.get(r.categoryId) ?? null) : null),
        variantSummary: summaryById.get(r.id) ?? null,
      })),
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
      readStock(tx, [row.id]),
      categoryNames(tx, [row.categoryId ?? ""]),
    ]);
    const item = toCatalogItem(
      row,
      stockByProduct.get(row.id) ?? null,
      row.categoryId ? (names.get(row.categoryId) ?? null) : null,
    );

    // Shared stock: the variants live on this product.
    const config = parseVariantConfig(row.variantConfigJson);
    const shared = activeSharedVariants(config);
    if (config && shared.length > 0) {
      const variants: ShopVariant[] = shared.map((v) => ({
        key: v.key,
        productId: row.id,
        name: row.name,
        label: variantLabel(config.options, v.values),
        values: v.values,
        priceCents: sharedVariantPrice(v, item.priceCents),
        compareAtPriceCents: null,
        stock: item.stock,
      }));
      item.variants = { mode: "shared", title: config.title, options: usedOptions(config.options, variants), selectedKey: null, variants };
      item.variantSummary = summaryOf(variants.map((v) => v.priceCents));
      return item;
    }

    // Separate stock: every published product of this product's group, this one selected.
    if (row.variantGroupId) {
      const group = await tx.product.findMany({
        where: { variantGroupId: row.variantGroupId, publishedOnline: true, status: "active" },
        orderBy: { name: "asc" },
      });
      if (group.length >= 2) {
        const main =
          group.find((m) => m.id === row.variantGroupId) ??
          (await tx.product.findFirst({ where: { id: row.variantGroupId }, select: { variantConfigJson: true } }));
        const mainConfig = parseVariantConfig(main?.variantConfigJson ?? null);
        const stock = await readStock(tx, group.map((m) => m.id));
        const withValues = group.map((m) => ({ m, values: parseVariantOptions(m.variantOptionsJson) }));
        // options from the main product's config; if it's missing, whatever option names the members carry
        const options: VariantOption[] =
          mainConfig?.options ??
          [...new Set(withValues.flatMap((x) => Object.keys(x.values)))].map((name) => ({
            name,
            values: [...new Set(withValues.map((x) => x.values[name]).filter((v): v is string => Boolean(v)))],
          }));
        const rank = (values: Record<string, string>): number[] =>
          options.map((o) => {
            const i = o.values.indexOf(values[o.name] ?? "");
            return i < 0 ? 999 : i;
          });
        const variants: ShopVariant[] = withValues
          .map(({ m, values }) => {
            const own = toCatalogItem(m, stock.get(m.id) ?? null, null);
            return {
              key: m.id,
              productId: m.id,
              name: m.name,
              label: variantLabel(options, values) || m.name,
              values,
              priceCents: own.priceCents,
              compareAtPriceCents: own.compareAtPriceCents,
              stock: own.stock,
            };
          })
          .sort((a, b) => {
            const ra = rank(a.values);
            const rb = rank(b.values);
            for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
            return 0;
          });
        item.variants = {
          mode: "separate",
          title: mainConfig?.title ?? null,
          options: usedOptions(options, variants),
          selectedKey: row.id,
          variants,
        };
        item.variantSummary = summaryOf(variants.map((v) => v.priceCents));
      }
    }
    return item;
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

/** The TOTAL stock of each product across every location — Main Store plus every branch — from the
 * server-maintained `inventory` table (one grouped query, never a stock_movements aggregation). This
 * is the number the website shows and uses for "in stock / out of stock": a product in the Main Store
 * or at another branch is available to order, exactly as the POS Main Store tab counts it. Which
 * branch the stock is deducted from is decided later, when the shop rings the order up as a sale
 * (the store's fulfilment branch by default). A product with no inventory row anywhere is absent
 * from the map (it then reads as made-to-order, as before). */
async function readStock(tx: Prisma.TransactionClient, productIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (productIds.length === 0) return map;
  const rows = await tx.inventory.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds } },
    _sum: { quantity: true },
  });
  for (const row of rows) map.set(row.productId, row._sum.quantity ?? 0);
  return map;
}
