// Ported from DESKTOP's shared/lib/tax-calculation.ts (computeTaxBreakdown/taxBreakdownLabel) —
// SERVER never computes tax from scratch (see DESKTOP's own computeLineTax doc comment for that
// math); it only groups the per-line taxType/taxAmountCents/lineTotalCents that DESKTOP already
// computed and pushed, into the same category breakdown every document renders below its totals.

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
