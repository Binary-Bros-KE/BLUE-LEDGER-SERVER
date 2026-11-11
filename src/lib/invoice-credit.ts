import type { Prisma } from "@prisma/client";
import { splitCredit } from "./credit-note.js";
import { HttpError } from "./http-error.js";
import { ensureEmployeeMobileSequence, mintMobileDocumentNumber } from "./mobile-numbering.js";
import { computePaymentStatus } from "../services/share-service.js";

/**
 * Credit notes from the phone — the same rules as DESKTOP's sale-return-service.ts approveSaleReturn.
 * A credit note is an approved return on an invoice: it takes stock back (done by the caller, like any
 * return), reduces what the customer still owes first and refunds only the rest (lib/credit-note.ts,
 * a copy of DESKTOP's), and gets a CN number straight away.
 */

const OWNER_APP_DEVICE_ID = "owner-app";

type ReturnItem = { lineTotalCents?: number };

function itemsValue(items: unknown): number {
  return Array.isArray(items) ? (items as ReturnItem[]).reduce((sum, item) => sum + (item.lineTotalCents ?? 0), 0) : 0;
}

/** Value of every APPROVED return on a sale (for an invoice, what its credit notes took off). */
export async function creditedValueForSale(tx: Prisma.TransactionClient, tenantId: string, saleId: string, excludeReturnId?: string): Promise<number> {
  const returns = await tx.saleReturn.findMany({
    where: { tenantId, saleId, status: "approved", ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}) },
    select: { items: true },
  });
  return returns.reduce((sum, row) => sum + itemsValue(row.items), 0);
}

/** Pending or approved returns on a sale. An invoice with any can no longer be edited or cancelled:
 * both would restock (and cancelling would refund) the credited part a second time. */
export async function countOpenReturns(tx: Prisma.TransactionClient, tenantId: string, saleId: string): Promise<number> {
  return tx.saleReturn.count({ where: { tenantId, saleId, status: { not: "rejected" } } });
}

export async function assertNoCreditNotes(tx: Prisma.TransactionClient, tenantId: string, saleId: string, action: "edited" | "cancelled"): Promise<void> {
  if ((await countOpenReturns(tx, tenantId, saleId)) === 0) return;
  throw new HttpError(
    400,
    action === "edited"
      ? "This invoice has a credit note and can no longer be edited — issue another credit note instead."
      : "This invoice has a credit note and can't be cancelled — issue a credit note for the remaining items instead.",
  );
}

/** Settles an invoice credit note once its return is approved: the invoice's new balance and status,
 * the amount refunded, and its CN number. Does nothing for a receipt return (its whole value is the
 * refund, as it always was). */
export async function settleCreditNote(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; employeeId: string; returnId: string; saleId: string; now: Date },
): Promise<void> {
  const { tenantId, employeeId, returnId, saleId, now } = params;
  const [sale, ret] = await Promise.all([
    tx.sale.findUnique({ where: { id: saleId } }),
    tx.saleReturn.findUnique({ where: { id: returnId }, select: { items: true, creditNoteNumber: true } }),
  ]);
  if (!sale || !ret || !sale.invoiceNumber) return;

  const split = splitCredit({
    grandTotalCents: sale.grandTotalCents,
    amountPaidCents: sale.amountPaidCents,
    previouslyCreditedCents: await creditedValueForSale(tx, tenantId, saleId, returnId),
    creditCents: itemsValue(ret.items),
  });
  await tx.sale.update({
    where: { id: saleId },
    data: {
      balanceDueCents: split.balanceAfterCents,
      paymentStatus: computePaymentStatus({ balanceDueCents: split.balanceAfterCents, amountPaidCents: sale.amountPaidCents, dueDate: sale.dueDate, cancelled: false }),
      deviceId: OWNER_APP_DEVICE_ID,
      localUpdatedAt: now,
      syncedAt: now,
    },
  });

  const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { mobileDeviceSequence: true } });
  const sequence = await ensureEmployeeMobileSequence(tx, tenantId, employeeId, employee.mobileDeviceSequence);
  await tx.saleReturn.update({
    where: { id: returnId },
    data: {
      creditNoteNumber: ret.creditNoteNumber ?? (await mintMobileDocumentNumber(tx, tenantId, sequence, "CN", 6)),
      refundCents: split.refundCents,
      deviceId: OWNER_APP_DEVICE_ID,
      localUpdatedAt: now,
      syncedAt: now,
    },
  });
}

/** Money paid back for an approved return: what an invoice credit note refunded, or (null) a receipt
 * return's whole value. */
export function refundOfReturn(row: { refundCents: number | null; items: unknown }): number {
  return row.refundCents ?? itemsValue(row.items);
}
