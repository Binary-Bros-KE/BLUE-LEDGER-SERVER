import type { LicenseStatus, SuspensionReason } from "@prisma/client";
import { HttpError } from "./http-error.js";

/** Shared by activation-service.ts (register/heartbeat) and middleware/device-auth.ts (every sync
 * request) — a cancelled or suspended license blocks the desktop app from doing anything cloud-side,
 * whether that's the routine license check-in or an ordinary data sync. */
export function assertLicenseUsable(license: { status: LicenseStatus; suspensionReason: SuspensionReason | null }): void {
  if (license.status === "CANCELLED") {
    throw new HttpError(403, "This license has been cancelled. Contact Blue Ledger support.");
  }
  if (license.status === "SUSPENDED") {
    throw new HttpError(403, `This license has been suspended (${license.suspensionReason ?? "contact support"}).`);
  }
}
