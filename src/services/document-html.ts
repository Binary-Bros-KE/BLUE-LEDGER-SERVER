import { formatDocumentDate, formatDocumentDateTime } from "../lib/document-date.js";
import { taxBreakdownLabel, type TaxBreakdownEntry } from "../lib/tax-breakdown.js";
import { formatMoney } from "./share-service.js";
import type {
  SharedDeliveryNoteResult,
  SharedDocumentResult,
  SharedLineItem,
  SharedResult,
  SharedStatementResult,
} from "./share-service.js";

// ---------------------------------------------------------------------------------------------
// Ported, line-for-line where possible, from DESKTOP's src/main/services/printer-service.ts
// (buildReceiptHtml/buildInvoiceHtml/buildQuotationHtml/buildDeliveryNoteHtml) — the exact same
// templates DESKTOP renders to PDF via Electron's webContents.printToPDF(). The public share page
// renders THIS SAME HTML (via an iframe, see routes/share.ts's "/print" endpoint and SHARE's own
// /api/print proxy) instead of an independently-styled React component, specifically because two
// separate hand-rolled templates for the same document drifted apart and looked like they came from
// different software — see the user's own reaction to that. One deviation, unavoidable: no business
// logo — logo files live only on the device's local filesystem and were never synced to the cloud
// (a real, pre-existing gap, not something this endpoint can paper over without a whole
// image-sync feature). Every other visual detail — fonts, colors, spacing, table columns — matches.
// ---------------------------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ported from DESKTOP's printer-service.ts (buildTaxBreakdownHtml) — the tax breakdown every
 * document renders below its main totals, never contributing to the total itself. */
function buildTaxBreakdownHtml(
  breakdown: TaxBreakdownEntry[],
  vatRatePercent: number,
  money: (cents: number) => string,
): string {
  if (breakdown.length === 0) return "";
  const rows = breakdown
    .map(
      (entry) => `
      <tr>
        <td>${escapeHtml(taxBreakdownLabel(entry.taxType, vatRatePercent))}</td>
        <td class="right">${money(entry.netCents)}</td>
        <td class="right">${money(entry.taxCents)}</td>
        <td class="right">${money(entry.grossCents)}</td>
      </tr>`,
    )
    .join("");
  return `
    <p class="tax-breakdown-title">Tax Breakdown</p>
    <table class="tax-breakdown">
      <thead>
        <tr><th>Category</th><th class="right">Net</th><th class="right">Tax</th><th class="right">Gross</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Shared by buildReceiptDocumentHtml/buildInvoiceDocumentHtml/buildQuotationDocumentHtml — mirrors
 * DESKTOP's own LETTERHEAD_STYLES constant (printer-service.ts) byte-for-byte; kept in sync by hand,
 * no code sharing is possible across the Electron-main/Express runtime boundary. See that constant's
 * own doc comment for why `.items-frame`'s min-height/spacer/margin-top:auto combination exists (the
 * field-reported "the bordered box should fill the page even with one item" request) and why it's
 * 500px, not the originally-tuned 640px (that overflowed onto a 2nd page once "Payments Made" + "Tax
 * Breakdown" — both rendered below this frame — pushed total page height past A4 on a real invoice;
 * 500px was verified against that same real scenario — 7 items + both extra tables — and fits one
 * page with a comfortable margin).
 * `.bill-to`/`.doc-vat`/`.payment-terms`/`table.meta-table` are the same extraction-from-`.meta` DESKTOP's
 * comment describes.
 *
 * `.items-frame`'s flex/min-height treatment is applied CONDITIONALLY via a `.fill-page` modifier
 * class — see DESKTOP's own doc comment for the full story: Electron's printToPDF cannot reliably
 * fragment a flex container across more than one physical page (it silently drops content beyond
 * where it gives up), so a document whose item table genuinely needs 2+ pages must stay a plain
 * block/border, not flex. pdf-service.ts's renderHtmlToPdf toggles the class the same way
 * renderHtmlToPdfBuffer does on DESKTOP (measure the frame's natural height, add `.fill-page` only if
 * it's already under 500px) — this SERVER path renders via Puppeteer's own CDP printToPDF, which
 * fragments flex containers correctly even unconditionally (verified), but the toggle is applied here
 * too anyway so both copies of this template stay behaviorally identical, not just visually. */
const LETTERHEAD_STYLES = `
  * { box-sizing: border-box; }
  /* Every border in this file is the same 1.5px/#4b5563 — see DESKTOP's own copy for why: a thinner
     hairline risked landing on a fractional pixel once rasterized, visibly thinning out (confirmed
     live on a table's own outer right edge) at some zoom levels while other edges stayed crisp — a
     real anti-aliasing artifact of sub-pixel border position, so it'd show up printed too. */
  /* No body padding — see DESKTOP's own copy for why: edge whitespace now comes entirely from
     renderHtmlToPdf's real print margins (all four sides), not CSS padding, since CSS padding on a
     box that fragments across a physical page break isn't guaranteed to keep providing left/right
     whitespace on continuation pages. */
  body { font-family: Arial, Helvetica, sans-serif; color: #1c1710; margin: 0; padding: 0; font-size: 12px; }
  /* max-width was 720px — see DESKTOP's own copy for why 700px: at 720px there was zero slack
     against the ~717px actually available once the 0.4in print margins are subtracted, so the
     rightmost border landed right at (very slightly past) the page's own edge and got clipped. */
  .sheet { max-width: 700px; margin: 0 auto; }
  .header { border-bottom: 1.5px solid #4b5563; }
  .header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
  .logo { display: block; height: auto; max-height: 60px; width: auto; max-width: 200px; object-fit: contain; margin-bottom: 6px; }
  .business-name { font-size: 19px; font-weight: bold; color: #1c1710; margin: 0; }
  .muted { color: #555; font-size: 11px; }
  .invoice-title, .doc-title { font-size: 27px; font-weight: bold; text-align: right; color: #1c1710; margin: 0; letter-spacing: 1.5px; }
  .badge { display: inline-block; margin-top: 6px; padding: 3px 10px; border-radius: 999px; font-size: 10px; font-weight: bold; text-transform: uppercase; background: #f1ede1; color: #1c1710; }

  /* Sits inside .header, below .header-row but ABOVE the header's own border-bottom rule — see
     DESKTOP's own copy for why margin-bottom is small (3px) rather than matching the 14px gap above. */
  .doc-vat { margin: 10px 0 3px; font-size: 10px; font-style: italic; color: #555; }
  .bill-to { margin-top: 12px; }
  .bill-to .label { font-size: 9px; text-transform: uppercase; color: #83795f; font-weight: bold; }
  .bill-to .name { font-size: 13px; font-weight: bold; margin: 2px 0 0; }

  table.meta-table { width: 100%; border-collapse: collapse; margin-top: 8px; border: 1.5px solid #4b5563; }
  table.meta-table th { background: #f0f0f0; color: #1c1710; text-transform: uppercase; font-size: 9px; font-weight: bold; padding: 6px 8px; text-align: left; border-bottom: 1.5px solid #4b5563; }
  table.meta-table th + th, table.meta-table td + td { border-left: 1.5px solid #4b5563; }
  table.meta-table td { padding: 6px 8px; font-size: 11px; font-weight: 600; }
  .payment-terms { margin-top: 8px; font-size: 10.5px; font-style: italic; color: #555; }

  /* box-decoration-break: clone — see DESKTOP's own copy for why: without it, a bordered box that
     fragments across a page break only shows its border at the very start/end of the whole box, not
     on each individual page fragment, making it look cut open instead of continuing cleanly. */
  .items-frame { border: 1.5px solid #4b5563; margin-top: 12px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .items-frame.fill-page { display: flex; flex-direction: column; min-height: 500px; }
  table.items-table { width: 100%; border-collapse: collapse; }
  table.items-table th { text-align: left; font-size: 10px; text-transform: uppercase; font-weight: bold; padding: 7px 8px; border-bottom: 1.5px solid #4b5563; background: #f0f0f0; }
  table.items-table th + th, table.items-table td + td { border-left: 1.5px solid #4b5563; }
  table.items-table td { padding: 7px 8px; vertical-align: top; font-size: 11px; border-bottom: 1.5px solid #4b5563; }
  .items-spacer { flex: 1 1 auto; }
  .center { text-align: center; }
  .right { text-align: right; white-space: nowrap; }

  table.totals-table { width: 100%; border-collapse: collapse; margin-top: auto; border-top: 1.5px solid #4b5563; }
  table.totals-table td { padding: 5px 8px; font-size: 11px; }
  table.totals-table td:first-child { text-align: left; font-weight: bold; width: 70%; }
  table.totals-table td:last-child { text-align: right; }
  table.totals-table tr.grand td { font-weight: bold; font-size: 13px; border-top: 1.5px solid #4b5563; }
  table.totals-table tr.balance td { font-weight: bold; font-size: 13px; color: #ad3a29; }

  .tax-breakdown-title { margin-top: 16px; font-size: 10px; text-transform: uppercase; color: #83795f; font-weight: bold; }
  table.tax-breakdown { width: 100%; border-collapse: collapse; margin-top: 6px; border: 1.5px solid #4b5563; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  table.tax-breakdown th { font-size: 10px; text-transform: uppercase; font-weight: bold; padding: 6px 8px; border-bottom: 1.5px solid #4b5563; background: #f0f0f0; text-align: left; }
  table.tax-breakdown th + th, table.tax-breakdown td + td { border-left: 1.5px solid #4b5563; }
  table.tax-breakdown td { padding: 5px 8px; font-size: 11px; }

  .payment { margin-top: 16px; }
  .payment p { margin: 2px 0; }
  .notes { margin-top: 16px; padding: 10px 12px; background: #f1ede1; border-radius: 4px; }
  .terms { margin-top: 14px; font-size: 11px; color: #666; }
  .signatures { display: flex; gap: 40px; margin-top: 48px; }
  .signature { flex: 1; }
  .signature .line { border-top: 1.5px solid #4b5563; margin-top: 40px; padding-top: 4px; font-size: 11px; color: #83795f; }
  .footer { margin-top: 20px; text-align: center; color: #83795f; font-size: 11px; }
  .item-cell { display: flex; align-items: center; gap: 8px; }
  .item-thumb { width: 96px; height: 96px; object-fit: contain; border-radius: 4px; flex: none; background: #f1ede1; }
`;

function formatDate(value: string | null): string {
  return formatDocumentDate(value);
}

function formatDateTime(value: string): string {
  return formatDocumentDateTime(value);
}

/** Mirrors DESKTOP's printer-service.ts daysBetween — whole days between two ISO dates, rounded,
 * used for the computed "Payment Terms: Payment due within N days" / "Quotation expires within N
 * days" line. Null (skip the line) if either date is missing. */
function daysBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const diffMs = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  // Clamped at 0 — see DESKTOP's own printer-service.ts daysBetween for why (same-day due dates can
  // round to -1 from time-of-day noise alone).
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially Paid",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

const QUOTATION_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
};

/** Used for BOTH the HTML <title> (so a browser's own "Save as PDF" dialog suggests a sensible
 * filename instead of the URL) and the real download endpoint's Content-Disposition filename — one
 * function, so the two can never suggest different names for the same document. */
export function documentFilenameBase(doc: SharedResult): string {
  const sanitize = (value: string) => value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  switch (doc.documentKind) {
    case "receipt":
      return `Receipt-${sanitize(doc.documentNumber ?? "receipt")}`;
    case "invoice":
      return `Invoice-${sanitize(doc.documentNumber ?? "invoice")}`;
    case "quotation":
      return `Quotation-${sanitize(doc.documentNumber ?? "quotation")}`;
    case "delivery_note":
      return `Delivery-Note-${sanitize(doc.deliveryNoteNumber)}`;
    case "statement":
      return `Statement-${sanitize(doc.customerName)}`;
  }
}

export function buildDocumentHtml(doc: SharedResult): string {
  switch (doc.documentKind) {
    case "receipt":
      return buildReceiptDocumentHtml(doc);
    case "invoice":
      return buildInvoiceDocumentHtml(doc);
    case "quotation":
      return buildQuotationDocumentHtml(doc);
    case "delivery_note":
      return buildDeliveryNoteDocumentHtml(doc);
    case "statement":
      return buildStatementDocumentHtml(doc);
  }
}

/** Letterhead-style receipt — same visual family as the invoice/quotation/statement documents, NOT
 * the narrow Courier-New thermal-roll look. That narrow style still exists (DESKTOP's own
 * printer-service.ts keeps it, `compact: true`) for actually printing to an 80mm thermal printer —
 * but a receipt someone downloads or gets sent a link to should look like a real document, not
 * something meant for a till roll. Deliberately a simpler 5-column item table (no per-item
 * discount/tax/SKU columns) — a receipt's own view model (DESKTOP's ReceiptViewModel) never carried
 * that detail, so this matches what DESKTOP itself is able to show, not an invoice's fuller table. */
function buildReceiptDocumentHtml(doc: SharedDocumentResult): string {
  const money = (cents: number | null): string => (cents === null ? "-" : formatMoney(cents, doc.currency));

  const itemRows = [...doc.items, ...doc.extraLines]
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="center">${item.quantity}</td>
        <td class="right">${money(item.unitPriceCents)}</td>
        <td class="right">${money(item.lineTotalCents)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentFilenameBase(doc))}</title>
<style>${LETTERHEAD_STYLES}</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-row">
        <div>
          <p class="business-name">${escapeHtml(doc.businessName)}</p>
          ${doc.physicalAddress ? `<p class="muted">${escapeHtml(doc.physicalAddress)}</p>` : ""}
          ${doc.primaryPhone ? `<p class="muted">${escapeHtml(doc.primaryPhone)}</p>` : ""}
          ${doc.receiptHeader ? `<p class="muted">${escapeHtml(doc.receiptHeader)}</p>` : ""}
        </div>
        <div>
          <p class="invoice-title">RECEIPT</p>
          <p class="muted" style="text-align:right;">${escapeHtml(doc.documentNumber ?? "-")}</p>
        </div>
      </div>
    </div>

    <div class="bill-to">
      <p class="label">Sold To</p>
      <p class="name">${escapeHtml(doc.customerName ?? "Walk-in Customer")}</p>
    </div>

    <table class="meta-table">
      <thead>
        <tr><th>Date</th><th>Served By</th></tr>
      </thead>
      <tbody>
        <tr><td>${formatDateTime(doc.dateLabel)}</td><td>${escapeHtml(doc.employeeName)}</td></tr>
      </tbody>
    </table>

    <div class="items-frame">
      <table class="items-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Product</th>
            <th class="center">Qty</th>
            <th class="right">Unit Price</th>
            <th class="right">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div class="items-spacer"></div>
      <table class="totals-table">
        <tr><td>Subtotal</td><td>${money(doc.subtotalCents)}</td></tr>
        ${doc.discountAmountCents > 0 ? `<tr><td>Discount</td><td>-${money(doc.discountAmountCents)}</td></tr>` : ""}
        ${doc.includeTaxBreakdown && doc.addedTaxCents > 0 ? `<tr><td>Total Tax</td><td>${money(doc.addedTaxCents)}</td></tr>` : ""}
        <tr class="grand"><td>Total</td><td>${money(doc.grandTotalCents)}</td></tr>
      </table>
    </div>

    ${doc.includeTaxBreakdown ? buildTaxBreakdownHtml(doc.taxBreakdown, doc.vatRatePercent, (cents) => money(cents)) : ""}

    <div class="payment">
      <p class="label" style="font-size:10px;text-transform:uppercase;color:#83795f;font-weight:bold;">Payment</p>
      <p>${escapeHtml(doc.paymentMethodName ?? "-")}</p>
      ${doc.paymentReference ? `<p>Ref: ${escapeHtml(doc.paymentReference)}</p>` : ""}
      ${doc.amountReceivedCents !== null ? `<p>Received: ${money(doc.amountReceivedCents)}</p>` : ""}
      ${doc.changeGivenCents !== null && doc.changeGivenCents > 0 ? `<p>Change: ${money(doc.changeGivenCents)}</p>` : ""}
    </div>

    <div class="footer">${escapeHtml(doc.receiptFooter ?? "Thank you for your business!")}</div>
  </div>
</body>
</html>`;
}

/** Renders items, then extra-charge rows (service charges + delivery fee) with a dashed discount
 * column — mirrors DESKTOP's buildExtraChargeRows exactly (those aren't real product lines, so
 * their Discount column is always "-", never a real 0). Tax is deliberately NOT a per-item column
 * here — see buildTaxBreakdownHtml, the one place tax is actually shown, below the totals. */
function buildItemAndExtraRows(items: SharedLineItem[], extraLines: SharedLineItem[], money: (cents: number | null) => string): string {
  const itemRows = items
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}${item.sku ? `<div class="muted">${escapeHtml(item.sku)}</div>` : ""}</td>
        <td class="center">${item.quantity}</td>
        <td class="right">${money(item.unitPriceCents)}</td>
        <td class="right">${item.discountAmountCents > 0 ? `-${money(item.discountAmountCents)}` : "-"}</td>
        <td class="right">${money(item.lineTotalCents)}</td>
      </tr>`,
    )
    .join("");

  const extraRows = extraLines
    .map(
      (line, index) => `
      <tr>
        <td>${items.length + index + 1}</td>
        <td>${escapeHtml(line.name)}</td>
        <td class="center">1</td>
        <td class="right">${money(line.unitPriceCents)}</td>
        <td class="right">-</td>
        <td class="right">${money(line.lineTotalCents)}</td>
      </tr>`,
    )
    .join("");

  return itemRows + extraRows;
}

function buildInvoiceDocumentHtml(doc: SharedDocumentResult): string {
  const money = (cents: number | null): string => (cents === null ? "-" : formatMoney(cents, doc.currency));
  const itemRows = buildItemAndExtraRows(doc.items, doc.extraLines, money);

  const paymentRows = doc.payments
    .map(
      (payment) => `
      <tr>
        <td>${escapeHtml(formatDateTime(payment.receivedAt))}</td>
        <td>${escapeHtml(payment.paymentMethodName)}</td>
        <td>${escapeHtml(payment.reference ?? "-")}</td>
        <td>${escapeHtml(payment.receivedByName)}</td>
        <td class="right">${money(payment.amountCents)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentFilenameBase(doc))}</title>
<style>${LETTERHEAD_STYLES}</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-row">
        <div>
          <p class="business-name">${escapeHtml(doc.businessName)}</p>
          ${doc.physicalAddress ? `<p class="muted">${escapeHtml(doc.physicalAddress)}</p>` : ""}
          ${doc.primaryPhone ? `<p class="muted">${escapeHtml(doc.primaryPhone)}</p>` : ""}
        </div>
        <div>
          <p class="invoice-title">INVOICE</p>
          <p class="muted" style="text-align:right;">${escapeHtml(doc.documentNumber ?? "-")}</p>
          <div style="text-align:right;"><span class="badge">${escapeHtml(PAYMENT_STATUS_LABEL[doc.paymentStatus ?? ""] ?? doc.paymentStatus ?? "-")}</span></div>
        </div>
      </div>
      ${doc.businessKraPin ? `<p class="doc-vat">Our VAT No. ${escapeHtml(doc.businessKraPin)}</p>` : ""}
    </div>

    <div class="bill-to">
      <p class="label">Billed To:</p>
      <p class="name">${escapeHtml(doc.customerName ?? "Walk-in Customer")}</p>
    </div>

    <table class="meta-table">
      <thead>
        <tr><th>Invoice Date</th><th>Due Date</th><th>Issued By</th><th>Your VAT No.</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${formatDate(doc.dateLabel)}</td>
          <td>${formatDate(doc.dueDate)}</td>
          <td>${escapeHtml(doc.employeeName)}</td>
          <td>${escapeHtml(doc.customerKraPin ?? "-")}</td>
        </tr>
      </tbody>
    </table>

    ${
      (() => {
        const days = daysBetween(doc.dateLabel, doc.dueDate);
        return days === null ? "" : `<p class="payment-terms">Payment Terms: Payment due within ${days} day${days === 1 ? "" : "s"}</p>`;
      })()
    }

    <div class="items-frame">
      <table class="items-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Product</th>
            <th class="center">Qty</th>
            <th class="right">Unit Price</th>
            <th class="right">Discount</th>
            <th class="right">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div class="items-spacer"></div>
      <table class="totals-table">
        <tr><td>Subtotal</td><td>${money(doc.subtotalCents)}</td></tr>
        ${doc.discountAmountCents > 0 ? `<tr><td>Discount</td><td>-${money(doc.discountAmountCents)}</td></tr>` : ""}
        ${doc.includeTaxBreakdown && doc.addedTaxCents > 0 ? `<tr><td>Total Tax</td><td>${money(doc.addedTaxCents)}</td></tr>` : ""}
        <tr class="grand"><td>Total</td><td>${money(doc.grandTotalCents)}</td></tr>
        <tr><td>Amount Paid</td><td>${money(doc.grandTotalCents !== null && doc.balanceDueCents !== null ? doc.grandTotalCents - doc.balanceDueCents : null)}</td></tr>
        <tr class="balance"><td>Balance Due</td><td>${money(doc.balanceDueCents)}</td></tr>
      </table>
    </div>

    ${
      doc.payments.length > 0
        ? `<p class="tax-breakdown-title">Payments Made</p>
    <table class="tax-breakdown">
      <thead>
        <tr><th>Date</th><th>Method</th><th>Reference</th><th>Received By</th><th class="right">Amount</th></tr>
      </thead>
      <tbody>${paymentRows}</tbody>
    </table>`
        : ""
    }

    ${doc.includeTaxBreakdown ? buildTaxBreakdownHtml(doc.taxBreakdown, doc.vatRatePercent, (cents) => money(cents)) : ""}

    ${doc.notes ? `<div class="notes"><strong>Notes</strong><p>${escapeHtml(doc.notes)}</p></div>` : ""}

    <div class="footer">${escapeHtml(doc.receiptFooter ?? "Thank you for your business!")}</div>
  </div>
</body>
</html>`;
}

function buildQuotationDocumentHtml(doc: SharedDocumentResult): string {
  const money = (cents: number | null): string => (cents === null ? "-" : formatMoney(cents, doc.currency));
  const itemRows = buildItemAndExtraRows(doc.items, doc.extraLines, money);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentFilenameBase(doc))}</title>
<style>${LETTERHEAD_STYLES}</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-row">
        <div>
          <p class="business-name">${escapeHtml(doc.businessName)}</p>
          ${doc.physicalAddress ? `<p class="muted">${escapeHtml(doc.physicalAddress)}</p>` : ""}
          ${doc.primaryPhone ? `<p class="muted">${escapeHtml(doc.primaryPhone)}</p>` : ""}
        </div>
        <div>
          <p class="doc-title">QUOTATION</p>
          <p class="muted" style="text-align:right;">${escapeHtml(doc.documentNumber ?? "-")}</p>
          <div style="text-align:right;"><span class="badge">${escapeHtml(QUOTATION_STATUS_LABEL[doc.quotationStatus ?? ""] ?? doc.quotationStatus ?? "-")}</span></div>
        </div>
      </div>
    </div>

    <div class="bill-to">
      <p class="label">Quoted To</p>
      <p class="name">${escapeHtml(doc.customerName ?? "-")}</p>
    </div>

    <table class="meta-table">
      <thead>
        <tr><th>Date Prepared</th><th>Valid Until</th><th>Prepared By</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${formatDate(doc.dateLabel)}</td>
          <td>${formatDate(doc.validUntil)}</td>
          <td>${escapeHtml(doc.employeeName)}</td>
        </tr>
      </tbody>
    </table>

    ${
      (() => {
        const days = daysBetween(doc.dateLabel, doc.validUntil);
        return days === null ? "" : `<p class="payment-terms">Quotation expires within ${days} day${days === 1 ? "" : "s"}</p>`;
      })()
    }

    <div class="items-frame">
      <table class="items-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Product</th>
            <th class="center">Qty</th>
            <th class="right">Unit Price</th>
            <th class="right">Discount</th>
            <th class="right">Line Total</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div class="items-spacer"></div>
      <table class="totals-table">
        <tr><td>Subtotal</td><td>${money(doc.subtotalCents)}</td></tr>
        ${doc.discountAmountCents > 0 ? `<tr><td>Discount</td><td>-${money(doc.discountAmountCents)}</td></tr>` : ""}
        ${doc.includeTaxBreakdown && doc.addedTaxCents > 0 ? `<tr><td>Total Tax</td><td>${money(doc.addedTaxCents)}</td></tr>` : ""}
        <tr class="grand"><td>Total</td><td>${money(doc.grandTotalCents)}</td></tr>
      </table>
    </div>

    ${doc.includeTaxBreakdown ? buildTaxBreakdownHtml(doc.taxBreakdown, doc.vatRatePercent, (cents) => money(cents)) : ""}

    ${doc.notes ? `<div class="notes"><strong>Notes</strong><p>${escapeHtml(doc.notes)}</p></div>` : ""}

    <div class="terms">
      This quotation is valid until ${formatDate(doc.validUntil)}. Prices, discounts, and availability
      are subject to confirmation at the time of order. Acceptance of this quotation does not reserve stock.
    </div>

    <div class="signatures">
      <div class="signature">
        <div class="line">Customer Signature &amp; Date</div>
      </div>
      <div class="signature">
        <div class="line">Authorized Signature &amp; Date</div>
      </div>
    </div>

    <div class="footer">${escapeHtml(doc.receiptFooter ?? "Thank you for considering us!")}</div>
  </div>
</body>
</html>`;
}

function deliveryField(label: string, value: string | null): string {
  if (!value) return "";
  return `
      <div class="field">
        <span class="field-label">${escapeHtml(label)}</span>
        <span class="field-value">${escapeHtml(value)}</span>
      </div>`;
}

/** Mirrors buildDeliveryNoteHtml's regular ("card") layout — the rotated-thermal-strip variant only
 * ever exists for a live USB print job, never for anything shareable. Sized to actually fill most of
 * an A4 page (180mm of ~210mm width) rather than the earlier 100mm card that left the page looking
 * almost entirely blank — same dashed-card identity, just scaled up. */
function buildDeliveryNoteDocumentHtml(doc: SharedDeliveryNoteResult): string {
  const townCountry = [doc.town, doc.country].filter(Boolean).join(", ");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentFilenameBase(doc))}</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 0; }
  html, body { height: 100%; }
  body {
    font-family: Arial, Helvetica, sans-serif; color: #1c1710; margin: 0;
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
  }
  .card {
    width: 180mm;
    border: 3px dashed #83795f;
    border-radius: 10px;
    padding: 28px 36px 24px;
  }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid #061e64; padding-bottom: 14px; }
  .business-name { font-size: 20px; font-weight: bold; color: #061e64; margin: 0; }
  .muted { color: #83795f; font-size: 15px; margin: 3px 0 0; }
  .doc-title { font-size: 22px; font-weight: bold; text-align: right; color: #061e64; margin: 0; letter-spacing: 1px; }
  .doc-number { font-size: 16px; font-weight: bold; text-align: right; color: #83795f; margin-top: 4px; }
  .badge { display: inline-block; margin-top: 8px; padding: 4px 14px; border-radius: 999px; font-size: 13px; font-weight: bold; text-transform: uppercase; background: #1f9d55; color: #fff; }
  .section-label { margin: 18px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold; color: #061e64; }
  .field { display: flex; gap: 14px; padding: 6px 0; border-bottom: 1px dotted #ddd5c2; }
  .field-label { flex: 0 0 110px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; color: #83795f; font-weight: bold; padding-top: 2px; }
  .field-value { flex: 1; font-size: 18px; font-weight: 700; color: #1c1710; line-height: 1.3; word-break: break-word; }
  .recipient-name .field-value { font-size: 24px; }
  .divider { margin-top: 18px; border-top: 1px dashed #ddd5c2; }
  .footer { margin-top: 16px; display: flex; justify-content: space-between; font-size: 13px; color: #83795f; }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <p class="business-name">${escapeHtml(doc.businessName)}</p>
        ${doc.primaryPhone ? `<p class="muted">${escapeHtml(doc.primaryPhone)}</p>` : ""}
      </div>
      <div>
        <p class="doc-title">DELIVERY NOTE</p>
        <p class="doc-number">${escapeHtml(doc.deliveryNoteNumber)}</p>
        ${doc.isDelivered ? `<div style="text-align:right;"><span class="badge">Delivered</span></div>` : ""}
      </div>
    </div>

    <p class="section-label">Deliver To</p>
    <div class="recipient-name">${deliveryField("Recipient", doc.recipientName)}</div>
    ${deliveryField("Address", doc.deliveryAddress)}
    ${deliveryField("Town", townCountry || null)}
    ${deliveryField("Notes", doc.deliveryNotes)}

    <p class="section-label">Rider</p>
    ${deliveryField("Name", doc.riderName ?? "Not assigned")}
    ${deliveryField("Phone", doc.riderPhone)}
    ${deliveryField("Vehicle", doc.riderVehicleDescription)}

    <div class="divider"></div>
    <div class="footer">
      <span>${escapeHtml(doc.sourceDocumentLabel)}: ${escapeHtml(doc.sourceDocumentNumber ?? "-")}</span>
      <span>${escapeHtml(formatDateTime(doc.dateLabel))}</span>
    </div>
  </div>
</body>
</html>`;
}

/** Same letterhead visual language as the invoice document — statements have no per-storefront
 * identity to show (see share-service.ts's own note on this), so there's no logo/location block at
 * all here, matching DESKTOP's own buildStatementHtml exactly. */
function buildStatementDocumentHtml(doc: SharedStatementResult): string {
  const money = (cents: number): string => formatMoney(cents, doc.currency);

  const rows =
    doc.invoices
      .map(
        (invoice, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(invoice.invoiceNumber ?? "-")}</td>
        <td>${formatDate(invoice.invoiceDate)}</td>
        <td>${formatDate(invoice.dueDate)}</td>
        <td class="right">${money(invoice.grandTotalCents)}</td>
        <td class="right">${money(invoice.amountPaidCents)}</td>
        <td class="right">${money(invoice.balanceDueCents)}</td>
        <td><span class="badge">${escapeHtml(PAYMENT_STATUS_LABEL[invoice.paymentStatus] ?? invoice.paymentStatus)}</span></td>
      </tr>`,
      )
      .join("") || `<tr><td colspan="8" class="center muted" style="padding:16px 4px;">No outstanding invoices</td></tr>`;

  const availableCreditCents = doc.creditLimitCents !== null ? Math.max(0, doc.creditLimitCents - doc.totalOutstandingCents) : null;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documentFilenameBase(doc))}</title>
<style>${LETTERHEAD_STYLES}</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="header-row">
        <div>
          <p class="business-name">${escapeHtml(doc.businessName)}</p>
          ${doc.physicalAddress ? `<p class="muted">${escapeHtml(doc.physicalAddress)}</p>` : ""}
          ${doc.primaryPhone ? `<p class="muted">${escapeHtml(doc.primaryPhone)}</p>` : ""}
        </div>
        <div>
          <p class="invoice-title">STATEMENT</p>
          <p class="muted" style="text-align:right;">${formatDate(doc.generatedAt)}</p>
        </div>
      </div>
    </div>

    <div class="bill-to">
      <p class="label">Statement For</p>
      <p class="name">${escapeHtml(doc.customerName)}</p>
      <p class="muted">${escapeHtml(doc.customerPhone)}</p>
      ${doc.customerEmail ? `<p class="muted">${escapeHtml(doc.customerEmail)}</p>` : ""}
    </div>

    ${
      doc.creditLimitCents !== null && availableCreditCents !== null
        ? `<table class="meta-table">
      <thead>
        <tr><th>Credit Limit</th><th>Available Credit</th></tr>
      </thead>
      <tbody>
        <tr><td>${money(doc.creditLimitCents)}</td><td>${money(availableCreditCents)}</td></tr>
      </tbody>
    </table>`
        : ""
    }

    <div class="items-frame">
      <table class="items-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Invoice</th>
            <th>Date</th>
            <th>Due</th>
            <th class="right">Total</th>
            <th class="right">Paid</th>
            <th class="right">Balance</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="items-spacer"></div>
      <table class="totals-table">
        <tr><td>Total Invoiced</td><td>${money(doc.totalInvoicedCents)}</td></tr>
        <tr><td>Total Paid</td><td>${money(doc.totalPaidCents)}</td></tr>
        <tr class="balance"><td>Total Outstanding</td><td>${money(doc.totalOutstandingCents)}</td></tr>
      </table>
    </div>

    <div class="footer">Generated by ${escapeHtml(doc.businessName)} — please settle outstanding invoices at your earliest convenience.</div>
  </div>
</body>
</html>`;
}
