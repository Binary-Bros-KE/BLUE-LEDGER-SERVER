export type WorkingHoursDaySchedule = { isOpen: boolean; openTime: string | null; closeTime: string | null };

export type WorkingHoursConfig = {
  lockEnabled: boolean;
  /** "auto" | "manual" — plain string, not a real union at this boundary, since it comes straight off
   * a Json/db column read with no dedicated Zod schema (same convention as Role.permissionsJson). */
  lockMode: string;
  manuallyLocked: boolean;
  /** Same sign convention as APP's lib/period.ts timezoneOffsetMinutes() / JS's own
   * Date.prototype.getTimezoneOffset() — negative for timezones ahead of UTC (e.g. Nairobi/UTC+3 is
   * -180). Captured from the configuring device at save time. */
  timezoneOffsetMinutes: number;
  /** Keyed "0".."6", 0=Sunday..6=Saturday (JS Date.getDay()/getUTCDay() convention). */
  schedule: Record<string, WorkingHoursDaySchedule>;
};

export type WorkingHoursLockStatus = { locked: false } | { locked: true; reason: "manual" | "outside_hours" };

/**
 * Pure — no I/O beyond the defaulted `now` param — so this runs identically here (enforcing mobile
 * API requests against this server's own clock) and on DESKTOP, which PORTS this exact function into
 * its own shared/lib/working-hours-lock.ts (offline, the device's own clock; update both together if
 * this logic ever changes). Mirrors DESKTOP's grace-period.ts style: pure function, discriminated-
 * union return, `now: Date = new Date()` default so callers never have to thread a clock through by
 * hand.
 *
 * `config: null` means this storefront has never had working hours configured — never locked; a
 * tenant that hasn't opted into this feature at all sees no behavior change.
 */
export function computeWorkingHoursLockStatus(config: WorkingHoursConfig | null, now: Date = new Date()): WorkingHoursLockStatus {
  if (!config || !config.lockEnabled) return { locked: false };

  if (config.lockMode === "manual") {
    return config.manuallyLocked ? { locked: true, reason: "manual" } : { locked: false };
  }

  // "auto" mode — shift `now` by the storefront's own stored UTC offset so the day-of-week/hour/
  // minute read below reflect the STOREFRONT's local wall clock, not this process's own system
  // timezone (which for a Postgres/Node server is typically UTC, not the tenant's).
  const localNow = new Date(now.getTime() - config.timezoneOffsetMinutes * 60_000);
  const dayOfWeek = localNow.getUTCDay();
  const day = config.schedule[String(dayOfWeek)];
  if (!day || !day.isOpen || !day.openTime || !day.closeTime) {
    return { locked: true, reason: "outside_hours" };
  }

  const minutesNow = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
  const [openH, openM] = day.openTime.split(":").map(Number);
  const [closeH, closeM] = day.closeTime.split(":").map(Number);
  const openMinutes = (openH ?? 0) * 60 + (openM ?? 0);
  const closeMinutes = (closeH ?? 0) * 60 + (closeM ?? 0);

  // closeMinutes <= openMinutes means the window crosses midnight (e.g. 18:00-02:00) — "within
  // hours" then means AFTER open OR BEFORE close, not a plain between-check.
  const withinHours =
    closeMinutes > openMinutes ? minutesNow >= openMinutes && minutesNow < closeMinutes : minutesNow >= openMinutes || minutesNow < closeMinutes;

  return withinHours ? { locked: false } : { locked: true, reason: "outside_hours" };
}
