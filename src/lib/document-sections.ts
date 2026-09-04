// Ported from DESKTOP's shared/lib/document-sections.ts. Client request: an invoice/quotation's
// line items can be grouped into named sections (e.g. "Lighting", "Sound"), each with its own
// subtotal — sections are never stored pre-grouped, always derived at render time from each line's
// own sectionLabel, so SHARE's public link, PDF, and the Owner App all group identically to DESKTOP.

export type NotesSection = {
  title: string;
  body: string;
};

export type ItemSectionGroup<T> = {
  label: string | null;
  items: T[];
  subtotalCents: number;
};

/** Groups a flat item array by sectionLabel in order of each label's first appearance — same
 * "bucket by a key, in first-seen order" shape as computeTaxBreakdown (tax-breakdown.ts) already
 * uses for VAT-mode grouping. */
export function groupItemsBySections<T extends { sectionLabel: string | null; lineTotalCents: number }>(
  items: T[],
): ItemSectionGroup<T>[] {
  const order: Array<string | null> = [];
  const byLabel = new Map<string | null, T[]>();
  for (const item of items) {
    const label = item.sectionLabel;
    if (!byLabel.has(label)) {
      order.push(label);
      byLabel.set(label, []);
    }
    byLabel.get(label)!.push(item);
  }
  return order.map((label) => {
    const groupItems = byLabel.get(label)!;
    return {
      label,
      items: groupItems,
      subtotalCents: groupItems.reduce((sum, item) => sum + item.lineTotalCents, 0),
    };
  });
}
