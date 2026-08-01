/** Locale-independent DD/MM/YYYY formatting for customer-facing documents (receipt/invoice/
 * quotation) — deliberately not toLocaleDateString(), which silently follows the server process's
 * own locale (typically en-US in most hosting environments) regardless of the business's own
 * convention, which is DD/MM/YYYY. Mirrors DESKTOP's shared/lib/date.ts (separate codebase, same
 * contract) so the printed receipt, the downloaded PDF, and the share link/message all agree. */
export function formatDocumentDate(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "-";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

/** Same as formatDocumentDate, with a time-of-day suffix — for a document's own "Date: ..." line,
 * which has always shown a timestamp rather than a bare date. */
export function formatDocumentDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "-";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${formatDocumentDate(date)}, ${time}`;
}
