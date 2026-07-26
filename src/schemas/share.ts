import { z } from "zod";

/** Mints a share link — gated by requireDevice (SERVER/middleware/device-auth.ts), the same
 * {tenantId, deviceId} pair every /sync/* route already trusts. */
export const createShareLinkSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entity: z.enum(["sale", "quotation", "sale_delivery", "quotation_delivery", "customer_statement"]),
  entityId: z.string().trim().min(1, "entityId is required"),
  /** Whether the WhatsApp/email message includes the full formatted preview (business header, items,
   * totals) or just a short "here's your document" line — the "Include WhatsApp preview" checkbox in
   * ShareModal.tsx. Defaults true so older DESKTOP builds that don't send this yet keep today's
   * behavior unchanged. */
  includePreview: z.boolean().optional().default(true),
});

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
