/**
 * Selling a product in more than one unit — rice by the kg or the gram, oil by the litre or mL, soda
 * by the bottle or the crate.
 *
 * The model: stock, sale quantities and purchases all stay whole numbers of the product's BASE unit
 * (Product.unitOfMeasure: g, mL, cm, piece…), so nothing that adds up stock changes. Prices stay "per
 * base unit" too, but may now be fractional — KES 175/kg is stored as 17.5 cents per gram — which
 * keeps every existing `quantity * price` in the codebase correct as written. Only what people see
 * and type is converted, using Product.unitConfigJson (null = one unit only, exactly as before).
 *
 * Mirrored in APP (src/lib/product-units.ts) and DESKTOP (src/shared/lib/product-units.ts) — same
 * "kept in sync by hand across packages" convention as the variant helpers.
 */

export type ProductUnit = {
  /** "kg", "L", "carton" — shown to people and stored on sale lines. */
  code: string;
  /** How many base units one of this unit is (kg -> 1000 when the base is g). A whole number >= 2. */
  factor: number;
  /** Its own price in cents, for a pack sold below its pieces' total. Null = factor x the base price. */
  priceCents: number | null;
};

export type ProductUnitConfig = {
  /** "measure": split freely (1.5 kg). "pack": whole packs and loose pieces (2 cartons 3 pieces). */
  kind: "measure" | "pack";
  /** The unit prices are typed and shown in (kg); null = the base unit. */
  priceUnit: string | null;
  /** The unit a new cart line starts in; null = the base unit. */
  defaultSaleUnit: string | null;
  units: ProductUnit[];
};

/** Only one extra unit per measure today, but a list so a family can grow with one entry. */
export const MEASURE_FAMILIES: ReadonlyArray<{ key: string; label: string; base: string; units: ReadonlyArray<{ code: string; factor: number }> }> = [
  { key: "weight", label: "Weight", base: "g", units: [{ code: "kg", factor: 1000 }] },
  { key: "volume", label: "Volume", base: "mL", units: [{ code: "L", factor: 1000 }] },
  { key: "length", label: "Length", base: "cm", units: [{ code: "m", factor: 100 }] },
];

export function parseUnitConfig(raw: unknown): ProductUnitConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ProductUnitConfig>;
  if ((value.kind !== "measure" && value.kind !== "pack") || !Array.isArray(value.units) || value.units.length === 0) return null;
  return {
    kind: value.kind,
    priceUnit: value.priceUnit ?? null,
    defaultSaleUnit: value.defaultSaleUnit ?? null,
    units: value.units,
  };
}

export function findUnit(config: ProductUnitConfig | null, code: string | null | undefined): ProductUnit | null {
  if (!config || !code) return null;
  return config.units.find((unit) => unit.code === code) ?? null;
}

/** "1", "1.5", "0.333" — never a long float tail. */
function trimNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Word units read naturally in the plural; symbols never change ("2.5 kg", but "2 cartons"). */
function unitWithCount(code: string, count: number): string {
  if (count === 1 || /^(kg|g|L|mL|m|cm|dozen)$/.test(code)) return code;
  return /(x|s|ch|sh)$/.test(code) ? `${code}es` : `${code}s`;
}

/**
 * A whole-number base quantity in the units people think in: 25000 -> "25 kg", 1500 -> "1.5 kg",
 * 750 -> "750 g", and for packs 50 -> "2 cartons 2 pieces". Null config = just the plain quantity
 * and unit.
 */
export function formatQuantity(quantity: number, baseUnit: string | null, config: ProductUnitConfig | null): string {
  const base = baseUnit ?? "";
  const plain = (count: number) => `${trimNumber(count)}${base ? ` ${unitWithCount(base, Math.abs(count))}` : ""}`;
  if (!config) return plain(quantity);

  const sign = quantity < 0 ? "-" : "";
  const abs = Math.abs(quantity);
  const largestFirst = [...config.units].sort((a, b) => b.factor - a.factor);

  if (config.kind === "measure") {
    const unit = largestFirst.find((u) => abs >= u.factor);
    if (!unit) return plain(quantity);
    return `${sign}${trimNumber(abs / unit.factor)} ${unit.code}`;
  }

  const parts: string[] = [];
  let remaining = abs;
  for (const unit of largestFirst) {
    const count = Math.floor(remaining / unit.factor);
    if (count > 0) {
      parts.push(`${count} ${unitWithCount(unit.code, count)}`);
      remaining -= count * unit.factor;
    }
  }
  if (remaining > 0 || parts.length === 0) parts.push(plain(remaining));
  return `${sign}${parts.join(" ")}`;
}

/** The price shown to people: per the price unit, in whole cents. */
export function displayPriceCents(basePriceCents: number, config: ProductUnitConfig | null): number {
  const unit = findUnit(config, config?.priceUnit);
  return Math.round(basePriceCents * (unit?.factor ?? 1));
}

/**
 * A sale/quotation line as printed: sold as 1500 of g at KES 0.175 becomes "1.5 x KES 175" under
 * "Rice (kg)". Lines sold in the base unit, and every line from before units existed, are unchanged.
 * Applied where shared documents are built, so the screen, the PDF, the public page and the thermal
 * receipt all agree.
 */
export function displayLine(line: { quantity: number; unitPriceCents: number; unitCode?: string | null; unitFactor?: number | null }): {
  quantity: number;
  unitPriceCents: number;
  unitSuffix: string | null;
} {
  if (!line.unitCode || !line.unitFactor || line.unitFactor <= 1) {
    return { quantity: line.quantity, unitPriceCents: line.unitPriceCents, unitSuffix: null };
  }
  return {
    quantity: Math.round((line.quantity / line.unitFactor) * 1000) / 1000,
    unitPriceCents: Math.round(line.unitPriceCents * line.unitFactor),
    unitSuffix: line.unitCode,
  };
}
