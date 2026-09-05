/**
 * Manual e-commerce onboarding for a tenant, until the admin/desktop UI for it exists (P3).
 * See ECOMMERCE-ARCHITECTURE.md.
 *
 * Does, for the given tenant slug:
 *   1. Plan.featureEcommerce = true          (the paid gate)
 *   2. publishes every active product         (Product.publishedOnline = true)  — RLS-scoped
 *   3. picks a fulfilment location            (first sell-capable storefront)
 *   4. upserts the web_stores row             (status = LIVE)
 *
 * Usage:
 *   npx tsx scripts/shop-provision.ts <tenant-slug> [subdomain] [customDomain]
 *
 * Examples:
 *   npx tsx scripts/shop-provision.ts trylistsolutions
 *   npx tsx scripts/shop-provision.ts trylistsolutions trylist trylistsolutions.co.ke
 *
 * Safe to re-run. To UN-publish for a clean retest:
 *   npx tsx scripts/shop-provision.ts <slug> --unpublish
 */
import { withTenantContext } from "../src/lib/tenant-context.js";
import { prisma } from "../src/prisma.js";

const slug = process.argv[2];
const arg3 = process.argv[3];
const arg4 = process.argv[4];
const unpublish = process.argv.includes("--unpublish");

if (!slug) {
  console.error("usage: npx tsx scripts/shop-provision.ts <tenant-slug> [subdomain] [customDomain]");
  process.exit(1);
}

const subdomain = arg3 && !arg3.startsWith("--") ? arg3 : slug;
const customDomain = arg4 && !arg4.startsWith("--") ? arg4 : null;

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    include: { subscription: { include: { plan: true } }, license: true, webStore: true },
  });
  if (!tenant) throw new Error(`No tenant with slug "${slug}"`);
  if (!tenant.license) throw new Error(`Tenant "${slug}" has no license`);
  if (!tenant.subscription?.plan) throw new Error(`Tenant "${slug}" has no subscription/plan`);

  console.log(`Tenant: ${tenant.name}  (id ${tenant.id})`);
  console.log(`License: ${tenant.license.status}   Plan: ${tenant.subscription.plan.name}\n`);

  // 1 — plan flag
  await prisma.plan.update({
    where: { id: tenant.subscription.plan.id },
    data: { featureEcommerce: !unpublish },
  });
  console.log(`✓ Plan.featureEcommerce = ${!unpublish}`);

  // 2 + 3 — publish products, pick a fulfilment location (RLS-scoped)
  const { locationId, locationName, published, catalogCount, categoryCount } = await withTenantContext(
    tenant.id,
    async (tx) => {
      const sellLoc =
        (await tx.location.findFirst({
          where: { canSellStock: true, status: "active" },
          orderBy: { localCreatedAt: "asc" },
        })) ?? (await tx.location.findFirst({ orderBy: { localCreatedAt: "asc" } }));

      const res = await tx.product.updateMany({
        where: { status: "active" },
        data: { publishedOnline: !unpublish },
      });
      const count = await tx.product.count({ where: { publishedOnline: true, status: "active" } });
      const cats = await tx.product.groupBy({
        by: ["categoryId"],
        where: { publishedOnline: true, status: "active", categoryId: { not: null } },
        _count: { _all: true },
      });

      return {
        locationId: sellLoc?.id ?? null,
        locationName: sellLoc?.locationName ?? null,
        published: res.count,
        catalogCount: count,
        categoryCount: cats.length,
      };
    },
  );
  console.log(
    `✓ ${unpublish ? "un-published" : "published"} ${published} products  ` +
      `→ ${catalogCount} live in the catalog, ${categoryCount} categories`,
  );
  if (!locationId) {
    console.warn(
      "! no locations synced for this tenant yet — the desktop POS must run cloud sync first, " +
        "or stock badges all read 'made to order' and prices/catalog may be empty",
    );
  } else {
    console.log(`✓ fulfilment location: ${locationName} (${locationId})`);
  }

  // 4 — web_stores row
  const store = await prisma.webStore.upsert({
    where: { tenantId: tenant.id },
    create: {
      tenantId: tenant.id,
      subdomain,
      customDomain,
      status: "LIVE",
      domainStatus: customDomain ? "PENDING_DNS" : "NONE",
      fulfilmentLocationId: locationId,
      currency: tenant.currency,
    },
    update: {
      subdomain,
      ...(customDomain ? { customDomain } : {}),
      status: "LIVE",
      ...(locationId ? { fulfilmentLocationId: locationId } : {}),
    },
  });

  console.log(
    `✓ web_stores: subdomain="${store.subdomain}"  customDomain=${store.customDomain ?? "(none)"}  ` +
      `status=${store.status}  currency=${store.currency}`,
  );

  console.log("\n─────────────────────────────────────────────");
  console.log("Point the storefront at it (NEXT/storefront/.env.local):");
  console.log(`  DEV_STORE_DOMAIN=${customDomain ?? `${subdomain}.localhost:3200`}`);
  console.log("(the subdomain form must match SERVER's STOREFRONT_BASE_DOMAIN)");
  console.log("Then: cd NEXT/storefront && npm run dev  →  http://localhost:3200");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
