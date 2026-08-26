import { randomUUID } from "node:crypto";
import { HttpError, NotFoundError } from "../lib/http-error.js";
import { withTenantContext } from "../lib/tenant-context.js";
import {
  mobileToggleManualLockSchema,
  type MobileToggleManualLockInput,
  mobileWorkingHoursUpsertSchema,
  type MobileWorkingHoursUpsertInput,
} from "../schemas/mobile.js";
import { isStorefrontLocationType } from "./mobile-sales-service.js";

const OWNER_APP_DEVICE_ID = "owner-app";

export type MobileWorkingHoursScheduleDay = { isOpen: boolean; openTime: string | null; closeTime: string | null };

export type MobileWorkingHoursConfig = {
  locationId: string;
  locationName: string;
  lockEnabled: boolean;
  lockMode: "auto" | "manual";
  manuallyLocked: boolean;
  timezoneOffsetMinutes: number;
  schedule: Record<string, MobileWorkingHoursScheduleDay>;
};

/** Every storefront, joined with its own WorkingHours row if one exists — a storefront that's never
 * been configured comes back with `config: null` (always-open, matches computeWorkingHoursLockStatus's
 * own "no config means never locked" rule). Backs the Working Hours tab's storefront picker on both
 * DESKTOP and APP. */
export async function listWorkingHours(tenantId: string): Promise<Array<{ locationId: string; locationName: string; config: MobileWorkingHoursConfig | null }>> {
  return withTenantContext(tenantId, async (tx) => {
    const locations = await tx.location.findMany({
      where: { tenantId },
      select: { id: true, locationName: true, locationType: true },
      orderBy: { locationName: "asc" },
    });
    const storefronts = locations.filter((l) => isStorefrontLocationType(l.locationType));

    const rows = await tx.workingHours.findMany({ where: { tenantId, locationId: { in: storefronts.map((l) => l.id) } } });
    const rowByLocationId = new Map(rows.map((r) => [r.locationId, r]));

    return storefronts.map((location) => {
      const row = rowByLocationId.get(location.id);
      return {
        locationId: location.id,
        locationName: location.locationName,
        config: row
          ? {
              locationId: location.id,
              locationName: location.locationName,
              lockEnabled: row.lockEnabled,
              lockMode: row.lockMode as "auto" | "manual",
              manuallyLocked: row.manuallyLocked,
              timezoneOffsetMinutes: row.timezoneOffsetMinutes,
              schedule: row.schedule as Record<string, MobileWorkingHoursScheduleDay>,
            }
          : null,
      };
    });
  });
}

export async function getWorkingHours(tenantId: string, locationId: string): Promise<MobileWorkingHoursConfig | null> {
  return withTenantContext(tenantId, async (tx) => {
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.tenantId !== tenantId) throw new NotFoundError("Storefront not found");

    const row = await tx.workingHours.findFirst({ where: { tenantId, locationId } });
    if (!row) return null;
    return {
      locationId,
      locationName: location.locationName,
      lockEnabled: row.lockEnabled,
      lockMode: row.lockMode as "auto" | "manual",
      manuallyLocked: row.manuallyLocked,
      timezoneOffsetMinutes: row.timezoneOffsetMinutes,
      schedule: row.schedule as Record<string, MobileWorkingHoursScheduleDay>,
    };
  });
}

/** Upserts the one WorkingHours row for this storefront — created on first save, updated
 * thereafter (see the model's own doc comment: never boot-seeded, one row per storefront by
 * application-level convention). */
export async function upsertWorkingHours(tenantId: string, locationId: string, input: unknown): Promise<MobileWorkingHoursConfig> {
  const parsed: MobileWorkingHoursUpsertInput = mobileWorkingHoursUpsertSchema.parse(input);

  return withTenantContext(tenantId, async (tx) => {
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.tenantId !== tenantId) throw new NotFoundError("Storefront not found");

    const now = new Date();
    const existing = await tx.workingHours.findFirst({ where: { tenantId, locationId } });

    const data = {
      tenantId,
      deviceId: OWNER_APP_DEVICE_ID,
      locationId,
      lockEnabled: parsed.lockEnabled,
      lockMode: parsed.lockMode,
      manuallyLocked: parsed.manuallyLocked,
      timezoneOffsetMinutes: parsed.timezoneOffsetMinutes,
      schedule: parsed.schedule,
      localUpdatedAt: now,
      // syncedAt is `@default(now())` — Prisma only ever applies a plain default at INSERT time,
      // never on a later UPDATE. DESKTOP's own pull is a delta query (`syncedAt: { gt: since }`),
      // so leaving this out of the update path freezes it at row-creation time FOREVER — every edit
      // from mobile becomes permanently invisible to DESKTOP's pull, not just delayed. Same bug
      // class this project already hit and fixed once in the generic sync path (see
      // sync-service.ts's own sanitizeRow comment) — this direct-Prisma mobile service bypasses
      // that fix entirely, so it needs its own explicit set here.
      syncedAt: now,
    };

    const row = existing
      ? await tx.workingHours.update({ where: { id: existing.id }, data })
      : await tx.workingHours.create({ data: { id: `working_hours_${randomUUID()}`, ...data, localCreatedAt: now } });

    return {
      locationId,
      locationName: location.locationName,
      lockEnabled: row.lockEnabled,
      lockMode: row.lockMode as "auto" | "manual",
      manuallyLocked: row.manuallyLocked,
      timezoneOffsetMinutes: row.timezoneOffsetMinutes,
      schedule: row.schedule as Record<string, MobileWorkingHoursScheduleDay>,
    };
  });
}

/** The quick "lock/unlock right now" action — a lightweight sibling to the full upsert above, for
 * the one-tap emergency-lock case (see the Working Hours tab's dedicated toggle). Only meaningful
 * once a storefront already has a WorkingHours row in "manual" mode; there's nothing to toggle for a
 * storefront that's never been configured, so this deliberately does NOT create one. */
export async function toggleManualLock(tenantId: string, locationId: string, input: unknown): Promise<MobileWorkingHoursConfig> {
  const parsed: MobileToggleManualLockInput = mobileToggleManualLockSchema.parse(input);

  return withTenantContext(tenantId, async (tx) => {
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.tenantId !== tenantId) throw new NotFoundError("Storefront not found");

    const existing = await tx.workingHours.findFirst({ where: { tenantId, locationId } });
    if (!existing) throw new HttpError(400, "Set up working hours for this storefront before using manual lock.");

    // syncedAt set explicitly here too — see upsertWorkingHours's own comment on why this can't be
    // left to Prisma's column default.
    const now = new Date();
    const row = await tx.workingHours.update({ where: { id: existing.id }, data: { manuallyLocked: parsed.locked, localUpdatedAt: now, syncedAt: now } });
    return {
      locationId,
      locationName: location.locationName,
      lockEnabled: row.lockEnabled,
      lockMode: row.lockMode as "auto" | "manual",
      manuallyLocked: row.manuallyLocked,
      timezoneOffsetMinutes: row.timezoneOffsetMinutes,
      schedule: row.schedule as Record<string, MobileWorkingHoursScheduleDay>,
    };
  });
}
