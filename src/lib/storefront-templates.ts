/**
 * The storefront templates the NEXT/storefront app can render, and the brand-colour roles every
 * template shares. A tenant's shop picks ONE template (web_stores.templateId) and may override any
 * of the colour roles (web_stores.themeColorsJson) — both are set by Blue Ledger admins from the
 * dashboard only.
 *
 * Add an id here only once that template actually ships in NEXT/storefront (src/templates/), or a
 * store could be switched onto a template that renders as the fallback. Mirrored by hand in
 * NEXT/storefront src/templates/registry.ts and NEXT/admin src/lib/storefront-templates.ts.
 */
export const STOREFRONT_TEMPLATE_IDS = ["classic", "adia"] as const;

export type StorefrontTemplateId = (typeof STOREFRONT_TEMPLATE_IDS)[number];

export const DEFAULT_TEMPLATE_ID: StorefrontTemplateId = "classic";

/** The standard colour roles. Every template maps its look onto these three — the storefront
 * derives hover/tint/readable-text shades from them, so admins only ever pick three colours. */
export const COLOR_ROLES = ["primary", "secondary", "accent"] as const;

export type ColorRole = (typeof COLOR_ROLES)[number];

export type ThemeColors = Partial<Record<ColorRole, string>>;

const HEX = /^#[0-9a-f]{6}$/;

/** Defensive read of the stored JSON — anything that isn't a known role with a valid hex is
 * dropped, so a hand-edited row can never reach the storefront as garbage CSS. */
export function readThemeColors(raw: unknown): ThemeColors {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ThemeColors = {};
  for (const role of COLOR_ROLES) {
    const v = o[role];
    if (typeof v === "string" && HEX.test(v.toLowerCase())) out[role] = v.toLowerCase();
  }
  return out;
}

/** A stored templateId the storefront no longer knows (template retired) reads as the default. */
export function readTemplateId(raw: string | null | undefined): StorefrontTemplateId {
  return (STOREFRONT_TEMPLATE_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as StorefrontTemplateId)
    : DEFAULT_TEMPLATE_ID;
}
