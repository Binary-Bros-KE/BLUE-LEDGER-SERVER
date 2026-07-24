import { z } from "zod";

/** Mints a share link — gated by requireDevice (SERVER/middleware/device-auth.ts), the same
 * {tenantId, deviceId} pair every /sync/* route already trusts. */
export const createShareLinkSchema = z.object({
  tenantId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  entity: z.enum(["sale", "quotation"]),
  entityId: z.string().trim().min(1, "entityId is required"),
});

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
