import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HttpError } from "./http-error.js";

/**
 * "Which of this reseller's products currently follow a supplier's stock?" — the one question every
 * sale/stock path asks. A product only counts while its tenant has dropshippingEnabled AND its
 * connection is active, so turning dropshipping off or pausing a supplier instantly hands the product
 * back to ordinary stock handling everywhere. Links are a registry table (not RLS-protected), read
 * here through whichever client the caller is in; for a tenant with no connections this is one
 * indexed lookup returning nothing.
 */
export type DropshipLinkedProduct = { supplierName: string; asOf: Date | null };

export async function findDropshipLinks(
  client: Prisma.TransactionClient,
  tenantId: string,
  productIds?: string[],
): Promise<Map<string, DropshipLinkedProduct>> {
  if (productIds?.length === 0) return new Map();
  const links = await client.dropshipProductLink.findMany({
    where: {
      ...(productIds ? { resellerProductId: { in: productIds } } : {}),
      connection: { resellerTenantId: tenantId, status: "active", reseller: { dropshippingEnabled: true } },
    },
    select: { resellerProductId: true, connection: { select: { supplier: { select: { name: true, lastCloudSync: true } } } } },
  });
  return new Map(
    links.map((l) => [l.resellerProductId, { supplierName: l.connection.supplier.name, asOf: l.connection.supplier.lastCloudSync }]),
  );
}

/** Manual stock changes are refused on a linked product: its number is the supplier's, and the next
 * mirror pass would silently undo the change anyway. */
export async function assertNotDropshipLinked(tx: Prisma.TransactionClient, tenantId: string, productIds: string[]): Promise<void> {
  const links = await findDropshipLinks(tx, tenantId, productIds);
  const [first] = links.values();
  if (first) {
    throw new HttpError(400, `This product's stock follows ${first.supplierName} and can't be changed here`);
  }
}

export type DropshipLinkList = { version: string; links: Array<{ productId: string; supplierName: string }> };

/** What a dropshipping tenant's desktops keep locally. Deliberately NOT part of product sync: nothing
 * about a product row changes when it's linked, so no product timestamp is bumped and no real edit can
 * ever conflict with a link change. `version` lets a device skip refetching an unchanged list. */
export async function getDropshipLinkList(tenantId: string): Promise<DropshipLinkList> {
  const links = [...(await findDropshipLinks(prisma, tenantId))]
    .map(([productId, link]) => ({ productId, supplierName: link.supplierName }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const version = createHash("sha1").update(JSON.stringify(links)).digest("hex");
  return { version, links };
}

export type DropshipHeartbeat = { version: string; suppliers: Array<{ name: string; asOf: string | null }> };

/** Heartbeat summary — only ever computed for a tenant with dropshippingEnabled. */
export async function getDropshipHeartbeat(tenantId: string): Promise<DropshipHeartbeat> {
  const [{ version }, connections] = await Promise.all([
    getDropshipLinkList(tenantId),
    prisma.dropshipConnection.findMany({
      where: { resellerTenantId: tenantId, status: "active" },
      select: { supplier: { select: { name: true, lastCloudSync: true } } },
    }),
  ]);
  return {
    version,
    suppliers: connections.map((c) => ({ name: c.supplier.name, asOf: c.supplier.lastCloudSync?.toISOString() ?? null })),
  };
}
