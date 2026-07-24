import type { Device } from "@prisma/client";
import type { AuthenticatedAccount } from "../middleware/auth.js";
import { NotFoundError } from "../lib/http-error.js";
import { prisma } from "../prisma.js";
import { deviceUpdateSchema } from "../schemas/device.js";
import { getTenant } from "./tenant-service.js";

/** Reuses getTenant's outlet-scoping — a MARKETER can only see devices for a tenant in their own
 * outlet, same boundary as everything else tenant-scoped. */
export async function listDevices(tenantId: string, actor: AuthenticatedAccount): Promise<Device[]> {
  await getTenant(tenantId, actor);
  return prisma.device.findMany({ where: { tenantId }, orderBy: { registeredAt: "desc" } });
}

/** SUPER_ADMIN only (enforced at the route layer, same as every other tenant-scoped PATCH) — lets
 * an admin fix a device's label (e.g. the auto-assigned "Device 2") to something meaningful like
 * "Front Counter Till" without touching anything else about it. */
export async function renameDevice(tenantId: string, deviceId: string, input: unknown): Promise<Device> {
  const parsed = deviceUpdateSchema.parse(input);
  const existing = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!existing || existing.tenantId !== tenantId) {
    throw new NotFoundError("Device not found");
  }
  return prisma.device.update({ where: { id: deviceId }, data: { deviceName: parsed.deviceName } });
}
