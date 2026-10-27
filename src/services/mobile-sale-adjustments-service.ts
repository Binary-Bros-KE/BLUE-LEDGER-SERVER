import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { restockInvoiceStock } from "../lib/invoice-stock.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { prisma } from "../prisma.js";
import { mobileCancellationDecisionSchema, mobileSaleVoidRequestSchema } from "../schemas/mobile.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

/**
 * Sale voids and returns on the Owner App — the request side, the approval side, and "approve now".
 * Ports of DESKTOP's sale-void-service.ts / sale-return-service.ts:
 *  - a request (sales.edit) changes nothing but itself — "pending_approval";
 *  - approving (approvals.approve) puts the stock back where each line came from — a "return"
 *    movement, via the same restockInvoiceStock helper invoice cancellation uses (DESKTOP's
 *    restockInvoiceLineStock rule: Main Store lines go back into the selling storefront's earmark);
 *    rejecting just marks the request decided.
 *  - "approve now": someone who holds approvals.approve can void/return in one step. It is stored
 *    exactly as a request followed immediately by that person's approval (same row, same
 *    approvedBy), so DESKTOP and every report see nothing unusual.
 * Rows keep DESKTOP's exact shapes and are stamped deviceId "owner-app" + fresh localUpdatedAt/syncedAt.
 */

const PENDING = "pending_approval";

type SaleLine = { id: string; productId: string; quantity: number; unitPriceCents: number; isLocallySourced?: boolean; stockLocationId?: string | null };
type ReturnLine = { saleItemId: string; productId: string; quantity: number; lineTotalCents?: number };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function loadCompletedSale(tx: Prisma.TransactionClient, tenantId: string, saleId: string) {
  const sale = await tx.sale.findUnique({ where: { id: saleId } });
  if (!sale || sale.tenantId !== tenantId) throw new NotFoundError("Sale not found");
  return sale;
}

/** Restocks every line of a voided sale (DESKTOP's approveSaleVoid). */
async function restockVoid(tx: Prisma.TransactionClient, tenantId: string, employeeId: string, voidId: string, saleId: string, now: Date): Promise<void> {
  const sale = await loadCompletedSale(tx, tenantId, saleId);
  const lines = asArray<SaleLine>(sale.items).map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    isLocallySourced: l.isLocallySourced ?? false,
    ...(l.stockLocationId !== undefined ? { stockLocationId: l.stockLocationId } : {}),
  }));
  await restockInvoiceStock(tx, { tenantId, employeeId, sale, items: lines, referenceType: "sale_void", referenceId: voidId, now });
}

/** Restocks just the returned quantities, each back where ITS sale line came from (DESKTOP's
 * approveSaleReturn). Exported for mobile-sales-service.ts's "return now". */
export async function restockReturn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  returnId: string,
  saleId: string,
  returnLines: ReturnLine[],
  now: Date,
): Promise<void> {
  const sale = await loadCompletedSale(tx, tenantId, saleId);
  const saleLineById = new Map(asArray<SaleLine>(sale.items).map((l) => [l.id, l]));
  const lines = returnLines.map((r) => {
    const saleLine = saleLineById.get(r.saleItemId);
    return {
      productId: r.productId,
      quantity: r.quantity,
      isLocallySourced: saleLine?.isLocallySourced ?? false,
      ...(saleLine && saleLine.stockLocationId !== undefined ? { stockLocationId: saleLine.stockLocationId } : {}),
    };
  });
  await restockInvoiceStock(tx, { tenantId, employeeId, sale, items: lines, referenceType: "sale_return", referenceId: returnId, now });
}

/** DESKTOP's requestSaleVoid; `approveNow` (caller must hold approvals.approve — checked by the route)
 * records it approved and restocks in the same transaction. */
export async function requestSaleVoid(
  tenantId: string,
  employeeId: string,
  saleId: string,
  input: unknown,
  approveNow: boolean,
): Promise<{ id: string; status: string }> {
  const parsed = mobileSaleVoidRequestSchema.parse(input);
  return withTenantContext(
    tenantId,
    async (tx) => {
      const sale = await loadCompletedSale(tx, tenantId, saleId);
      if (sale.saleStatus !== "completed") throw new HttpError(400, "Only completed sales can be voided");
      const existing = await tx.saleVoid.findFirst({ where: { tenantId, saleId, status: { in: [PENDING, "approved"] } }, select: { status: true } });
      if (existing?.status === "approved") throw new HttpError(400, "This sale has already been voided");
      if (existing) throw new HttpError(400, "This sale already has a void request awaiting approval");

      const now = new Date();
      const id = `sale_void_${randomUUID()}`;
      await tx.saleVoid.create({
        data: {
          id,
          tenantId,
          deviceId: OWNER_APP_DEVICE_ID,
          saleId,
          status: approveNow ? "approved" : PENDING,
          reason: parsed.reason,
          notes: parsed.notes ?? null,
          requestedBy: employeeId,
          requestedAt: now,
          approvedBy: approveNow ? employeeId : null,
          approvedAt: approveNow ? now : null,
          localCreatedAt: now,
          localUpdatedAt: now,
        },
      });
      if (approveNow) await restockVoid(tx, tenantId, employeeId, id, saleId, now);
      return { id, status: approveNow ? "approved" : PENDING };
    },
    { timeoutMs: 15_000 },
  );
}

export type MobilePendingSaleAdjustment = {
  kind: "void" | "return";
  id: string;
  saleId: string;
  documentNumber: string | null;
  saleGrandTotalCents: number;
  /** For a return: the value of the lines being returned. For a void: the whole sale. */
  amountCents: number;
  locationName: string;
  reason: string;
  notes: string | null;
  requestedByName: string;
  requestedAt: string;
  /** Return lines, "2 × Sugar 1kg" — empty for a void. */
  lines: string[];
  currency: string;
};

/** The Approvals tab's void + return queue, oldest first. */
export async function listPendingSaleAdjustments(tenantId: string): Promise<MobilePendingSaleAdjustment[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { currency: true } });
  return withTenantContext(tenantId, async (tx) => {
    const [voids, returns] = await Promise.all([
      tx.saleVoid.findMany({ where: { tenantId, status: PENDING }, orderBy: { requestedAt: "asc" } }),
      tx.saleReturn.findMany({ where: { tenantId, status: PENDING }, orderBy: { requestedAt: "asc" } }),
    ]);
    if (voids.length === 0 && returns.length === 0) return [];

    const saleIds = [...new Set([...voids.map((v) => v.saleId), ...returns.map((r) => r.saleId)])];
    const employeeIds = [...new Set([...voids.map((v) => v.requestedBy), ...returns.map((r) => r.requestedBy)])];
    const returnProductIds = [...new Set(returns.flatMap((r) => asArray<ReturnLine>(r.items).map((l) => l.productId)))];
    const [sales, employees, products] = await Promise.all([
      tx.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, receiptNumber: true, invoiceNumber: true, grandTotalCents: true, locationId: true } }),
      tx.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }),
      tx.product.findMany({ where: { id: { in: returnProductIds } }, select: { id: true, name: true } }),
    ]);
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const locations = await tx.location.findMany({ where: { id: { in: [...new Set(sales.map((s) => s.locationId))] } }, select: { id: true, locationName: true } });
    const locationName = new Map(locations.map((l) => [l.id, l.locationName]));
    const employeeName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const productName = new Map(products.map((p) => [p.id, p.name]));

    const rows: MobilePendingSaleAdjustment[] = [];
    for (const v of voids) {
      const sale = saleById.get(v.saleId);
      if (!sale) continue;
      rows.push({
        kind: "void",
        id: v.id,
        saleId: v.saleId,
        documentNumber: sale.invoiceNumber ?? sale.receiptNumber,
        saleGrandTotalCents: sale.grandTotalCents,
        amountCents: sale.grandTotalCents,
        locationName: locationName.get(sale.locationId) ?? "—",
        reason: v.reason,
        notes: v.notes,
        requestedByName: employeeName.get(v.requestedBy) ?? "—",
        requestedAt: v.requestedAt.toISOString(),
        lines: [],
        currency: tenant.currency,
      });
    }
    for (const r of returns) {
      const sale = saleById.get(r.saleId);
      if (!sale) continue;
      const lines = asArray<ReturnLine>(r.items);
      rows.push({
        kind: "return",
        id: r.id,
        saleId: r.saleId,
        documentNumber: sale.invoiceNumber ?? sale.receiptNumber,
        saleGrandTotalCents: sale.grandTotalCents,
        amountCents: lines.reduce((sum, l) => sum + (l.lineTotalCents ?? 0), 0),
        locationName: locationName.get(sale.locationId) ?? "—",
        reason: r.reason,
        notes: r.notes,
        requestedByName: employeeName.get(r.requestedBy) ?? "—",
        requestedAt: r.requestedAt.toISOString(),
        lines: lines.map((l) => `${l.quantity} × ${productName.get(l.productId) ?? "Unknown product"}`),
        currency: tenant.currency,
      });
    }
    return rows.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  });
}

/** Approve or reject a pending void/return (approvals.approve). Approving restocks. */
export async function decideSaleAdjustment(
  tenantId: string,
  employeeId: string,
  kind: "void" | "return",
  id: string,
  decision: "approved" | "rejected",
  input: unknown,
): Promise<{ id: string; saleId: string }> {
  const { notes } = mobileCancellationDecisionSchema.parse(input ?? {});
  return withTenantContext(
    tenantId,
    async (tx) => {
      const row = kind === "void" ? await tx.saleVoid.findUnique({ where: { id } }) : await tx.saleReturn.findUnique({ where: { id } });
      if (!row || row.tenantId !== tenantId) throw new NotFoundError(kind === "void" ? "Void request not found" : "Return request not found");
      if (row.status !== PENDING) throw new HttpError(400, "This request has already been decided");

      const now = new Date();
      if (decision === "approved") {
        if (kind === "void") await restockVoid(tx, tenantId, employeeId, id, row.saleId, now);
        else await restockReturn(tx, tenantId, employeeId, id, row.saleId, asArray<ReturnLine>("items" in row ? row.items : []), now);
      }
      const data = {
        status: decision,
        approvedBy: employeeId,
        approvedAt: now,
        notes: notes?.trim() || row.notes,
        deviceId: OWNER_APP_DEVICE_ID,
        localUpdatedAt: now,
        syncedAt: now,
      };
      if (kind === "void") await tx.saleVoid.update({ where: { id }, data });
      else await tx.saleReturn.update({ where: { id }, data });
      return { id, saleId: row.saleId };
    },
    { timeoutMs: 15_000 },
  );
}
