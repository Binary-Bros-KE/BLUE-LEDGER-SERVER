import { Prisma } from "@prisma/client";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import {
  isR2Configured,
  deleteStoredImage,
  uploadProductImage,
  uploadThemeImage,
  type UploadedImage,
} from "../lib/r2.js";
import { mergeTheme } from "../lib/trylist-theme.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import type {
  ProductImageDeleteInput,
  ProductImageUploadInput,
  StoreConfigUpdateInput,
  ThemeImageUploadInput,
  ThemeUpdateInput,
} from "../schemas/shop.js";

/**
 * The tenant-facing side of the online store, called by the desktop POS "Online Store" tab
 * (device-authed via requireDevice — see routes/shop-admin.ts). The account/dashboard side
 * (provision a store, connect a domain, verify DNS) lives in shop-admin-service.ts and is
 * deliberately kept separate: a shop owner manages their catalogue and storefront look; Blue
 * Ledger staff manage the plumbing.
 */

export type StoreOwnerView = {
  /** null until Blue Ledger has provisioned a web_stores row for this tenant. */
  store: {
    subdomain: string;
    customDomain: string | null;
    domainStatus: string;
    status: string;
    currency: string;
    fulfilmentLocationId: string | null;
    themeJson: Prisma.JsonValue;
    deliveryJson: Prisma.JsonValue;
    paymentOptionsJson: Prisma.JsonValue;
  } | null;
  /** Always-works subdomain URL (preview + fallback). */
  previewUrl: string | null;
  /** The real domain, only once DNS is verified LIVE. */
  liveUrl: string | null;
  /** Whether product photos can be uploaded yet (R2 credentials present on the server). */
  imageUploadsEnabled: boolean;
  publishedCount: number;
  activeProductCount: number;
};

function buildUrls(subdomain: string, customDomain: string | null, domainStatus: string) {
  const base = env.STOREFRONT_BASE_DOMAIN;
  const scheme = base.startsWith("localhost") ? "http" : "https";
  return {
    previewUrl: `${scheme}://${subdomain}.${base}`,
    liveUrl: customDomain && domainStatus === "LIVE" ? `https://${customDomain}` : null,
  };
}

async function loadView(tenantId: string): Promise<StoreOwnerView> {
  // web_stores is a NON-RLS routing table (looked up by domain before any tenant context exists) —
  // bare client, filtered explicitly by tenantId, same as every other pre-context lookup.
  const store = await prisma.webStore.findUnique({ where: { tenantId } });

  const counts = await withTenantContext(tenantId, async (tx) => {
    const [publishedCount, activeProductCount] = await Promise.all([
      tx.product.count({ where: { publishedOnline: true, status: "active" } }),
      tx.product.count({ where: { status: "active" } }),
    ]);
    return { publishedCount, activeProductCount };
  });

  if (!store) {
    return {
      store: null,
      previewUrl: null,
      liveUrl: null,
      imageUploadsEnabled: isR2Configured(),
      ...counts,
    };
  }

  const { previewUrl, liveUrl } = buildUrls(store.subdomain, store.customDomain, store.domainStatus);
  return {
    store: {
      subdomain: store.subdomain,
      customDomain: store.customDomain,
      domainStatus: store.domainStatus,
      status: store.status,
      currency: store.currency,
      fulfilmentLocationId: store.fulfilmentLocationId,
      themeJson: store.themeJson,
      deliveryJson: store.deliveryJson,
      paymentOptionsJson: store.paymentOptionsJson,
    },
    previewUrl,
    liveUrl,
    imageUploadsEnabled: isR2Configured(),
    ...counts,
  };
}

export function getStoreForDevice(tenantId: string): Promise<StoreOwnerView> {
  return loadView(tenantId);
}

export async function updateStoreConfig(
  tenantId: string,
  input: StoreConfigUpdateInput,
): Promise<StoreOwnerView> {
  const store = await prisma.webStore.findUnique({ where: { tenantId }, select: { tenantId: true } });
  if (!store) {
    throw new HttpError(404, "Your online store hasn't been set up yet — contact Blue Ledger support.");
  }

  const data: Prisma.WebStoreUpdateInput = {};
  if (input.themeJson !== undefined) data.themeJson = input.themeJson as Prisma.InputJsonValue;
  if (input.deliveryJson !== undefined) data.deliveryJson = input.deliveryJson as Prisma.InputJsonValue;
  if (input.paymentOptionsJson !== undefined) {
    data.paymentOptionsJson = input.paymentOptionsJson as Prisma.InputJsonValue;
  }

  await prisma.webStore.update({ where: { tenantId }, data });
  return loadView(tenantId);
}

export async function uploadImage(
  tenantId: string,
  input: ProductImageUploadInput,
): Promise<UploadedImage> {
  const raw = Buffer.from(input.dataBase64, "base64");
  return uploadProductImage(tenantId, input.productId, raw, input.productName);
}

export async function deleteImage(
  _tenantId: string,
  input: ProductImageDeleteInput,
): Promise<{ ok: true }> {
  await deleteStoredImage(input.url);
  return { ok: true };
}

// --- Trylist theme (storefront look) ------------------------------------------------------------

async function requireStore(tenantId: string): Promise<Prisma.JsonValue> {
  const store = await prisma.webStore.findUnique({ where: { tenantId }, select: { themeJson: true } });
  if (!store) {
    throw new HttpError(404, "Your online store hasn't been set up yet — contact Blue Ledger support.");
  }
  return store.themeJson;
}

function asObject(json: Prisma.JsonValue): Record<string, unknown> {
  return json && typeof json === "object" && !Array.isArray(json) ? { ...(json as Record<string, unknown>) } : {};
}

/** Deep-merges a partial Trylist theme into web_stores.themeJson. `story` replaces wholesale;
 * `null` on any field (incl. a categoryImages entry) clears it. Stamps `name: "trylist"`. */
export async function updateTheme(tenantId: string, input: ThemeUpdateInput): Promise<StoreOwnerView> {
  const current = asObject(await requireStore(tenantId));
  const merged = mergeTheme(current, { name: "trylist", ...(input as Record<string, unknown>) });
  await prisma.webStore.update({
    where: { tenantId },
    data: { themeJson: merged as Prisma.InputJsonValue },
  });
  return loadView(tenantId);
}

/** Uploads a theme decoration image to R2 and returns its URLs. The desktop then writes the URL
 * into the theme via updateTheme — this endpoint never touches themeJson itself (keeps story-row
 * reordering etc. entirely client-side). */
export async function uploadThemeAsset(
  tenantId: string,
  input: ThemeImageUploadInput,
): Promise<UploadedImage> {
  const raw = Buffer.from(input.dataBase64, "base64");
  return uploadThemeImage(tenantId, input.slot, raw);
}
