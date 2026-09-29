import type { Prisma } from "@prisma/client";

// Product variants on the SERVER side — mirrors DESKTOP docs/VARIANTS.md. Two stock modes, per product:
//  - "shared":   ONE product, ONE stock. Variants live in Product.variantConfigJson.variants, each
//                with an optional price override (null = the product's own price).
//  - "separate": each variant is its OWN product; they share Product.variantGroupId (= the main
//                product's id), and each carries its option values in variantOptionsJson. The main
//                product holds the options/title in its variantConfigJson.
// Parsed defensively: anything malformed reads as "no variants", never an error on a shop page.

export type VariantOption = { name: string; values: string[] };
export type SharedVariant = {
  key: string;
  values: Record<string, string>;
  priceCents: number | null;
  active: boolean;
};
export type VariantConfig = {
  mode: "shared" | "separate";
  title: string | null;
  options: VariantOption[];
  variants: SharedVariant[];
};

function strRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[0].trim() !== ""),
  );
}

export function parseVariantOptions(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  return strRecord(value);
}

export function parseVariantConfig(value: Prisma.JsonValue | null | undefined): VariantConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const mode = v.mode === "shared" || v.mode === "separate" ? v.mode : null;
  if (!mode) return null;
  const options = (Array.isArray(v.options) ? v.options : [])
    .map((o) => {
      const oo = (o ?? {}) as Record<string, unknown>;
      return {
        name: typeof oo.name === "string" ? oo.name.trim() : "",
        values: Array.isArray(oo.values) ? oo.values.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [],
      };
    })
    .filter((o) => o.name && o.values.length > 0);
  const variants = (Array.isArray(v.variants) ? v.variants : []).flatMap((x) => {
    const xx = (x ?? {}) as Record<string, unknown>;
    if (typeof xx.key !== "string" || !xx.key) return [];
    return [
      {
        key: xx.key,
        values: strRecord(xx.values),
        priceCents: typeof xx.priceCents === "number" ? xx.priceCents : null,
        active: xx.active !== false,
      },
    ];
  });
  return { mode, title: typeof v.title === "string" && v.title.trim() ? v.title.trim() : null, options, variants };
}

/** "XL / Red" — values in the product's option order. */
export function variantLabel(options: VariantOption[], values: Record<string, string>): string {
  const ordered = options.map((o) => values[o.name]).filter((x): x is string => Boolean(x));
  const extra = Object.entries(values)
    .filter(([name]) => !options.some((o) => o.name === name))
    .map(([, x]) => x);
  return [...ordered, ...extra].join(" / ");
}

/** The shared variants a shopper can buy (active ones), or [] when the product has none. */
export function activeSharedVariants(config: VariantConfig | null): SharedVariant[] {
  return config?.mode === "shared" ? config.variants.filter((v) => v.active) : [];
}

/** A shared variant's price for the website: its own override, else the product's shopper price. */
export function sharedVariantPrice(variant: SharedVariant, shopperPriceCents: number): number {
  return variant.priceCents ?? shopperPriceCents;
}
