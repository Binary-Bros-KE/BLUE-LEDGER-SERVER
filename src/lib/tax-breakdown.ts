// Ported from DESKTOP's shared/lib/tax-calculation.ts. For a normal DESKTOP-originated document,
// SERVER never RE-computes tax — it only groups the per-line taxType/taxAmountCents/lineTotalCents
// DESKTOP already computed and pushed, into the same category breakdown every document renders
// below its totals (computeTaxBreakdown/computeTaxCategoryTotals/taxBreakdownLabel). The exception
// is mobile checkout (mobile-checkout-service.ts), which has no DESKTOP-computed figures to trust in
// the first place — computeLineTax/resolveProductTaxConfig below are the real, from-scratch pricing
// math for that one path.

export type TaxType = "vat" | "exempted" | "zero_rated";

const TAX_TYPE_LABELS: Record<Exclude<TaxType, "vat">, string> = {
  exempted: "Exempted",
  zero_rated: "Zero-Rated",
};

export type TaxPricingMode = "inclusive" | "exclusive";

export type TaxBreakdownEntry = {
  taxType: TaxType;
  /** Which pricing mode this row's lines used — "vat" splits into a separate row per mode present
   * (see computeTaxBreakdown), so a document mixing inclusive and exclusive VAT products never
   * silently blends their totals into one misleading row. Always null for exempted/zero-rated. */
  pricingMode: TaxPricingMode | null;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/** "Standard (16%)" uses the tenant's own configured rate, never a hardcoded percentage — see
 * Tenant.vatRatePercent. Ported from DESKTOP's tax-calculation.ts taxBreakdownLabel — see its own
 * doc comment for the pricingMode suffix. */
export function taxBreakdownLabel(taxType: TaxType, vatRatePercent: number, pricingMode?: TaxPricingMode | null): string {
  if (taxType === "vat") {
    const base = `Standard (${vatRatePercent}%)`;
    if (pricingMode === "inclusive") return `${base} — Inclusive`;
    if (pricingMode === "exclusive") return `${base} — Exclusive`;
    return base;
  }
  return TAX_TYPE_LABELS[taxType];
}

/**
 * The tax actually ADDED ON TOP of the subtotal to reach the total — exclusive-priced lines only,
 * never inclusive (whose tax is already embedded in the line's own price). Ported from DESKTOP's
 * tax-calculation.ts computeAddedTaxCents — see its own doc comment for the full reasoning. Works
 * from fields every SharedLineItem already carries (unitPriceCents/quantity/discountAmountCents/
 * lineTotalCents), no new stored field needed.
 */
export function computeAddedTaxCents(
  lines: Array<{ unitPriceCents: number; quantity: number; discountAmountCents: number; lineTotalCents: number }>,
): number {
  return lines.reduce((sum, line) => {
    const taxableCents = line.unitPriceCents * line.quantity - line.discountAmountCents;
    return sum + (line.lineTotalCents - taxableCents);
  }, 0);
}

export type TenantTaxConfig = { vatRatePercent: number; pricesTaxInclusive: boolean };

export type LineTaxResult = { grossCents: number; netCents: number; taxCents: number };

/** Resolves a product's own inclusive/exclusive override (falling back to the tenant default) —
 * ported verbatim from DESKTOP's tax-calculation.ts resolveProductTaxConfig, the ONE place mobile
 * checkout needs to agree with DESKTOP on which mode a given line actually uses. */
export function resolveProductTaxConfig(
  product: { pricesTaxInclusive: boolean | null },
  tenantTaxConfig: TenantTaxConfig,
): TenantTaxConfig {
  return {
    vatRatePercent: tenantTaxConfig.vatRatePercent,
    pricesTaxInclusive: product.pricesTaxInclusive ?? tenantTaxConfig.pricesTaxInclusive,
  };
}

/**
 * Ported verbatim from DESKTOP's tax-calculation.ts computeLineTax — see that function's own doc
 * comment for the full inclusive/exclusive reasoning. This is the ONE place mobile checkout computes
 * real money math server-side rather than trusting a client-sent figure (see
 * mobile-checkout-service.ts). `tenantTaxConfig` here is already the per-product-resolved effective
 * config (the output of resolveProductTaxConfig above), not necessarily the tenant's raw default.
 */
export function computeLineTax(amountCents: number, taxType: string, tenantTaxConfig: TenantTaxConfig): LineTaxResult {
  if (taxType !== "vat") {
    return { grossCents: amountCents, netCents: amountCents, taxCents: 0 };
  }

  if (tenantTaxConfig.pricesTaxInclusive) {
    const netCents = Math.round(amountCents / (1 + tenantTaxConfig.vatRatePercent / 100));
    return { grossCents: amountCents, netCents, taxCents: amountCents - netCents };
  }

  const taxCents = Math.round(amountCents * (tenantTaxConfig.vatRatePercent / 100));
  return { grossCents: amountCents + taxCents, netCents: amountCents, taxCents };
}

const KNOWN_TAX_TYPES: TaxType[] = ["vat", "exempted", "zero_rated"];

/**
 * Groups a document's own line items into one row per (category, pricing mode) that actually has
 * qualifying lines. Ported from DESKTOP's tax-calculation.ts computeTaxBreakdown — see its own doc
 * comment for why Standard splits into separate inclusive/exclusive rows rather than one blended
 * row, and for the pricing-mode derivation (no stored field — a line's own lineTotalCents equals its
 * taxable amount when inclusive, or exceeds it when exclusive).
 */
export function computeTaxBreakdown(
  lines: Array<{ unitPriceCents: number; quantity: number; discountAmountCents: number; taxType: string; taxAmountCents: number; lineTotalCents: number }>,
): TaxBreakdownEntry[] {
  const byKey = new Map<string, { taxType: TaxType; pricingMode: TaxPricingMode | null; netCents: number; taxCents: number; grossCents: number }>();
  for (const line of lines) {
    const taxType = (KNOWN_TAX_TYPES as string[]).includes(line.taxType) ? (line.taxType as TaxType) : "vat";
    const taxableCents = line.unitPriceCents * line.quantity - line.discountAmountCents;
    const pricingMode: TaxPricingMode | null = taxType === "vat" ? (line.lineTotalCents > taxableCents ? "exclusive" : "inclusive") : null;
    const key = `${taxType}:${pricingMode ?? ""}`;
    const entry = byKey.get(key) ?? { taxType, pricingMode, netCents: 0, taxCents: 0, grossCents: 0 };
    entry.taxCents += line.taxAmountCents;
    entry.grossCents += line.lineTotalCents;
    entry.netCents += line.lineTotalCents - line.taxAmountCents;
    byKey.set(key, entry);
  }

  const order: Array<{ taxType: TaxType; pricingMode: TaxPricingMode | null }> = [
    { taxType: "vat", pricingMode: "inclusive" },
    { taxType: "vat", pricingMode: "exclusive" },
    { taxType: "exempted", pricingMode: null },
    { taxType: "zero_rated", pricingMode: null },
  ];
  return order
    .map(({ taxType, pricingMode }) => byKey.get(`${taxType}:${pricingMode ?? ""}`))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

/**
 * Category-only aggregation (no inclusive/exclusive split) — for the Owner App's Tax Report, which
 * mirrors DESKTOP's own Tax Report (tax-report-service.ts, an entirely separate aggregation that
 * was never migrated to the per-document split either) and must keep showing the SAME category
 * structure that report does. Document-level views (receipts/invoices/quotations, and their
 * DESKTOP/Share/Owner-App renderings) use computeTaxBreakdown instead. pricingMode is always null
 * here — taxBreakdownLabel renders the base "Standard (16%)" with no suffix for these rows.
 */
/** A service charge's own tax classification — a superset of TaxType with "none" (no classification
 * at all — a charge the client never opted into taxing). Ported from DESKTOP's shared/schemas/
 * charges.ts ServiceChargeTaxType. */
export type ServiceChargeTaxType = "none" | TaxType;

/** One service charge's own frozen tax figures, as pushed inside Sale/Quotation.serviceCharges'
 * loose JSON column — see SaleServiceCharge's own doc comment (DESKTOP shared/types/sale.ts). */
export type TaxableServiceCharge = {
  feeCents: number;
  taxType: ServiceChargeTaxType;
  taxAmountCents: number;
  lineTotalCents: number;
};

/**
 * Ported from DESKTOP's tax-calculation.ts withTaxableServiceCharges — see its own doc comment.
 * Folds a document's service charges into the same {unitPriceCents, quantity, discountAmountCents,
 * taxType, taxAmountCents, lineTotalCents} shape line items already use, so computeTaxBreakdown/
 * computeAddedTaxCents need zero changes. Charges marked "none" are excluded — see the DESKTOP
 * original for why that's the actual mechanism behind "services default to no tax."
 */
export function withTaxableServiceCharges<
  T extends { unitPriceCents: number; quantity: number; discountAmountCents: number; taxType: string; taxAmountCents: number; lineTotalCents: number },
>(
  lines: T[],
  serviceCharges: TaxableServiceCharge[],
): Array<{ unitPriceCents: number; quantity: number; discountAmountCents: number; taxType: string; taxAmountCents: number; lineTotalCents: number }> {
  const taxableCharges = serviceCharges
    .filter((charge) => charge.taxType !== "none")
    .map((charge) => ({
      unitPriceCents: charge.feeCents,
      quantity: 1,
      discountAmountCents: 0,
      taxType: charge.taxType,
      taxAmountCents: charge.taxAmountCents,
      lineTotalCents: charge.lineTotalCents,
    }));
  return [...lines, ...taxableCharges];
}

export function computeTaxCategoryTotals(
  lines: Array<{ taxType: string; taxAmountCents: number; lineTotalCents: number }>,
): TaxBreakdownEntry[] {
  const byType = new Map<TaxType, { netCents: number; taxCents: number; grossCents: number }>();
  for (const line of lines) {
    const taxType = (KNOWN_TAX_TYPES as string[]).includes(line.taxType) ? (line.taxType as TaxType) : "vat";
    const entry = byType.get(taxType) ?? { netCents: 0, taxCents: 0, grossCents: 0 };
    entry.taxCents += line.taxAmountCents;
    entry.grossCents += line.lineTotalCents;
    entry.netCents += line.lineTotalCents - line.taxAmountCents;
    byType.set(taxType, entry);
  }

  return KNOWN_TAX_TYPES.filter((type) => byType.has(type)).map((type) => ({ taxType: type, pricingMode: null, ...byType.get(type)! }));
}
