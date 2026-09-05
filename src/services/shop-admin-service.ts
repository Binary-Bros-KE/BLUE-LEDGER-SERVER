import { promises as dns } from "node:dns";
import { Prisma, type WebStore } from "@prisma/client";
import { env } from "../env.js";
import { HttpError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import type { ShopDomainInput, ShopProvisionInput, ShopPublishInput, ShopUpdateInput } from "../schemas/shop.js";

// The dashboard's "Online Store" panel reads this whole thing, and every mutation returns a fresh
// copy so the panel can re-render off one response.
export type ShopOverview = {
  store: WebStore | null;
  /** per-tenant à-la-carte flag (Tenant.ecommerceEnabled) */
  ecommerceEnabled: boolean;
  /** plan-tier flag (Plan.featureEcommerce) */
  planFeatureEcommerce: boolean;
  /** `<subdomain>.<this>` is the preview URL */
  storefrontBaseDomain: string;
  /** what a client CNAMEs their own domain at; null if not configured yet */
  storefrontPublicHost: string | null;
  fulfilmentLocationName: string | null;
  publishedCount: number;
  activeProductCount: number;
  categoryCount: number;
};

export type PublishableProduct = {
  id: string;
  name: string;
  sku: string;
  categoryName: string | null;
  sellingPriceCents: number;
  onlinePriceCents: number | null;
  publishedOnline: boolean;
};

async function loadTenant(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { subscription: { include: { plan: true } }, webStore: true, license: true },
  });
  if (!tenant) throw new HttpError(404, "Tenant not found");
  return tenant;
}

async function productStats(tenantId: string, fulfilmentLocationId: string | null) {
  return withTenantContext(tenantId, async (tx) => {
    const [publishedCount, activeProductCount, cats, loc] = await Promise.all([
      tx.product.count({ where: { publishedOnline: true, status: "active" } }),
      tx.product.count({ where: { status: "active" } }),
      tx.product.groupBy({
        by: ["categoryId"],
        where: { publishedOnline: true, status: "active", categoryId: { not: null } },
        _count: { _all: true },
      }),
      fulfilmentLocationId
        ? tx.location.findUnique({ where: { id: fulfilmentLocationId }, select: { locationName: true } })
        : Promise.resolve(null),
    ]);
    return {
      publishedCount,
      activeProductCount,
      categoryCount: cats.length,
      fulfilmentLocationName: loc?.locationName ?? null,
    };
  });
}

async function buildOverview(tenantId: string): Promise<ShopOverview> {
  const tenant = await loadTenant(tenantId);
  const stats = await productStats(tenantId, tenant.webStore?.fulfilmentLocationId ?? null);
  return {
    store: tenant.webStore,
    ecommerceEnabled: tenant.ecommerceEnabled,
    planFeatureEcommerce: tenant.subscription?.plan.featureEcommerce ?? false,
    storefrontBaseDomain: env.STOREFRONT_BASE_DOMAIN,
    storefrontPublicHost: env.STOREFRONT_PUBLIC_HOST || null,
    ...stats,
  };
}

export function getShopOverview(tenantId: string): Promise<ShopOverview> {
  return buildOverview(tenantId);
}

/** Uniqueness on subdomain / customDomain is enforced by the DB too (@unique) — this just turns
 * the raw P2002 into a friendly 409 before it ever hits the client. */
async function assertSubdomainFree(subdomain: string, exceptTenantId: string): Promise<void> {
  const existing = await prisma.webStore.findUnique({ where: { subdomain }, select: { tenantId: true } });
  if (existing && existing.tenantId !== exceptTenantId) {
    throw new HttpError(409, `The address "${subdomain}" is already taken by another store`);
  }
}

async function assertDomainFree(domain: string, exceptTenantId: string): Promise<void> {
  const existing = await prisma.webStore.findUnique({ where: { customDomain: domain }, select: { tenantId: true } });
  if (existing && existing.tenantId !== exceptTenantId) {
    throw new HttpError(409, `The domain "${domain}" is already connected to another store`);
  }
}

export async function provisionStore(tenantId: string, input: ShopProvisionInput): Promise<ShopOverview> {
  const tenant = await loadTenant(tenantId);
  if (!tenant.license) throw new HttpError(400, "Tenant has no license");
  if (tenant.webStore) throw new HttpError(409, "This tenant already has an online store");

  await assertSubdomainFree(input.subdomain, tenantId);
  if (input.customDomain) await assertDomainFree(input.customDomain, tenantId);

  await prisma.$transaction([
    prisma.tenant.update({ where: { id: tenantId }, data: { ecommerceEnabled: true } }),
    prisma.webStore.create({
      data: {
        tenantId,
        subdomain: input.subdomain,
        customDomain: input.customDomain ?? null,
        domainStatus: input.customDomain ? "PENDING_DNS" : "NONE",
        status: "DRAFT",
        fulfilmentLocationId: input.fulfilmentLocationId ?? null,
        currency: input.currency ?? tenant.currency,
      },
    }),
  ]);

  return buildOverview(tenantId);
}

export async function updateStore(tenantId: string, input: ShopUpdateInput): Promise<ShopOverview> {
  const tenant = await loadTenant(tenantId);
  if (!tenant.webStore) throw new HttpError(404, "This tenant has no online store yet");

  if (input.subdomain && input.subdomain !== tenant.webStore.subdomain) {
    await assertSubdomainFree(input.subdomain, tenantId);
  }

  const data: Prisma.WebStoreUpdateInput = {};
  if (input.subdomain !== undefined) data.subdomain = input.subdomain;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.fulfilmentLocationId !== undefined) data.fulfilmentLocationId = input.fulfilmentLocationId ?? null;
  if (input.status !== undefined) data.status = input.status;

  await prisma.webStore.update({ where: { tenantId }, data });
  return buildOverview(tenantId);
}

export async function setDomain(tenantId: string, input: ShopDomainInput): Promise<ShopOverview> {
  const tenant = await loadTenant(tenantId);
  if (!tenant.webStore) throw new HttpError(404, "This tenant has no online store yet");

  if (input.customDomain === null) {
    await prisma.webStore.update({
      where: { tenantId },
      data: { customDomain: null, domainStatus: "NONE" },
    });
    return buildOverview(tenantId);
  }

  await assertDomainFree(input.customDomain, tenantId);
  await prisma.webStore.update({
    where: { tenantId },
    data: { customDomain: input.customDomain, domainStatus: "PENDING_DNS" },
  });
  return buildOverview(tenantId);
}

export async function verifyDomain(tenantId: string): Promise<ShopOverview & { detail: string }> {
  const tenant = await loadTenant(tenantId);
  const domain = tenant.webStore?.customDomain;
  if (!tenant.webStore || !domain) throw new HttpError(400, "No custom domain to verify");

  const expect = env.STOREFRONT_PUBLIC_HOST.toLowerCase();
  let cnames: string[] = [];
  try {
    cnames = (await dns.resolveCname(domain)).map((c) => c.toLowerCase());
  } catch {
    // no CNAME record (yet) — fall through to the A-record / failure paths
  }

  const cnameMatches =
    expect.length > 0 && cnames.some((c) => c === expect || c.endsWith(`.${expect}`));

  let aRecords: string[] = [];
  if (!cnameMatches) {
    try {
      aRecords = await dns.resolve4(domain);
    } catch {
      // domain doesn't resolve at all
    }
  }

  // Pass conditions:
  //  - CNAME points at the storefront host (the clean case), OR
  //  - no expected host is configured and the domain resolves at all, OR
  //  - an A record exists (proxied/flattened domains hide the CNAME behind an A record).
  const ok = cnameMatches || (expect.length === 0 && (cnames.length > 0 || aRecords.length > 0)) || aRecords.length > 0;

  if (!ok) {
    const detail = cnames.length
      ? `${domain} currently points to ${cnames.join(", ")}${expect ? ` — expected a CNAME to ${expect}` : ""}`
      : `${domain} has no CNAME/A record yet — add the DNS record and try again in a few minutes`;
    throw new HttpError(422, detail, "DNS_NOT_READY");
  }

  await prisma.webStore.update({ where: { tenantId }, data: { domainStatus: "LIVE" } });
  const overview = await buildOverview(tenantId);
  const detail = cnameMatches
    ? `CNAME → ${cnames.join(", ")}`
    : cnames.length
      ? `CNAME → ${cnames.join(", ")}`
      : `A → ${aRecords.join(", ")}`;
  return { ...overview, detail };
}

export function listPublishableProducts(tenantId: string, search?: string): Promise<PublishableProduct[]> {
  return withTenantContext(tenantId, async (tx) => {
    const where: Prisma.ProductWhereInput = {
      status: "active",
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { sku: { contains: search, mode: "insensitive" } },
              { barcode: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const rows = await tx.product.findMany({
      where,
      orderBy: [{ publishedOnline: "desc" }, { name: "asc" }],
      take: 500,
      select: {
        id: true,
        name: true,
        sku: true,
        categoryId: true,
        sellingPriceCents: true,
        onlinePriceCents: true,
        publishedOnline: true,
      },
    });

    const catIds = [...new Set(rows.map((r) => r.categoryId).filter((id): id is string => Boolean(id)))];
    const cats = catIds.length
      ? await tx.category.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(cats.map((c) => [c.id, c.name]));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      categoryName: r.categoryId ? (names.get(r.categoryId) ?? null) : null,
      sellingPriceCents: r.sellingPriceCents,
      onlinePriceCents: r.onlinePriceCents,
      publishedOnline: r.publishedOnline,
    }));
  });
}

export async function setPublished(tenantId: string, input: ShopPublishInput): Promise<ShopOverview> {
  await withTenantContext(tenantId, async (tx) => {
    const where: Prisma.ProductWhereInput = input.all
      ? { status: "active" }
      : { status: "active", id: { in: input.productIds ?? [] } };
    await tx.product.updateMany({ where, data: { publishedOnline: input.published } });
  });
  return buildOverview(tenantId);
}
