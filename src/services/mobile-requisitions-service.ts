import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileSession } from "../middleware/mobile-auth.js";
import {
  mobileApproveRequisitionSchema,
  mobileCreateRequisitionSchema,
  mobileLinkRequisitionItemSchema,
  mobileRejectRequisitionSchema,
} from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";
import { createPurchaseInTx } from "./mobile-purchases-service.js";

/**
 * Purchase requisitions from the phone — DESKTOP's purchase-requisition-service.ts, written straight
 * into the synced PurchaseRequisition table (deviceId "owner-app", syncedAt bumped on every write) so
 * every till pulls the change, exactly like mobile purchases. Same rules as DESKTOP:
 *   - anyone with purchase_requisitions.create raises one, for their own storefront if branch-scoped;
 *   - lines are catalog products or free-text items; approvers link free-text lines to a product;
 *   - approving creates exactly one Purchase (the same createPurchase path the Purchases tab uses) and
 *     marks the requisition approved in the SAME transaction;
 *   - the requester (or an approver) can cancel while pending; an approver can reject with a reason.
 * items JSON shape matches DESKTOP's sync payload: {id, productId|null, itemName, quantityRequested,
 * notes, createdAt}.
 */

const REQUISITION_PREFIX = "REQ";
const REQUISITION_DIGITS = 6;
const NON_STOREFRONT_TYPES = new Set(["distribution_center", "warehouse"]);

type StoredRequisitionItem = {
  id: string;
  productId: string | null;
  itemName: string;
  quantityRequested: number;
  notes: string | null;
  createdAt: string;
};

export type MobileRequisitionListItem = {
  id: string;
  requisitionNumber: string;
  storefrontId: string;
  storefrontName: string;
  status: string;
  itemCount: number;
  totalQuantityRequested: number;
  unlinkedItemCount: number;
  notes: string | null;
  rejectionReason: string | null;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  purchaseId: string | null;
  purchaseNumber: string | null;
  purchaseStatus: string | null;
};

export type MobileRequisitionItem = {
  id: string;
  productId: string | null;
  itemName: string;
  productName: string | null;
  sku: string | null;
  taxType: string | null;
  sellingPriceCents: number | null;
  trackStock: boolean | null;
  quantityRequested: number;
  notes: string | null;
};

export type MobileRequisitionDetail = MobileRequisitionListItem & { items: MobileRequisitionItem[] };

type RequisitionRow = Awaited<ReturnType<Prisma.TransactionClient["purchaseRequisition"]["findUniqueOrThrow"]>>;

function asItems(value: unknown): StoredRequisitionItem[] {
  return Array.isArray(value) ? (value as StoredRequisitionItem[]) : [];
}

async function loadActor(tx: Prisma.TransactionClient, session: MobileSession) {
  const actor = await tx.employee.findUniqueOrThrow({ where: { id: session.employeeId } });
  return {
    id: actor.id,
    branchScope: session.isSuperAdmin ? null : actor.branchId,
    mobileDeviceSequence: actor.mobileDeviceSequence,
  };
}

function can(session: MobileSession, action: string): boolean {
  return Boolean(session.isSuperAdmin) || (session.permissions?.purchase_requisitions?.includes(action) ?? false);
}

/** "Not found" (not 403) for another storefront's requisition, so ids can't be probed. */
async function loadVisible(tx: Prisma.TransactionClient, session: MobileSession, id: string, branchScope: string | null): Promise<RequisitionRow> {
  const row = await tx.purchaseRequisition.findUnique({ where: { id } });
  if (!row || row.tenantId !== session.tenantId || (branchScope && row.storefrontId !== branchScope)) {
    throw new NotFoundError("Requisition not found");
  }
  return row;
}

function requirePending(row: RequisitionRow): void {
  if (row.status !== "pending") throw new HttpError(400, `This requisition is already ${row.status}`);
}

/** Names for the opaque storefront/employee/purchase ids (no Prisma relations across synced tables). */
async function describe(tx: Prisma.TransactionClient, rows: RequisitionRow[]): Promise<MobileRequisitionListItem[]> {
  const employeeIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.reviewedBy].filter((v): v is string => Boolean(v))))];
  const locationIds = [...new Set(rows.map((r) => r.storefrontId))];
  const purchaseIds = rows.map((r) => r.purchaseId).filter((v): v is string => Boolean(v));
  const [employees, locations, purchases] = await Promise.all([
    tx.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
    tx.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, locationName: true } }),
    purchaseIds.length
      ? tx.purchase.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, purchaseNumber: true, status: true } })
      : Promise.resolve([]),
  ]);
  const employeeName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
  const locationName = new Map(locations.map((l) => [l.id, l.locationName]));
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));

  return rows.map((r) => {
    const items = asItems(r.items);
    const purchase = r.purchaseId ? purchaseById.get(r.purchaseId) : undefined;
    return {
      id: r.id,
      requisitionNumber: r.requisitionNumber,
      storefrontId: r.storefrontId,
      storefrontName: locationName.get(r.storefrontId) ?? "—",
      status: r.status,
      itemCount: items.length,
      totalQuantityRequested: items.reduce((sum, i) => sum + i.quantityRequested, 0),
      unlinkedItemCount: items.filter((i) => !i.productId).length,
      notes: r.notes,
      rejectionReason: r.rejectionReason,
      requestedBy: r.requestedBy,
      requestedByName: employeeName.get(r.requestedBy) ?? "—",
      requestedAt: r.requestedAt.toISOString(),
      reviewedByName: r.reviewedBy ? (employeeName.get(r.reviewedBy) ?? "—") : null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      purchaseId: r.purchaseId,
      purchaseNumber: purchase?.purchaseNumber ?? null,
      purchaseStatus: purchase?.status ?? null,
    };
  });
}

async function buildDetail(tx: Prisma.TransactionClient, row: RequisitionRow): Promise<MobileRequisitionDetail> {
  const [summary] = await describe(tx, [row]);
  const items = asItems(row.items);
  const productIds = items.map((i) => i.productId).filter((v): v is string => Boolean(v));
  const products = productIds.length
    ? await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, sku: true, taxType: true, sellingPriceCents: true, trackStock: true },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  return {
    ...summary!,
    items: items.map((i) => {
      const product = i.productId ? productById.get(i.productId) : undefined;
      return {
        id: i.id,
        productId: i.productId,
        itemName: i.itemName,
        productName: product?.name ?? null,
        sku: product?.sku ?? null,
        taxType: product?.taxType ?? null,
        sellingPriceCents: product?.sellingPriceCents ?? null,
        trackStock: product?.trackStock ?? null,
        quantityRequested: i.quantityRequested,
        notes: i.notes,
      };
    }),
  };
}

export async function listRequisitions(session: MobileSession): Promise<MobileRequisitionListItem[]> {
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const rows = await tx.purchaseRequisition.findMany({
      where: { tenantId: session.tenantId, ...(actor.branchScope ? { storefrontId: actor.branchScope } : {}) },
      orderBy: { localCreatedAt: "desc" },
      take: 300,
    });
    return describe(tx, rows);
  });
}

export async function getRequisition(session: MobileSession, id: string): Promise<MobileRequisitionDetail> {
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    return buildDetail(tx, await loadVisible(tx, session, id, actor.branchScope));
  });
}

export async function createRequisition(session: MobileSession, input: unknown): Promise<{ id: string; requisitionNumber: string }> {
  const parsed = mobileCreateRequisitionSchema.parse(input);
  const id = parsed.id.startsWith("preq_") ? parsed.id : `preq_${parsed.id}`;
  const now = new Date();

  return withTenantContext(session.tenantId, async (tx) => {
    const existing = await tx.purchaseRequisition.findUnique({ where: { id }, select: { id: true, requisitionNumber: true } });
    if (existing) return existing;

    const actor = await loadActor(tx, session);
    const storefrontId = actor.branchScope ?? parsed.storefrontId;
    if (!storefrontId) throw new HttpError(400, "Choose which storefront this requisition is for");
    const location = await tx.location.findUnique({ where: { id: storefrontId } });
    if (!location || location.tenantId !== session.tenantId || NON_STOREFRONT_TYPES.has(location.locationType)) {
      throw new NotFoundError("Storefront not found");
    }

    const productIds = parsed.items.map((i) => i.productId).filter((v): v is string => Boolean(v));
    const products = productIds.length
      ? await tx.product.findMany({ where: { tenantId: session.tenantId, id: { in: productIds } }, select: { id: true, name: true } })
      : [];
    const productName = new Map(products.map((p) => [p.id, p.name]));
    const nowIso = now.toISOString();
    const items: StoredRequisitionItem[] = parsed.items.map((item) => {
      if (item.productId && !productName.has(item.productId)) throw new NotFoundError("One of the selected products was not found");
      return {
        id: `preqi_${randomUUID()}`,
        productId: item.productId ?? null,
        // Catalog lines snapshot the product's name, so the requisition always shows what was asked for.
        itemName: item.productId ? productName.get(item.productId)! : item.itemName,
        quantityRequested: item.quantity,
        notes: item.notes,
        createdAt: nowIso,
      };
    });

    const sequence = await ensureEmployeeMobileSequence(tx, session.tenantId, actor.id, actor.mobileDeviceSequence);
    const requisitionNumber = await mintMobileDocumentNumber(tx, session.tenantId, sequence, REQUISITION_PREFIX, REQUISITION_DIGITS);
    await tx.purchaseRequisition.create({
      data: {
        id,
        tenantId: session.tenantId,
        deviceId: OWNER_APP_DEVICE_ID,
        requisitionNumber,
        storefrontId,
        status: "pending",
        notes: parsed.notes,
        requestedBy: actor.id,
        requestedAt: now,
        items: items as unknown as Prisma.InputJsonValue,
        localCreatedAt: now,
        localUpdatedAt: now,
      },
    });
    return { id, requisitionNumber };
  });
}

/** The requester can withdraw their own pending requisition; an approver can withdraw anyone's. */
export async function cancelRequisition(session: MobileSession, id: string): Promise<{ id: string }> {
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const row = await loadVisible(tx, session, id, actor.branchScope);
    requirePending(row);
    if (row.requestedBy !== actor.id && !can(session, "approve")) {
      throw new HttpError(403, "Only the person who raised this requisition (or an approver) can cancel it");
    }
    await tx.purchaseRequisition.update({
      where: { id },
      data: { status: "cancelled", reviewedBy: actor.id, reviewedAt: now, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id };
  });
}

export async function rejectRequisition(session: MobileSession, id: string, input: unknown): Promise<{ id: string }> {
  const parsed = mobileRejectRequisitionSchema.parse(input);
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const row = await loadVisible(tx, session, id, actor.branchScope);
    requirePending(row);
    await tx.purchaseRequisition.update({
      where: { id },
      data: {
        status: "rejected",
        rejectionReason: parsed.reason,
        reviewedBy: actor.id,
        reviewedAt: now,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id };
  });
}

/** Links one line (normally a free-text one) to a catalog product, ahead of conversion. */
export async function linkRequisitionItem(session: MobileSession, id: string, input: unknown): Promise<MobileRequisitionDetail> {
  const parsed = mobileLinkRequisitionItemSchema.parse(input);
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const row = await loadVisible(tx, session, id, actor.branchScope);
    requirePending(row);
    const items = asItems(row.items);
    if (!items.some((i) => i.id === parsed.itemId)) throw new NotFoundError("That line was not found on this requisition");
    const product = await tx.product.findUnique({ where: { id: parsed.productId }, select: { id: true, tenantId: true } });
    if (!product || product.tenantId !== session.tenantId) throw new NotFoundError("Product not found");

    const updated = await tx.purchaseRequisition.update({
      where: { id },
      data: {
        items: items.map((i) => (i.id === parsed.itemId ? { ...i, productId: product.id } : i)) as unknown as Prisma.InputJsonValue,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return buildDetail(tx, updated);
  });
}

/**
 * Approves by creating the purchase it becomes — the body is exactly what the New Purchase sheet
 * sends, so every purchase rule applies unchanged (createPurchaseInTx). Destination is always the
 * requisition's own storefront. Purchase + "approved" commit together. The route also requires
 * purchases.create: the approver is creating a purchase.
 */
export async function approveRequisition(session: MobileSession, id: string, input: unknown): Promise<{ id: string; purchaseId: string }> {
  const parsed = mobileApproveRequisitionSchema.parse(input);
  const now = new Date();
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const row = await loadVisible(tx, session, id, actor.branchScope);
    requirePending(row);
    const unlinked = asItems(row.items).filter((i) => !i.productId);
    if (unlinked.length > 0) {
      throw new HttpError(
        400,
        `Link every new item to a product before converting — still unlinked: ${unlinked.map((i) => `"${i.itemName}"`).join(", ")}`,
      );
    }

    const purchase = await createPurchaseInTx(tx, session, {
      ...parsed,
      locationId: row.storefrontId,
      notes: parsed.notes ?? `From requisition ${row.requisitionNumber}`,
    });
    await tx.purchaseRequisition.update({
      where: { id },
      data: {
        status: "approved",
        purchaseId: purchase.id,
        rejectionReason: null,
        reviewedBy: actor.id,
        reviewedAt: now,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      },
    });
    return { id, purchaseId: purchase.id };
  });
}

/** Pending requisitions this approver can act on — the Requisitions tab's badge. */
export async function countPendingRequisitions(session: MobileSession): Promise<{ pending: number }> {
  return withTenantContext(session.tenantId, async (tx) => {
    const actor = await loadActor(tx, session);
    const pending = await tx.purchaseRequisition.count({
      where: { tenantId: session.tenantId, status: "pending", ...(actor.branchScope ? { storefrontId: actor.branchScope } : {}) },
    });
    return { pending };
  });
}
