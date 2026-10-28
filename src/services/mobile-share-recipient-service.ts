import { NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import type { MobileShareRecipientQueryInput } from "../schemas/mobile.js";

export type MobileShareRecipient = { name: string | null; phone: string | null; email: string | null };

/**
 * Who a shared document goes to — pre-fills the Share sheet's WhatsApp number / email address, the
 * same way DESKTOP's ShareModal loads the customer from the document's customerId. Deliberately its
 * own (mobile-auth-gated) lookup rather than fields on SharedDocument: that view-model is also what
 * the PUBLIC share page renders, and a customer's phone/email must never ride along on a public link.
 * A delivery note goes to the same customer as its parent sale/quotation (DESKTOP does the same).
 * Walk-in or customer-less documents simply come back empty — the user types a number instead.
 */
export async function getShareRecipient(tenantId: string, input: MobileShareRecipientQueryInput): Promise<MobileShareRecipient> {
  return withTenantContext(tenantId, async (tx) => {
    let customerId: string | null;
    if (input.entity === "customer_statement") {
      customerId = input.entityId;
    } else if (input.entity === "sale" || input.entity === "sale_delivery") {
      const sale = await tx.sale.findUnique({ where: { id: input.entityId }, select: { tenantId: true, customerId: true } });
      if (!sale || sale.tenantId !== tenantId) throw new NotFoundError("Document not found");
      customerId = sale.customerId;
    } else {
      const quotation = await tx.quotation.findUnique({ where: { id: input.entityId }, select: { tenantId: true, customerId: true } });
      if (!quotation || quotation.tenantId !== tenantId) throw new NotFoundError("Document not found");
      customerId = quotation.customerId;
    }

    if (!customerId) return { name: null, phone: null, email: null };
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { tenantId: true, name: true, phone: true, email: true } });
    if (!customer || customer.tenantId !== tenantId) return { name: null, phone: null, email: null };
    return { name: customer.name, phone: customer.phone || null, email: customer.email || null };
  });
}
