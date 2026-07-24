import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { assertLicenseUsable } from "../lib/license-guard.js";
import { prisma } from "../prisma.js";

export type DeviceSyncContext = { tenantId: string; deviceId: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      syncContext?: DeviceSyncContext;
    }
  }
}

/** Gates every /sync/* route. A desktop device isn't an Account, so this is deliberately NOT
 * requireAuth/JWT — the device's own {tenantId, deviceId} pair (sent in every request body) is
 * validated directly against the Device/License rows, mirroring activation-service.ts's existing
 * register/heartbeat model. On ANY failure — unknown tenant, unknown device, a device claiming the
 * wrong tenant, a deactivated device, an unusable license — this throws rather than silently
 * creating or defaulting anything: a sync request must never "lead" data into existence for a
 * tenant that doesn't already exist. */
export async function requireDevice(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const { tenantId, deviceId } = req.body as { tenantId?: unknown; deviceId?: unknown };
  if (typeof tenantId !== "string" || !tenantId || typeof deviceId !== "string" || !deviceId) {
    throw new HttpError(400, "tenantId and deviceId are required");
  }

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    include: { tenant: { include: { license: true } } },
  });

  if (!device || device.tenantId !== tenantId) {
    throw new HttpError(404, "Device not recognized for this tenant");
  }
  if (device.status !== "ACTIVE") {
    throw new HttpError(403, "This device has been deactivated — re-activate to resume syncing");
  }
  if (!device.tenant.license) {
    throw new HttpError(404, "Tenant has no license on file");
  }
  assertLicenseUsable(device.tenant.license);

  req.syncContext = { tenantId, deviceId };
  next();
}
