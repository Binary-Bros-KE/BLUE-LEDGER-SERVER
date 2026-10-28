import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import {
  dropshipCatalogSyncSchema,
  dropshipConnectionCreateSchema,
  dropshipConnectionUpdateSchema,
} from "../schemas/dropship.js";

/**
 * Dropshipping: a RESELLER tenant whose stock for each linked product always equals its SUPPLIER
 * tenant's live total (every supplier location — branches and Main Store alike). The supplier's own
 * data is ONLY EVER READ here, never written. The reseller's quantity is kept equal by appending
 * plain `adjustment` movements to the reseller's OWN stock_movements ledger at the connection's
 * targetLocationId — so every existing reader (DESKTOP via its normal sync pull, the Owner App, the
 * web store) shows the reflected number with no change of its own, and the reseller's ledger doubles
 * as an audit trail ("Eakha stock 10 → 8").
 *
 * `adjustment` (not a new movement type) on purpose: DESKTOP's stock_movements.movement_type has a
 * hard CHECK constraint, and a pulled row an installed desktop can't insert would wedge its pull.
 *
 * Nothing in this file ever runs for a tenant without dropshippingEnabled + an active connection —
 * see lib/dropship-scheduler.ts for the only caller outside the SUPER_ADMIN routes.
 */

/** Stamped on every row this file writes into a reseller's synced tables — provenance only, same
 * idea as the Owner App's "owner-app". */
export const DROPSHIP_DEVICE_ID = "dropship-sync";

const MOVEMENT_REFERENCE_TYPE = "dropship";

export type DropshipConnectionSummary = {
  id: string;
  supplierTenantId: string;
  supplierName: string;
  targetLocationId: string;
  targetLocationName: string | null;
  status: string;
  autoImport: boolean;
  lastMirroredAt: Date | null;
  lastCatalogSyncAt: Date | null;
  lastError: string | null;
  linkCount: number;
};

export type DropshipOverview = {
  dropshippingEnabled: boolean;
  connections: DropshipConnectionSummary[];
  /** Every other tenant — what the "Add supplier" picker offers. */
  supplierOptions: Array<{ id: string; name: string; slug: string }>;
};

export type DropshipLinkRow = {
  id: string;
  resellerProductId: string;
  supplierProductId: string;
  name: string | null;
  sku: string | null;
  /** The supplier's total the last time the mirror ran. */
  supplierQty: number | null;
  /** The reseller's current quantity at the target location. */
  resellerQty: number;
  lastMirroredAt: Date | null;
};

export type DropshipCatalogResult = {
  linked: number;
  imported: number;
  skipped: Array<{ name: string; reason: string }>;
};

async function requireTenant(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, dropshippingEnabled: true } });
  if (!tenant) throw new NotFoundError("Tenant not found");
  return tenant;
}

async function requireConnection(resellerTenantId: string, connectionId: string) {
  const connection = await prisma.dropshipConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.resellerTenantId !== resellerTenantId) throw new NotFoundError("Dropship connection not found");
  return connection;
}

async function assertResellerLocation(resellerTenantId: string, locationId: string): Promise<void> {
  const location = await withTenantContext(resellerTenantId, (tx) => tx.location.findUnique({ where: { id: locationId }, select: { id: true } }));
  if (!location) throw new HttpError(400, "That location doesn't belong to this store");
}

export async function getOverview(resellerTenantId: string): Promise<DropshipOverview> {
  const tenant = await requireTenant(resellerTenantId);
  const [connections, others] = await Promise.all([
    prisma.dropshipConnection.findMany({
      where: { resellerTenantId },
      include: { supplier: { select: { name: true } }, _count: { select: { links: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tenant.findMany({ where: { id: { not: resellerTenantId } }, select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } }),
  ]);

  const locationNames = new Map(
    (
      await withTenantContext(resellerTenantId, (tx) =>
        tx.location.findMany({ where: { id: { in: connections.map((c) => c.targetLocationId) } }, select: { id: true, locationName: true } }),
      )
    ).map((l) => [l.id, l.locationName]),
  );

  return {
    dropshippingEnabled: tenant.dropshippingEnabled,
    connections: connections.map((c) => ({
      id: c.id,
      supplierTenantId: c.supplierTenantId,
      supplierName: c.supplier.name,
      targetLocationId: c.targetLocationId,
      targetLocationName: locationNames.get(c.targetLocationId) ?? null,
      status: c.status,
      autoImport: c.autoImport,
      lastMirroredAt: c.lastMirroredAt,
      lastCatalogSyncAt: c.lastCatalogSyncAt,
      lastError: c.lastError,
      linkCount: c._count.links,
    })),
    supplierOptions: others,
  };
}

export async function createConnection(resellerTenantId: string, input: unknown): Promise<DropshipOverview> {
  const parsed = dropshipConnectionCreateSchema.parse(input);
  await requireTenant(resellerTenantId);
  if (parsed.supplierTenantId === resellerTenantId) throw new HttpError(400, "A store can't dropship from itself");
  await requireTenant(parsed.supplierTenantId);
  // A two-way pair would have each side endlessly copying the other's number.
  const reverse = await prisma.dropshipConnection.findUnique({
    where: { resellerTenantId_supplierTenantId: { resellerTenantId: parsed.supplierTenantId, supplierTenantId: resellerTenantId } },
  });
  if (reverse) throw new HttpError(400, "That store already dropships from this one — a two-way connection isn't allowed");
  await assertResellerLocation(resellerTenantId, parsed.targetLocationId);

  try {
    await prisma.dropshipConnection.create({ data: { resellerTenantId, ...parsed } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConflictError("This store is already connected to that supplier");
    }
    throw err;
  }
  return getOverview(resellerTenantId);
}

export async function updateConnection(resellerTenantId: string, connectionId: string, input: unknown): Promise<DropshipOverview> {
  const parsed = dropshipConnectionUpdateSchema.parse(input);
  await requireConnection(resellerTenantId, connectionId);
  if (parsed.targetLocationId) await assertResellerLocation(resellerTenantId, parsed.targetLocationId);
  await prisma.dropshipConnection.update({ where: { id: connectionId }, data: parsed });
  return getOverview(resellerTenantId);
}

/** Removes the connection and its links. The reseller's products and their current quantities are
 * left exactly as they are — they simply stop following the supplier. */
export async function deleteConnection(resellerTenantId: string, connectionId: string): Promise<DropshipOverview> {
  await requireConnection(resellerTenantId, connectionId);
  await prisma.dropshipConnection.delete({ where: { id: connectionId } });
  return getOverview(resellerTenantId);
}

export async function listLinks(resellerTenantId: string, connectionId: string): Promise<DropshipLinkRow[]> {
  const connection = await requireConnection(resellerTenantId, connectionId);
  const links = await prisma.dropshipProductLink.findMany({ where: { connectionId } });
  const resellerIds = links.map((l) => l.resellerProductId);
  const [products, balances] = await withTenantContext(resellerTenantId, (tx) =>
    Promise.all([
      tx.product.findMany({ where: { id: { in: resellerIds } }, select: { id: true, name: true, sku: true } }),
      tx.inventory.findMany({
        where: { locationId: connection.targetLocationId, productId: { in: resellerIds } },
        select: { productId: true, quantity: true },
      }),
    ]),
  );
  const productById = new Map(products.map((p) => [p.id, p]));
  const qtyById = new Map(balances.map((b) => [b.productId, b.quantity]));
  return links
    .map((l) => ({
      id: l.id,
      resellerProductId: l.resellerProductId,
      supplierProductId: l.supplierProductId,
      name: productById.get(l.resellerProductId)?.name ?? null,
      sku: productById.get(l.resellerProductId)?.sku ?? null,
      supplierQty: l.lastMirroredQty,
      resellerQty: qtyById.get(l.resellerProductId) ?? 0,
      lastMirroredAt: l.lastMirroredAt,
    }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Stops one product following the supplier; the product and its quantity are left as they are. */
export async function deleteLink(resellerTenantId: string, connectionId: string, linkId: string): Promise<void> {
  await requireConnection(resellerTenantId, connectionId);
  const { count } = await prisma.dropshipProductLink.deleteMany({ where: { id: linkId, connectionId } });
  if (count === 0) throw new NotFoundError("Linked product not found");
}

const norm = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

/**
 * Brings the supplier's active catalogue into the reseller's: each supplier product not yet linked
 * is matched to an existing reseller product (barcode, then SKU, then name — case-insensitive), or,
 * with importMissing, created as a new reseller product (the supplier's selling price as the
 * reseller's starting selling price, the supplier's wholesale price — else its selling price — as the
 * reseller's buying price; the supplier's own buying price is never copied). Idempotent.
 *
 * Every import is checked against ALL of the reseller's products for a SKU/name/barcode clash first:
 * DESKTOP's products table has UNIQUE (tenant_id, sku|name|barcode), so a clashing row would fail to
 * insert on the reseller's devices when pulled. Those are reported as skipped instead.
 */
export async function syncCatalog(connectionId: string, input: unknown): Promise<DropshipCatalogResult> {
  const { importMissing } = dropshipCatalogSyncSchema.parse(input);
  const connection = await prisma.dropshipConnection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new NotFoundError("Dropship connection not found");

  const [supplierProducts, supplierCategories] = await withTenantContext(connection.supplierTenantId, (tx) =>
    Promise.all([
      tx.product.findMany({ where: { status: "active" }, orderBy: { name: "asc" } }),
      tx.category.findMany({ select: { id: true, name: true, color: true, description: true } }),
    ]),
  );
  const supplierCategoryById = new Map(supplierCategories.map((c) => [c.id, c]));

  const result: DropshipCatalogResult = { linked: 0, imported: 0, skipped: [] };

  await withTenantContext(
    connection.resellerTenantId,
    async (tx) => {
      // Serialises with any other catalogue sync of this connection (worker + a dashboard click, or
      // two server instances) so the same product can never be imported twice.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dropship-catalog:${connection.id}`}))`;

      const [allLinks, resellerProducts, resellerCategories] = await Promise.all([
        tx.dropshipProductLink.findMany({
          where: { connection: { resellerTenantId: connection.resellerTenantId } },
          select: { connectionId: true, resellerProductId: true, supplierProductId: true },
        }),
        tx.product.findMany({ select: { id: true, sku: true, name: true, barcode: true } }),
        tx.category.findMany({ select: { id: true, name: true } }),
      ]);

      const linkedSupplierToReseller = new Map(
        allLinks.filter((l) => l.connectionId === connection.id).map((l) => [l.supplierProductId, l.resellerProductId]),
      );
      const takenResellerIds = new Set(allLinks.map((l) => l.resellerProductId));

      const bySku = new Map<string, string>();
      const byName = new Map<string, string>();
      const byBarcode = new Map<string, string>();
      const indexProduct = (p: { id: string; sku: string; name: string; barcode: string | null }) => {
        const sku = norm(p.sku);
        const name = norm(p.name);
        const barcode = norm(p.barcode);
        if (sku) bySku.set(sku, p.id);
        if (name) byName.set(name, p.id);
        if (barcode) byBarcode.set(barcode, p.id);
      };
      resellerProducts.forEach(indexProduct);

      const categoryIdByName = new Map(resellerCategories.map((c) => [norm(c.name) as string, c.id]));
      const now = new Date();

      async function resellerCategoryFor(supplierCategoryId: string | null): Promise<string | null> {
        const source = supplierCategoryId ? supplierCategoryById.get(supplierCategoryId) : undefined;
        if (!source) return null;
        const key = norm(source.name);
        if (!key) return null;
        const existing = categoryIdByName.get(key);
        if (existing) return existing;
        const id = `category_${randomUUID()}`;
        await tx.category.create({
          data: {
            id,
            tenantId: connection!.resellerTenantId,
            deviceId: DROPSHIP_DEVICE_ID,
            parentId: null,
            name: source.name,
            description: source.description,
            color: source.color,
            level: 1,
            sortOrder: 0,
            status: "active",
            localCreatedAt: now,
            localUpdatedAt: now,
          },
        });
        categoryIdByName.set(key, id);
        return id;
      }

      // Separate-stock variant children point at their main product, so mains go first and a
      // child's variantGroupId can be translated to the reseller's own id for that main.
      const ordered = [...supplierProducts].sort((a, b) => Number(Boolean(a.variantGroupId)) - Number(Boolean(b.variantGroupId)));

      for (const source of ordered) {
        if (linkedSupplierToReseller.has(source.id)) continue;

        const barcode = norm(source.barcode);
        const sku = norm(source.sku);
        const name = norm(source.name);
        const match = [barcode && byBarcode.get(barcode), sku && bySku.get(sku), name && byName.get(name)].find(
          (id): id is string => Boolean(id),
        );

        if (match) {
          if (takenResellerIds.has(match)) {
            result.skipped.push({ name: source.name, reason: "Matches a product already linked to another supplier product" });
            continue;
          }
          await tx.dropshipProductLink.create({
            data: { connectionId: connection.id, resellerProductId: match, supplierProductId: source.id },
          });
          linkedSupplierToReseller.set(source.id, match);
          takenResellerIds.add(match);
          result.linked += 1;
          continue;
        }

        if (!importMissing) continue;
        // Matching above already looked up every one of these keys and found nothing, so a new row
        // can't clash with an existing one — barring two supplier products sharing a key, which the
        // supplier's own UNIQUE constraints rule out (re-checked here regardless, after indexing).
        if ((sku && bySku.has(sku)) || (name && byName.has(name)) || (barcode && byBarcode.has(barcode))) {
          result.skipped.push({ name: source.name, reason: "SKU, name or barcode already used by another product" });
          continue;
        }

        const id = `product_${randomUUID()}`;
        const variantGroupId = source.variantGroupId ? (linkedSupplierToReseller.get(source.variantGroupId) ?? null) : null;
        await tx.product.create({
          data: {
            id,
            tenantId: connection.resellerTenantId,
            deviceId: DROPSHIP_DEVICE_ID,
            sku: source.sku,
            barcode: source.barcode,
            supplierSku: source.sku,
            name: source.name,
            shortName: source.shortName,
            description: source.description,
            categoryId: await resellerCategoryFor(source.categoryId),
            storefrontId: null,
            unitOfMeasure: source.unitOfMeasure,
            buyingPriceCents: source.wholesalePriceCents ?? source.sellingPriceCents,
            sellingPriceCents: source.sellingPriceCents,
            wholesalePriceCents: null,
            wholesaleMinQuantity: 0,
            minimumPriceCents: null,
            taxRate: source.taxRate,
            taxType: source.taxType,
            pricesTaxInclusive: source.pricesTaxInclusive,
            reorderLevel: 0,
            trackStock: true,
            allowNegativeStock: false,
            status: "active",
            imagePath: null,
            publishedOnline: false,
            onlineDescription: source.onlineDescription,
            onlineImageUrls: source.onlineImageUrls ?? [],
            onlineCategoryIds: [],
            onlineContentJson: source.onlineContentJson ?? {},
            brand: source.brand,
            variantGroupId,
            variantOptionsJson: variantGroupId ? (source.variantOptionsJson ?? {}) : {},
            variantConfigJson: source.variantConfigJson ?? Prisma.DbNull,
            localCreatedAt: now,
            localUpdatedAt: now,
          },
        });
        await tx.dropshipProductLink.create({
          data: { connectionId: connection.id, resellerProductId: id, supplierProductId: source.id },
        });
        indexProduct({ id, sku: source.sku, name: source.name, barcode: source.barcode });
        linkedSupplierToReseller.set(source.id, id);
        takenResellerIds.add(id);
        result.imported += 1;
      }
    },
    { timeoutMs: 120_000 },
  );

  await prisma.dropshipConnection.update({ where: { id: connection.id }, data: { lastCatalogSyncAt: new Date() } });
  return result;
}

/**
 * One mirror pass: for every linked product, reseller qty at targetLocationId := the supplier's live
 * total across all of its locations (0 if the supplier product is gone or inactive; never negative).
 * Only the difference is written, as one `adjustment` movement per product that actually changed —
 * a pass where nothing moved writes nothing to the ledger. A reseller sale that lowered its own
 * number is simply brought back to the supplier's figure here, since the supplier — not the
 * reseller — is the source of truth for what's physically available.
 */
export async function mirrorConnection(connectionId: string): Promise<{ adjusted: number }> {
  const connection = await prisma.dropshipConnection.findUnique({
    where: { id: connectionId },
    include: { links: true, supplier: { select: { name: true } }, reseller: { select: { dropshippingEnabled: true } } },
  });
  if (!connection || connection.status !== "active" || !connection.reseller.dropshippingEnabled || connection.links.length === 0) {
    return { adjusted: 0 };
  }

  const supplierIds = connection.links.map((l) => l.supplierProductId);
  const supplierTotals = await withTenantContext(connection.supplierTenantId, async (tx) => {
    const [sums, products] = await Promise.all([
      tx.inventory.groupBy({ by: ["productId"], where: { productId: { in: supplierIds } }, _sum: { quantity: true } }),
      tx.product.findMany({ where: { id: { in: supplierIds } }, select: { id: true, status: true } }),
    ]);
    const sumById = new Map(sums.map((s) => [s.productId, s._sum.quantity ?? 0]));
    return new Map(products.map((p) => [p.id, p.status === "active" ? Math.max(0, sumById.get(p.id) ?? 0) : 0]));
  });

  const now = new Date();
  const changedLinks: Array<{ id: string; qty: number }> = [];

  const adjusted = await withTenantContext(connection.resellerTenantId, async (tx) => {
    // Serialises passes for this connection (worker overlap, "Resync now", multiple server
    // instances): the balance is re-read under the lock, so a delta is never applied twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dropship-mirror:${connection.id}`}))`;

    const resellerIds = connection.links.map((l) => l.resellerProductId);
    const [existing, balances] = await Promise.all([
      tx.product.findMany({ where: { id: { in: resellerIds } }, select: { id: true } }),
      tx.inventory.findMany({
        where: { locationId: connection.targetLocationId, productId: { in: resellerIds } },
        select: { productId: true, quantity: true },
      }),
    ]);
    const existingIds = new Set(existing.map((p) => p.id));
    const currentById = new Map(balances.map((b) => [b.productId, b.quantity]));

    const movements: Prisma.StockMovementCreateManyInput[] = [];
    for (const link of connection.links) {
      if (!existingIds.has(link.resellerProductId)) continue;
      const target = supplierTotals.get(link.supplierProductId) ?? 0;
      const current = currentById.get(link.resellerProductId) ?? 0;
      if (link.lastMirroredQty !== target) changedLinks.push({ id: link.id, qty: target });
      if (target === current) continue;
      movements.push({
        id: `movement_${randomUUID()}`,
        tenantId: connection.resellerTenantId,
        deviceId: DROPSHIP_DEVICE_ID,
        productId: link.resellerProductId,
        locationId: connection.targetLocationId,
        movementType: "adjustment",
        quantityChange: target - current,
        referenceType: MOVEMENT_REFERENCE_TYPE,
        referenceId: connection.id,
        performedBy: null,
        notes: `${connection.supplier.name} stock: ${current} → ${target}`,
        previousQuantity: current,
        newQuantity: target,
        localCreatedAt: now,
        localUpdatedAt: now,
      });
    }
    if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
    return movements.length;
  });

  for (const link of changedLinks) {
    await prisma.dropshipProductLink.update({ where: { id: link.id }, data: { lastMirroredQty: link.qty, lastMirroredAt: now } });
  }
  await prisma.dropshipConnection.update({ where: { id: connection.id }, data: { lastMirroredAt: now, lastError: null } });
  return { adjusted };
}

/** Dashboard "Resync now": catalogue (when requested) then an immediate mirror pass. */
export async function resyncConnection(
  resellerTenantId: string,
  connectionId: string,
  input: unknown,
): Promise<{ catalog: DropshipCatalogResult; adjusted: number }> {
  await requireConnection(resellerTenantId, connectionId);
  const catalog = await syncCatalog(connectionId, input);
  const { adjusted } = await mirrorConnection(connectionId);
  return { catalog, adjusted };
}
