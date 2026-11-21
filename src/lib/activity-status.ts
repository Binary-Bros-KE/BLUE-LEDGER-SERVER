/**
 * How recently a business (or a person, or a device) was last seen using Blue Ledger — the Activity
 * tab's buckets. Pure, so the thresholds are tested and every screen agrees on them.
 *
 * "Seen" is the most recent of: a desktop check-in (every ~20s while the app is open and online), a
 * phone request (stamped at most every few minutes), and a completed sale.
 */

export type ActivityState = "online" | "today" | "week" | "idle" | "dormant" | "never";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** A desktop checks in every 20 seconds; a couple of missed beats is still "online". */
export const ONLINE_WINDOW_MS = 2 * MINUTE;
/** A phone request stamps "last seen on phone" at most this often (keeps writes cheap). */
export const MOBILE_SEEN_THROTTLE_MS = 5 * MINUTE;
/** Same for a desktop's signed-in employee. */
export const DESKTOP_SEEN_THROTTLE_MS = 5 * MINUTE;

export function activityState(lastSeenAt: Date | null, now: Date = new Date()): ActivityState {
  if (!lastSeenAt) return "never";
  const age = now.getTime() - lastSeenAt.getTime();
  if (age <= ONLINE_WINDOW_MS) return "online";
  if (age <= DAY) return "today";
  if (age <= 7 * DAY) return "week";
  if (age <= 30 * DAY) return "idle";
  return "dormant";
}

/** The latest of several optional timestamps. */
export function latest(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) if (date && (!best || date > best)) best = date;
  return best;
}

/** "2.0.2" vs "2.0.10": numeric, part by part. Unknown versions count as up to date. */
export function isOlderVersion(version: string | null, latestVersion: string | null): boolean {
  if (!version || !latestVersion) return false;
  const a = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = latestVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/** Whether a "last seen" stamp is stale enough to write again. */
export function shouldRestamp(previous: Date | null, throttleMs: number, now: Date = new Date()): boolean {
  return !previous || now.getTime() - previous.getTime() >= throttleMs;
}
