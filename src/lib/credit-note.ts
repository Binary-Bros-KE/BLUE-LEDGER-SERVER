/**
 * COPY of DESKTOP src/shared/lib/credit-note.ts (tested there: tests/credit-note.test.ts). Keep the
 * copies identical, so a till and the phone always settle a credit note the same way.
 *
 * A credit note is an approved return on an invoice. Client spec: it reduces what the customer still
 * owes first, and only the part beyond that is refunded (money out). An unpaid invoice therefore
 * refunds nothing; a fully paid one refunds the whole credit.
 */

/** What's still owed on an invoice once its approved credit notes are taken off. Never negative:
 * money paid beyond that has been (or is being) refunded. */
export function invoiceBalanceCents(grandTotalCents: number, amountPaidCents: number, creditedCents: number): number {
  return Math.max(0, grandTotalCents - amountPaidCents - creditedCents);
}

export type CreditSplit = {
  /** Owed before this credit note. */
  balanceBeforeCents: number;
  /** Owed after it: what the invoice's balance becomes. */
  balanceAfterCents: number;
  /** The part of the credit that took the balance down. */
  balanceReductionCents: number;
  /** The part beyond what was owed: paid back to the customer. */
  refundCents: number;
};

export function splitCredit(params: {
  grandTotalCents: number;
  amountPaidCents: number;
  /** Credit notes already approved on this invoice, not counting this one. */
  previouslyCreditedCents: number;
  creditCents: number;
}): CreditSplit {
  const balanceBeforeCents = invoiceBalanceCents(params.grandTotalCents, params.amountPaidCents, params.previouslyCreditedCents);
  const balanceReductionCents = Math.min(balanceBeforeCents, params.creditCents);
  return {
    balanceBeforeCents,
    balanceAfterCents: balanceBeforeCents - balanceReductionCents,
    balanceReductionCents,
    refundCents: params.creditCents - balanceReductionCents
  };
}
