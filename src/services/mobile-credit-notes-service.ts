import { HttpError, NotFoundError } from "../lib/http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "../lib/mobile-numbering.js";
import { refundOfReturn } from "../lib/invoice-credit.js";
import { withTenantContext } from "../lib/tenant-context.js";
import { OWNER_APP_DEVICE_ID } from "./mobile-checkout-service.js";

/**
 * Credit notes on the phone: the list on a receipt or invoice, and issuing the CN number for a receipt
 * return when someone wants the document (an invoice credit note gets its number when approved — see
 * lib/invoice-credit.ts settleCreditNote). Same rules as DESKTOP's sale-return-service.ts.
 */

export type MobileCreditNoteListItem = {
  id: string;
  status: string;
  creditNoteNumber: string | null;
  amountCents: number;
  /** Paid back; null until approved. */
  refundCents: number | null;
  lines: string[];
  requestedAt: string;
};

type ReturnLine = { productId: string; quantity: number; lineTotalCents?: number };

/** Every return on a sale that isn't rejected, newest first. */
export async function listSaleCreditNotes(tenantId: string, saleId: string): Promise<MobileCreditNoteListItem[]> {
  return withTenantContext(tenantId, async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: saleId }, select: { tenantId: true } });
    if (!sale || sale.tenantId !== tenantId) throw new NotFoundError("Sale not found");
    const returns = await tx.saleReturn.findMany({ where: { tenantId, saleId, status: { not: "rejected" } }, orderBy: { requestedAt: "desc" } });
    const productIds = [...new Set(returns.flatMap((row) => (Array.isArray(row.items) ? (row.items as unknown as ReturnLine[]) : []).map((line) => line.productId)))];
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
    const nameById = new Map(products.map((product) => [product.id, product.name]));
    return returns.map((row) => {
      const lines = Array.isArray(row.items) ? (row.items as unknown as ReturnLine[]) : [];
      return {
        id: row.id,
        status: row.status,
        creditNoteNumber: row.creditNoteNumber,
        amountCents: lines.reduce((sum, line) => sum + (line.lineTotalCents ?? 0), 0),
        refundCents: row.status === "approved" ? refundOfReturn(row) : null,
        lines: lines.map((line) => `${line.quantity} × ${nameById.get(line.productId) ?? "Item"}`),
        requestedAt: row.requestedAt.toISOString(),
      };
    });
  });
}

/** Gives an approved return its CN number the first time (display only: stock and money were
 * settled on approval), so it can be shared. Calling it again keeps the same number. */
export async function issueCreditNote(tenantId: string, employeeId: string, returnId: string): Promise<{ id: string; creditNoteNumber: string }> {
  return withTenantContext(tenantId, async (tx) => {
    const row = await tx.saleReturn.findUnique({ where: { id: returnId } });
    if (!row || row.tenantId !== tenantId) throw new NotFoundError("Return not found");
    if (row.status !== "approved") throw new HttpError(400, "A credit note can only be issued once the return is approved");
    if (row.creditNoteNumber) return { id: row.id, creditNoteNumber: row.creditNoteNumber };
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { mobileDeviceSequence: true } });
    const sequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
    const creditNoteNumber = await mintMobileDocumentNumber(tx, tenantId, sequence, "CN", 6);
    const now = new Date();
    await tx.saleReturn.update({
      where: { id: returnId },
      data: { creditNoteNumber, deviceId: OWNER_APP_DEVICE_ID, localUpdatedAt: now, syncedAt: now },
    });
    return { id: row.id, creditNoteNumber };
  });
}
