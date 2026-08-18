// Ported from DESKTOP's shared/lib/tax-calculation.ts (computeTaxBreakdown/taxBreakdownLabel) —
// SERVER never computes tax from scratch (see DESKTOP's own computeLineTax doc comment for that
// math); it only groups the per-line taxType/taxAmountCents/lineTotalCents that DESKTOP already
// computed and pushed, into the same category breakdown every document renders below its totals.

export type TaxType = "vat" | "exempted" | "zero_rated";

const TAX_TYPE_LABELS: Record<Exclude<TaxType, "vat">, string> = {
  exempted: "Exempted",
  zero_rated: "Zero-Rated",
};

/** Stable category order every document renders in — Standard, Exempted, Zero-Rated. */
const TAX_TYPE_ORDER: TaxType[] = ["vat", "exempted", "zero_rated"];

export type TaxBreakdownEntry = {
  taxType: TaxType;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/** "Standard (16%)" uses the tenant's own configured rate, never a hardcoded percentage — see
 * Tenant.vatRatePercent. */
export function taxBreakdownLabel(taxType: TaxType, vatRatePercent: number): string {
  if (taxType === "vat") return `Standard (${vatRatePercent}%)`;
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

export function computeTaxBreakdown(
  lines: Array<{ taxType: string; taxAmountCents: number; lineTotalCents: number }>,
): TaxBreakdownEntry[] {
  const byType = new Map<TaxType, { netCents: number; taxCents: number; grossCents: number }>();
  for (const line of lines) {
    const taxType = (TAX_TYPE_ORDER as string[]).includes(line.taxType) ? (line.taxType as TaxType) : "vat";
    const entry = byType.get(taxType) ?? { netCents: 0, taxCents: 0, grossCents: 0 };
    entry.taxCents += line.taxAmountCents;
    entry.grossCents += line.lineTotalCents;
    entry.netCents += line.lineTotalCents - line.taxAmountCents;
    byType.set(taxType, entry);
  }

  return TAX_TYPE_ORDER.filter((type) => byType.has(type)).map((type) => ({ taxType: type, ...byType.get(type)! }));
}
