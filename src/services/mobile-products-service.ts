import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ConflictError, HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { parseVariantConfig } from "../lib/variants.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import {
  type MobileCreateProductInput,
  type MobileStockAdjustmentInput,
  type MobileUpdateProductInput,
  mobileCreateCategorySchema,
  mobileCreateProductSchema,
  mobileProductStatusSchema,
  mobileStockAdjustmentSchema,
  mobileStockTransferSchema,
  mobileUpdateProductSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

/** Catalog + stock writes for the Owner App's Products tab — the day-to-day subset of DESKTOP's own
 * product-service.ts / category-service.ts / inventory-service.ts recordStockMovement.
 *
 * Same sync contract as every other mobile write: rows land in the EXACT shape DESKTOP's own push
 * produces (`product_`/`category_`/`movement_` id prefixes, uppercased SKU, taxRate kept in step with
 * taxType), stamped deviceId "owner-app" with a fresh localUpdatedAt AND syncedAt so DESKTOP's pull
 * cursor actually sees the change. Products are conflict-aware on DESKTOP (baseUpdatedAt), so a
 * desktop holding its own unsynced edit to the same product gets a normal conflict instead of
 * silently overwriting this one. A product edit only ever writes the fields mobile shows — online
 * store content, variants, image, brand etc. are left exactly as DESKTOP last set them.
 *
 * Stock is never written directly: every change is a StockMovement row, and the `inventory` balance
 * follows via its database trigger (see the Inventory model's own doc comment), exactly like mobile
 * checkout. */

/** Mobile-minted SKUs follow DESKTOP's own device-tagged scheme ("PROD-D1-000042" there,
 * "PROD-M3-000012" here) — the tag alone guarantees a phone and a not-yet-synced desktop can never
 * mint the same SKU. */
const SKU_PREFIX = "PROD";
const SKU_DIGITS = 6;

/** Matches DESKTOP's own CategoryFormModal default tag colour for a quick-created category. */
const DEFAULT_CATEGORY_COLOR = "#2563eb";

const INCREASING_ADD_REASONS = new Set(["purchase", "return", "opening_stock"]);

type ActorScope = { employeeId: string; branchScope: string | null; mobileDeviceSequence: number | null };

/** Same branch-scope rule DESKTOP's product/inventory services apply via getCurrentBranchScope: a
 * Super Admin is never scoped; anyone else with a branch is limited to it. */
async function loadActorScope(tx: Prisma.TransactionClient, session: MobileSession): Promise<ActorScope> {
  const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
  return {
    employeeId: actor.id,
    branchScope: session.isSuperAdmin ? null : actor.branchId,
    mobileDeviceSequence: actor.mobileDeviceSequence,
  };
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

export type MobileCategory = { id: string; name: string };

export async function listCategories(tenantId: string): Promise<MobileCategory[]> {
  return withTenantContext(tenantId, (tx) =>
    tx.category.findMany({ where: { tenantId, status: "active" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );
}

/** Top-level only — sub-categories (DESKTOP supports 3 levels) stay a DESKTOP job. Same duplicate
 * rule as DESKTOP's findSiblingCategoryRow, compared case-insensitively. */
export async function createCategory(tenantId: string, input: unknown): Promise<MobileCategory> {
  const { name } = mobileCreateCategorySchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const duplicate = await tx.category.findFirst({
      where: { tenantId, parentId: null, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError(`A category named "${name}" already exists`);

    const sortOrder = await tx.category.count({ where: { tenantId, parentId: null } });
    return tx.category.create({
      data: {
        id: `category_${randomUUID()}`,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        parentId: null,
        name,
        color: DEFAULT_CATEGORY_COLOR,
        level: 1,
        sortOrder,
        status: "active",
        localCreatedAt: now,
        localUpdatedAt: now,
      },
      select: { id: true, name: true },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export type MobileProductEditData = {
  id: string;
  sku: string;
  status: string;
  name: string;
  barcode: string | null;
  categoryId: string | null;
  storefrontId: string | null;
  unitOfMeasure: string | null;
  description: string | null;
  buyingPriceCents: number;
  sellingPriceCents: number;
  wholesalePriceCents: number | null;
  wholesaleMinQuantity: number;
  minimumPriceCents: number | null;
  taxType: string;
  pricesTaxInclusive: boolean | null;
  reorderLevel: number;
  trackStock: boolean;
  allowNegativeStock: boolean;
  /** True when this product is part of a variant set — APP warns that variants are managed on DESKTOP. */
  hasVariants: boolean;
};

export async function getProductForEdit(tenantId: string, productId: string): Promise<MobileProductEditData> {
  return withTenantContext(tenantId, async (tx) => {
    const p = await tx.product.findUnique({ where: { id: productId } });
    if (!p || p.tenantId !== tenantId) throw new NotFoundError("Product not found");
    return {
      id: p.id,
      sku: p.sku,
      status: p.status,
      name: p.name,
      barcode: p.barcode,
      categoryId: p.categoryId,
      storefrontId: p.storefrontId,
      unitOfMeasure: p.unitOfMeasure,
      description: p.description,
      buyingPriceCents: p.buyingPriceCents,
      sellingPriceCents: p.sellingPriceCents,
      wholesalePriceCents: p.wholesalePriceCents,
      wholesaleMinQuantity: p.wholesaleMinQuantity,
      minimumPriceCents: p.minimumPriceCents,
      taxType: p.taxType,
      pricesTaxInclusive: p.pricesTaxInclusive,
      reorderLevel: p.reorderLevel,
      trackStock: p.trackStock,
      allowNegativeStock: p.allowNegativeStock,
      hasVariants: p.variantGroupId !== null || p.variantConfigJson !== null,
    };
  });
}

async function assertCategoryBelongsToTenant(tx: Prisma.TransactionClient, tenantId: string, categoryId: string | null): Promise<void> {
  if (!categoryId) return;
  const row = await tx.category.findUnique({ where: { id: categoryId }, select: { tenantId: true } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError("Selected category was not found");
}

async function assertLocationBelongsToTenant(tx: Prisma.TransactionClient, tenantId: string, locationId: string | null) {
  if (!locationId) return null;
  const row = await tx.location.findUnique({ where: { id: locationId } });
  if (!row || row.tenantId !== tenantId) throw new NotFoundError("Selected storefront was not found");
  return row;
}

/** Same three checks as DESKTOP's own assertUniqueFields (name, SKU, barcode), case-insensitive. */
async function assertUniqueProductFields(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fields: { name: string; sku: string; barcode: string | null },
  excludeId?: string,
): Promise<void> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  const [byName, bySku, byBarcode] = await Promise.all([
    tx.product.findFirst({ where: { tenantId, ...notSelf, name: { equals: fields.name, mode: "insensitive" } }, select: { id: true } }),
    tx.product.findFirst({ where: { tenantId, ...notSelf, sku: { equals: fields.sku, mode: "insensitive" } }, select: { id: true } }),
    fields.barcode
      ? tx.product.findFirst({ where: { tenantId, ...notSelf, barcode: fields.barcode }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (byName) throw new ConflictError(`A product named "${fields.name}" already exists`);
  if (bySku) throw new ConflictError(`SKU "${fields.sku}" is already in use`);
  if (byBarcode) throw new ConflictError(`Barcode "${fields.barcode}" is already in use`);

  // A shared-stock variant's own SKU/barcode counts too — scanning must land on exactly one thing
  // (DESKTOP's findSharedVariantCodeOwner).
  const withVariants = await tx.product.findMany({
    where: { tenantId, ...notSelf, variantConfigJson: { not: Prisma.DbNull } },
    select: { name: true, variantConfigJson: true },
  });
  const wantedSku = fields.sku.toLowerCase();
  const wantedBarcode = fields.barcode?.toLowerCase() ?? null;
  for (const row of withVariants) {
    const config = parseVariantConfig(row.variantConfigJson);
    if (config?.mode !== "shared") continue;
    if (config.variants.some((v) => v.sku?.toLowerCase() === wantedSku)) {
      throw new ConflictError(`SKU "${fields.sku}" is already used by a variant of "${row.name}"`);
    }
    if (wantedBarcode && config.variants.some((v) => v.barcode?.toLowerCase() === wantedBarcode)) {
      throw new ConflictError(`Barcode "${fields.barcode}" is already used by a variant of "${row.name}"`);
    }
  }
}

/** Fields shared by create and update. taxRate is kept in step with taxType exactly the way DESKTOP's
 * ProductCreateModal does (`taxType === "vat" ? vatRatePercent : 0`) — not the calculation driver
 * any more, but DESKTOP still reads it in a few legacy reports. */
function productWriteFields(parsed: MobileUpdateProductInput, vatRatePercent: number) {
  return {
    name: parsed.name,
    barcode: parsed.barcode,
    categoryId: parsed.categoryId,
    storefrontId: parsed.storefrontId,
    unitOfMeasure: parsed.unitOfMeasure,
    description: parsed.description,
    buyingPriceCents: parsed.buyingPriceCents,
    sellingPriceCents: parsed.sellingPriceCents,
    wholesalePriceCents: parsed.wholesalePriceCents,
    wholesaleMinQuantity: parsed.wholesaleMinQuantity,
    minimumPriceCents: parsed.minimumPriceCents,
    taxType: parsed.taxType,
    taxRate: parsed.taxType === "vat" ? vatRatePercent : 0,
    pricesTaxInclusive: parsed.pricesTaxInclusive,
    reorderLevel: parsed.reorderLevel,
    trackStock: parsed.trackStock,
    allowNegativeStock: parsed.allowNegativeStock,
  };
}

export async function createProduct(session: MobileSession, input: unknown): Promise<{ id: string; sku: string }> {
  const parsed: MobileCreateProductInput = mobileCreateProductSchema.parse(input);
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const actor = await loadActorScope(tx, session);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true } });

    // DESKTOP's assertProductStorefrontCreateAllowed rejects anything but the caller's own branch;
    // here that's simply applied for them — there's nothing else a scoped caller could pick.
    const storefrontId = actor.branchScope ?? parsed.storefrontId;
    await assertCategoryBelongsToTenant(tx, tenantId, parsed.categoryId);
    await assertLocationBelongsToTenant(tx, tenantId, storefrontId);

    let sku = parsed.sku;
    if (!sku) {
      const sequence = await ensureEmployeeMobileSequence(tx, tenantId, actor.employeeId, actor.mobileDeviceSequence);
      sku = await mintMobileDocumentNumber(tx, tenantId, sequence, SKU_PREFIX, SKU_DIGITS);
    }
    await assertUniqueProductFields(tx, tenantId, { name: parsed.name, sku, barcode: parsed.barcode });

    const productId = `product_${randomUUID()}`;
    await tx.product.create({
      data: {
        id: productId,
        tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        sku,
        status: "active",
        ...productWriteFields({ ...parsed, storefrontId }, tenant.vatRatePercent),
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });

    if (parsed.openingStock && parsed.trackStock) {
      const location = await assertStockLocationAllowed(tx, tenantId, parsed.openingStock.locationId, actor.branchScope);
      await writeStockMovement(tx, {
        tenantId,
        productId,
        locationId: location.id,
        movementType: "opening_stock",
        quantityChange: parsed.openingStock.quantity,
        previousQuantity: 0,
        referenceType: "product_creation",
        referenceId: productId,
        performedBy: actor.employeeId,
        notes: null,
        id: `movement_${randomUUID()}`,
        now,
      });
    }

    return { id: productId, sku };
  });
}

export async function updateProduct(session: MobileSession, productId: string, input: unknown): Promise<{ id: string }> {
  const parsed: MobileUpdateProductInput = mobileUpdateProductSchema.parse(input);
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.product.findUnique({ where: { id: productId } });
    if (!existing || existing.tenantId !== tenantId) throw new NotFoundError("Product not found");

    const actor = await loadActorScope(tx, session);
    // DESKTOP's assertProductStorefrontUpdateAllowed: leaving it as-is is always fine; changing it is
    // only allowed to the scoped caller's own branch.
    if (actor.branchScope && parsed.storefrontId !== existing.storefrontId && parsed.storefrontId !== actor.branchScope) {
      throw new HttpError(403, "You can only assign products to your own storefront");
    }
    await assertCategoryBelongsToTenant(tx, tenantId, parsed.categoryId);
    await assertLocationBelongsToTenant(tx, tenantId, parsed.storefrontId);

    // SKU is editable (same as DESKTOP) but never blanked — an empty field keeps the current one.
    const sku = parsed.sku ?? existing.sku;
    await assertUniqueProductFields(tx, tenantId, { name: parsed.name, sku, barcode: parsed.barcode }, productId);

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { vatRatePercent: true } });
    await tx.product.update({
      where: { id: productId },
      data: {
        sku,
        ...productWriteFields(parsed, tenant.vatRatePercent),
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id: productId };
  });
}

/** Archive ("inactive") / restore — DESKTOP's own setProductStatus. Never a hard delete: a synced
 * product is referenced by sales, purchases and the stock ledger. */
export async function setProductStatus(tenantId: string, productId: string, input: unknown): Promise<{ id: string }> {
  const { status } = mobileProductStatusSchema.parse(input);
  const now = new Date();
  return withTenantContext(tenantId, async (tx) => {
    const existing = await tx.product.findUnique({ where: { id: productId }, select: { tenantId: true } });
    if (!existing || existing.tenantId !== tenantId) throw new NotFoundError("Product not found");
    await tx.product.update({
      where: { id: productId },
      data: { status, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: productId };
  });
}

// ---------------------------------------------------------------------------------------------
// Stock adjustments
// ---------------------------------------------------------------------------------------------

/** DESKTOP's assertOpeningStockLocationsAllowed rule, applied to every mobile stock change: a
 * branch-scoped caller may only touch their own storefront or the Main Store. */
async function assertStockLocationAllowed(tx: Prisma.TransactionClient, tenantId: string, locationId: string, branchScope: string | null) {
  const location = await assertLocationBelongsToTenant(tx, tenantId, locationId);
  if (!location) throw new NotFoundError("Selected location was not found");
  if (location.status !== "active") throw new HttpError(400, `"${location.locationName}" is not active`);
  if (branchScope && location.id !== branchScope && location.locationType !== "distribution_center") {
    throw new HttpError(403, "You can only change stock at your own storefront or the Main Store");
  }
  return location;
}

async function writeStockMovement(
  tx: Prisma.TransactionClient,
  m: {
    id: string;
    tenantId: string;
    productId: string;
    locationId: string;
    movementType: string;
    quantityChange: number;
    previousQuantity: number;
    referenceType: string | null;
    referenceId: string | null;
    performedBy: string;
    notes: string | null;
    now: Date;
  },
): Promise<void> {
  await tx.stockMovement.create({
    data: {
      id: m.id,
      tenantId: m.tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      productId: m.productId,
      locationId: m.locationId,
      movementType: m.movementType,
      quantityChange: m.quantityChange,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      performedBy: m.performedBy,
      notes: m.notes,
      allocationExplicit: false,
      previousQuantity: m.previousQuantity,
      newQuantity: m.previousQuantity + m.quantityChange,
      // Immutable row — DESKTOP sends localCreatedAt for both, same here (see StockMovement's comment).
      localCreatedAt: m.now,
      localUpdatedAt: m.now,
    },
  });
}

/**
 * DESKTOP's applyValidatedStockMovement rule for any decrease: a location can't go below zero unless
 * the product allows negative stock, and at the Main Store only the UNALLOCATED pool counts (plain
 * total minus every storefront's named earmark — DESKTOP's trueUnallocatedQuantity), so the phone can
 * never take stock a Storekeeper already earmarked for a shop.
 */
async function assertCanDecrease(
  tx: Prisma.TransactionClient,
  tenantId: string,
  product: { id: string; name: string; allowNegativeStock: boolean },
  location: { locationName: string; locationType: string },
  currentQuantity: number,
  decrease: number,
): Promise<void> {
  if (product.allowNegativeStock) return;
  let available = currentQuantity;
  if (location.locationType === "distribution_center") {
    const earmarked = await tx.mainStoreAllocation.aggregate({
      where: { tenantId, productId: product.id, storefrontId: { not: null } },
      _sum: { quantity: true },
    });
    available = Math.max(0, currentQuantity - (earmarked._sum.quantity ?? 0));
  }
  if (available - decrease < 0) {
    throw new HttpError(400, `Insufficient stock for "${product.name}" at ${location.locationName}. Available: ${available}, requested: ${decrease}`);
  }
}

export type MobileStockAdjustmentResult = { id: string; previousQuantity: number; newQuantity: number };

/**
 * Add / remove / count — see mobileStockAdjustmentSchema for how `mode` maps onto DESKTOP's own
 * movement types. Validation mirrors DESKTOP's applyValidatedStockMovement: a decrease can't push
 * the location below zero unless the product allows negative stock, and at the Main Store a
 * decrease is checked against the UNALLOCATED pool only (plain total minus every storefront's named
 * earmark — DESKTOP's own trueUnallocatedQuantity), so a phone can never consume stock a
 * Storekeeper already earmarked for a shop. Idempotent on `id` like mobile checkout.
 */
export async function recordStockAdjustment(session: MobileSession, input: unknown): Promise<MobileStockAdjustmentResult> {
  const parsed: MobileStockAdjustmentInput = mobileStockAdjustmentSchema.parse(input);
  const movementId = parsed.id.startsWith("movement_") ? parsed.id : `movement_${parsed.id}`;
  const now = new Date();
  const { tenantId } = session;

  return withTenantContext(tenantId, async (tx) => {
    const existingMovement = await tx.stockMovement.findUnique({ where: { id: movementId } });
    if (existingMovement) {
      return {
        id: existingMovement.id,
        previousQuantity: existingMovement.previousQuantity ?? 0,
        newQuantity: existingMovement.newQuantity ?? 0,
      };
    }

    const actor = await loadActorScope(tx, session);
    const product = await tx.product.findUnique({ where: { id: parsed.productId } });
    if (!product || product.tenantId !== tenantId) throw new NotFoundError("Product not found");
    if (!product.trackStock) throw new HttpError(400, `"${product.name}" doesn't track stock`);
    const location = await assertStockLocationAllowed(tx, tenantId, parsed.locationId, actor.branchScope);

    const balance = await tx.inventory.findUnique({
      where: { productId_locationId: { productId: product.id, locationId: location.id } },
      select: { quantity: true },
    });
    const currentQuantity = balance?.quantity ?? 0;

    let movementType: string;
    let quantityChange: number;
    if (parsed.mode === "add") {
      movementType = parsed.addReason && INCREASING_ADD_REASONS.has(parsed.addReason) ? parsed.addReason : "purchase";
      quantityChange = parsed.quantity;
    } else if (parsed.mode === "remove") {
      movementType = "damage";
      quantityChange = -parsed.quantity;
    } else {
      movementType = "adjustment";
      quantityChange = parsed.quantity - currentQuantity;
      if (quantityChange === 0) throw new HttpError(400, `Stock at ${location.locationName} is already ${currentQuantity} — nothing to adjust`);
    }

    if (quantityChange < 0) await assertCanDecrease(tx, tenantId, product, location, currentQuantity, -quantityChange);

    await writeStockMovement(tx, {
      id: movementId,
      tenantId,
      productId: product.id,
      locationId: location.id,
      movementType,
      quantityChange,
      previousQuantity: currentQuantity,
      referenceType: null,
      referenceId: null,
      performedBy: actor.employeeId,
      notes: parsed.notes,
      now,
    });

    return { id: movementId, previousQuantity: currentQuantity, newQuantity: currentQuantity + quantityChange };
  });
}

// ---------------------------------------------------------------------------------------------
// Stock transfers
// ---------------------------------------------------------------------------------------------

export type MobileStockTransferResult = { transferId: string; lineCount: number };

/**
 * Moves stock between two locations — DESKTOP's recordStockTransfer, one product per pair of rows
 * ("transfer_out" at the source, "transfer_in" at the destination, sharing referenceId), several
 * products per mobile transfer all under one transfer id. Each decrease is validated exactly like a
 * manual removal (assertCanDecrease). A branch-scoped employee can only send stock FROM their own
 * storefront or the Main Store (DESKTOP's opening-stock boundary) — never take another branch's.
 * Idempotent on the client-minted id: a retry finds its rows already written and returns.
 */
export async function recordStockTransfer(session: MobileSession, input: unknown): Promise<MobileStockTransferResult> {
  const parsed = mobileStockTransferSchema.parse(input);
  const transferId = parsed.id.startsWith("transfer_") ? parsed.id : `transfer_${parsed.id}`;
  const { tenantId } = session;
  const now = new Date();

  return withTenantContext(tenantId, async (tx) => {
    const already = await tx.stockMovement.count({ where: { tenantId, referenceType: "transfer", referenceId: transferId } });
    if (already > 0) return { transferId, lineCount: already / 2 };

    const actor = await loadActorScope(tx, session);
    const from = await assertStockLocationAllowed(tx, tenantId, parsed.fromLocationId, actor.branchScope);
    const to = await assertLocationBelongsToTenant(tx, tenantId, parsed.toLocationId);
    if (!to) throw new NotFoundError("Destination location not found");
    if (to.status !== "active") throw new HttpError(400, `"${to.locationName}" is not active`);

    // Same product twice in one transfer = one combined line.
    const quantities = new Map<string, number>();
    for (const line of parsed.items) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);

    const products = await tx.product.findMany({ where: { tenantId, id: { in: [...quantities.keys()] } } });
    if (products.length !== quantities.size) throw new NotFoundError("One of the selected products was not found");
    const balances = await tx.inventory.findMany({
      where: { tenantId, productId: { in: [...quantities.keys()] }, locationId: { in: [from.id, to.id] } },
      select: { productId: true, locationId: true, quantity: true },
    });
    const balanceOf = (productId: string, locationId: string) =>
      balances.find((b) => b.productId === productId && b.locationId === locationId)?.quantity ?? 0;

    for (const product of products) {
      if (!product.trackStock) throw new HttpError(400, `"${product.name}" doesn't track stock`);
      const quantity = quantities.get(product.id)!;
      const fromQuantity = balanceOf(product.id, from.id);
      const toQuantity = balanceOf(product.id, to.id);
      await assertCanDecrease(tx, tenantId, product, from, fromQuantity, quantity);

      const common = { tenantId, productId: product.id, referenceType: "transfer", referenceId: transferId, performedBy: actor.employeeId, notes: parsed.notes, now };
      await writeStockMovement(tx, { ...common, id: `movement_${randomUUID()}`, locationId: from.id, movementType: "transfer_out", quantityChange: -quantity, previousQuantity: fromQuantity });
      await writeStockMovement(tx, { ...common, id: `movement_${randomUUID()}`, locationId: to.id, movementType: "transfer_in", quantityChange: quantity, previousQuantity: toQuantity });
    }
    return { transferId, lineCount: products.length };
  });
}
