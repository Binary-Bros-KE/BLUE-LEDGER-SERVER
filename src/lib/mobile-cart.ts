import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "./http-error.js";
import { computeLineTax, resolveProductTaxConfig, type TenantTaxConfig } from "./tax-breakdown.js";
import { activeSharedVariants, parseVariantConfig, variantLabel } from "./variants.js";

export type MobileServiceChargeInput = { name: string; feeCents: number; costCents: number };

export type PreparedServiceCharge = { id: string; name: string; feeCents: number; costCents: number; createdAt: string };

/** Named ad-hoc fees (e.g. "Labour", "Installation") — same shape DESKTOP's own
 * sale_service_charges rows carry (id/createdAt minted here, matching persistServiceCharges).
 * Shared by checkout/invoice/quotation create+update. */
export function buildServiceCharges(serviceCharges: MobileServiceChargeInput[], now: Date): PreparedServiceCharge[] {
  return serviceCharges.map((charge) => ({
    id: randomUUID(),
    name: charge.name,
    feeCents: charge.feeCents,
    costCents: charge.costCents,
    createdAt: now.toISOString(),
  }));
}

export function sumServiceChargeFees(serviceCharges: MobileServiceChargeInput[]): number {
  return serviceCharges.reduce((sum, charge) => sum + charge.feeCents, 0);
}

export type MobileCartItemInput = {
  productId: string;
  quantity: number;
  discountAmountCents: number;
  unitPriceCents?: number;
  isLocallySourced?: boolean;
  localCostCents?: number;
  localSupplierId?: string;
  variantKey?: string | null | undefined;
  sectionLabel?: string | null | undefined;
};

export type PreparedMobileCartItem = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number;
  taxType: string;
  taxAmountCents: number;
  lineTotalCents: number;
  isLocallySourced: boolean;
  localCostCents: number | null;
  localSupplierId: string | null;
  /** shared-stock variant sold on this line + its name snapshot ("Red / XL") — the same keys
   * DESKTOP's sale_items/quotation_items carry (migration v99), so a pull lands them there */
  variantKey: string | null;
  variantLabel: string | null;
  /** DESKTOP's per-line section, carried through unchanged */
  sectionLabel: string | null;
  createdAt: string;
};

export type PreparedMobileCart = {
  items: PreparedMobileCartItem[];
  subtotalCents: number;
  discountAmountCents: number;
  taxAmountCents: number;
  /** Items only — never includes a delivery fee. Callers (checkout/invoice) add
   * `deliveryFeeCents` themselves before validating against amountReceivedCents, same as
   * mobile-checkout-service.ts already did before this was extracted. */
  grandTotalCents: number;
  /** Only ever non-empty when `checkStock` was true — a quotation never deducts stock (or even
   * checks it — see this function's own doc comment), so its caller simply never looks at this. */
  stockMovementRows: Array<{ id: string; productId: string; quantityChange: number }>;
};

/**
 * Server-side equivalent of DESKTOP's sale-service.ts prepareCart — shared by mobile checkout,
 * invoice create/update, and quotation create/update so all three money-computing paths can never
 * drift from each other (a real risk this session already hit once — a checkout tax-omission bug
 * caused by client/server logic disagreeing). Validates every item against LIVE product data (price
 * override + minimum price — two SEPARATE checks, matching DESKTOP's own reasoning for not blaming a
 * discount that was never applied — plus the discount floor, stock availability unless
 * locally-sourced, and local supplier existence), never trusting client-sent totals.
 *
 * Does NOT persist anything or actually deduct stock — callers do that themselves inside their own
 * transaction. `checkStock` mirrors DESKTOP's own real distinction: prepareCart itself never checks
 * stock at all (that happens separately, at actual deduction time, via applyValidatedStockMovement);
 * a quotation calls this with `checkStock: false` and never deducts, matching DESKTOP's
 * quotation-service.ts exactly — checking stock at quote time was deliberately left to the separate,
 * explicit checkQuotationStock action instead, since stock can fluctuate before a quote is ever
 * accepted.
 */
export async function prepareMobileCart(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
  items: MobileCartItemInput[],
  tenantTaxConfig: TenantTaxConfig,
  options: { checkStock: boolean },
): Promise<PreparedMobileCart> {
  if (items.length === 0) throw new HttpError(400, "Add at least one item");

  const products = await tx.product.findMany({ where: { id: { in: items.map((i) => i.productId) }, tenantId } });
  const productById = new Map(products.map((p) => [p.id, p]));

  // Read from the `inventory` running-balance table (see that Prisma model's own doc comment) —
  // O(cart size), not a live sum over this product's entire movement history at this location.
  const balances = options.checkStock
    ? await tx.inventory.findMany({
        where: { tenantId, locationId, productId: { in: items.map((i) => i.productId) } },
        select: { productId: true, quantity: true },
      })
    : [];
  const stockByProduct = new Map(balances.map((b) => [b.productId, b.quantity]));

  // Batch-validate every distinct local supplier referenced across the cart in one query.
  const localSupplierIds = [
    ...new Set(items.filter((i) => i.isLocallySourced && i.localSupplierId).map((i) => i.localSupplierId as string)),
  ];
  const validSupplierIds = new Set(
    localSupplierIds.length > 0
      ? (await tx.supplier.findMany({ where: { id: { in: localSupplierIds }, tenantId }, select: { id: true } })).map((s) => s.id)
      : [],
  );
  for (const id of localSupplierIds) {
    if (!validSupplierIds.has(id)) throw new NotFoundError("Selected local supplier was not found");
  }

  let subtotalCents = 0;
  let discountAmountCents = 0;
  let taxAmountCents = 0;
  const preparedItems: PreparedMobileCartItem[] = [];
  const stockMovementRows: Array<{ id: string; productId: string; quantityChange: number }> = [];
  const now = new Date();
  // Stock is checked against everything requested of a product so far, not line by line — two
  // lines of the same product (e.g. two colours of a shared-stock product) draw from ONE balance.
  const requestedByProduct = new Map<string, number>();

  for (const item of items) {
    const product = productById.get(item.productId);
    if (!product || product.status !== "active") {
      throw new HttpError(400, "One of the selected products is no longer available");
    }

    // Matches DESKTOP's own cart-pricing.ts computeLinePricing exactly: crossing the configured
    // quantity threshold swaps the natural (no-override) price to the wholesale rate. An explicit
    // cashier override still wins over either.
    const useWholesale = product.wholesalePriceCents !== null && product.wholesaleMinQuantity > 0 && item.quantity >= product.wholesaleMinQuantity;
    // Shared-stock variant: its own price (when set) replaces the selling price as the natural
    // price, exactly like DESKTOP's prepareCart; an override or wholesale still applies the same way.
    let variant: { key: string; label: string; priceCents: number | null } | null = null;
    if (item.variantKey) {
      const config = parseVariantConfig(product.variantConfigJson);
      const found = activeSharedVariants(config).find((v) => v.key === item.variantKey);
      if (!config || !found) {
        throw new HttpError(400, `The chosen option of "${product.name}" is no longer available — remove the line and add it again`);
      }
      variant = { key: found.key, label: variantLabel(config.options, found.values), priceCents: found.priceCents };
    }
    const unitPriceCents =
      item.unitPriceCents ?? (useWholesale ? (product.wholesalePriceCents as number) : (variant?.priceCents ?? product.sellingPriceCents));
    if (product.minimumPriceCents !== null && unitPriceCents < product.minimumPriceCents) {
      throw new HttpError(400, `Price for "${product.name}" can't be below its minimum price of ${(product.minimumPriceCents / 100).toFixed(2)}`);
    }
    const lineSubtotalCents = unitPriceCents * item.quantity;
    if (item.discountAmountCents > lineSubtotalCents) {
      throw new HttpError(400, `Discount for "${product.name}" can't exceed its subtotal`);
    }
    const minLineSubtotalCents = product.minimumPriceCents !== null ? product.minimumPriceCents * item.quantity : 0;
    if (lineSubtotalCents - item.discountAmountCents < minLineSubtotalCents) {
      throw new HttpError(400, `Discount for "${product.name}" would drop it below its minimum price`);
    }

    if (options.checkStock && product.trackStock && !item.isLocallySourced) {
      const available = stockByProduct.get(product.id) ?? 0;
      const requested = (requestedByProduct.get(product.id) ?? 0) + item.quantity;
      requestedByProduct.set(product.id, requested);
      if (available - requested < 0 && !product.allowNegativeStock) {
        throw new HttpError(400, `"${product.name}" doesn't have enough stock (${available} available)`);
      }
    }

    const taxableCents = lineSubtotalCents - item.discountAmountCents;
    const productTaxConfig = resolveProductTaxConfig({ pricesTaxInclusive: product.pricesTaxInclusive }, tenantTaxConfig);
    const { grossCents, taxCents } = computeLineTax(taxableCents, product.taxType, productTaxConfig);

    subtotalCents += lineSubtotalCents;
    discountAmountCents += item.discountAmountCents;
    taxAmountCents += taxCents;

    preparedItems.push({
      id: randomUUID(),
      productId: product.id,
      quantity: item.quantity,
      unitPriceCents,
      discountAmountCents: item.discountAmountCents,
      taxType: product.taxType,
      taxAmountCents: taxCents,
      lineTotalCents: grossCents,
      isLocallySourced: item.isLocallySourced ?? false,
      localCostCents: item.isLocallySourced ? (item.localCostCents ?? null) : null,
      localSupplierId: item.isLocallySourced ? (item.localSupplierId ?? null) : null,
      variantKey: variant?.key ?? null,
      variantLabel: variant?.label ?? null,
      sectionLabel: item.sectionLabel ?? null,
      createdAt: now.toISOString(),
    });

    if (options.checkStock && product.trackStock && !item.isLocallySourced) {
      stockMovementRows.push({ id: randomUUID(), productId: product.id, quantityChange: -item.quantity });
    }
  }

  const grandTotalCents = preparedItems.reduce((sum, item) => sum + item.lineTotalCents, 0);

  return { items: preparedItems, subtotalCents, discountAmountCents, taxAmountCents, grandTotalCents, stockMovementRows };
}
