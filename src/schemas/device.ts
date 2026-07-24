import { z } from "zod";

/** The only device field an admin can edit — everything else (OS, app version, sequence number,
 * status) is either reported by the desktop app itself or changed via its own dedicated action
 * (revoke/reactivate), not a plain field edit. */
export const deviceUpdateSchema = z.object({
  deviceName: z.string().trim().min(1, "Device name is required").max(150),
});

export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;
