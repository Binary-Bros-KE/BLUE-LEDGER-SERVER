/**
 * COPY of DESKTOP src/shared/lib/subscription-schedule.ts — the date and reminder rules for
 * Subscriptions (DStv, GOtv...), tested there (tests/subscription-schedule.test.ts). Keep the copies
 * identical, so a till, the server and the phone always agree on days left and which reminder is due.
 *
 * Dates are plain YYYY-MM-DD calendar dates, never instants. All arithmetic happens at UTC midnight,
 * so a day is always exactly 24 hours (no daylight-saving or timezone drift) and "today" is whatever
 * the device's own calendar says — see localTodayIso.
 *
 * A subscription bought on 1 Nov for 30 days ends on 1 Dec: that's the day it "expires today", and
 * 2 Dec is the first day it's expired.
 */

export type SubscriptionStage = "active" | "week" | "three_days" | "due" | "expired";

/** The four reminders, in the order they come due. */
export type SubscriptionNoticeStage = Exclude<SubscriptionStage, "active">;
export const SUBSCRIPTION_NOTICE_STAGES: readonly SubscriptionNoticeStage[] = ["week", "three_days", "due", "expired"];

export const SUBSCRIPTION_STAGE_LABELS: Record<SubscriptionStage, string> = {
  active: "Active",
  week: "Due this week",
  three_days: "Due in 3 days",
  due: "Expires today",
  expired: "Expired"
};

export const SUBSCRIPTION_NOTICE_LABELS: Record<SubscriptionNoticeStage, string> = {
  week: "1 week",
  three_days: "3 days",
  due: "Expiry day",
  expired: "After expiry"
};

export const DEFAULT_SUBSCRIPTION_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toUtcMs(date: string): number {
  if (!DATE_PATTERN.test(date)) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; a real calendar date survives the round trip.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`Not a real date: ${date}`);
  return ms;
}

export function isValidDate(date: string): boolean {
  try {
    toUtcMs(date);
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** The device's own calendar date. Never new Date().toISOString(), which is UTC and a day off for part
 * of every day anywhere east or west of Greenwich. */
export function localTodayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function endDateFor(startDate: string, periodDays: number): string {
  return addDays(startDate, periodDays);
}

/** Positive: days left. 0: expires today. Negative: days since it expired. */
export function daysRemaining(endDate: string, today: string): number {
  return daysBetween(today, endDate);
}

export function stageFor(daysLeft: number): SubscriptionStage {
  if (daysLeft > 7) return "active";
  if (daysLeft >= 4) return "week";
  if (daysLeft >= 1) return "three_days";
  if (daysLeft === 0) return "due";
  return "expired";
}

/**
 * The one reminder to offer right now, or null. Only the most urgent unsent one: a subscription added
 * with 2 days left never asks for its "1 week" reminder, and once a later reminder has gone out the
 * earlier ones are never offered again. Only an active (not renewed, not cancelled) period gets any.
 */
export function pendingNotice(
  status: string,
  daysLeft: number,
  sentStages: ReadonlyArray<SubscriptionNoticeStage>
): SubscriptionNoticeStage | null {
  if (status !== "active") return null;
  const stage = stageFor(daysLeft);
  if (stage === "active") return null;
  const index = SUBSCRIPTION_NOTICE_STAGES.indexOf(stage);
  const alreadyHandled = sentStages.some((sent) => SUBSCRIPTION_NOTICE_STAGES.indexOf(sent) >= index);
  return alreadyHandled ? null : stage;
}

/** Where a renewal starts by default: the old end date if renewed early (no days lost), today if it had
 * already run out (paying now doesn't buy back the days it was off). */
export function defaultRenewalStart(previousEndDate: string, today: string): string {
  return daysBetween(today, previousEndDate) >= 0 ? previousEndDate : today;
}

/** Fills a reminder template: {customer}, {service}, {account}, {end_date}, {days}, {business}. Unknown
 * placeholders are left as typed, so a typo shows in the preview instead of vanishing. */
export function fillNoticeTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match));
}

export const DEFAULT_NOTICE_TEMPLATES: Record<SubscriptionNoticeStage, string> = {
  week:
    "Hello {customer}, this is {business}. Your {service} subscription (account {account}) expires on {end_date}, in {days} days. Renew early to avoid interruption.",
  three_days:
    "Hello {customer}, a reminder from {business}: your {service} subscription (account {account}) expires in {days} days, on {end_date}. Renew now to keep watching without interruption.",
  due: "Hello {customer}, your {service} subscription (account {account}) expires today, {end_date}. Renew with {business} today to stay connected.",
  expired:
    "Hello {customer}, your {service} subscription (account {account}) expired on {end_date}. Renew with {business} and you'll be back on straight away."
};
