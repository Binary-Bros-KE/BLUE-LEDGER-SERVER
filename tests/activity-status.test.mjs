import { test } from "node:test";
import assert from "node:assert/strict";
import { activityState, isOlderVersion, latest, shouldRestamp } from "../src/lib/activity-status.ts";

const now = new Date("2026-11-21T12:00:00Z");
const ago = (ms) => new Date(now.getTime() - ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test("activity buckets", () => {
  assert.equal(activityState(null, now), "never");
  assert.equal(activityState(ago(30_000), now), "online");
  assert.equal(activityState(ago(2 * MIN), now), "online");
  assert.equal(activityState(ago(3 * MIN), now), "today");
  assert.equal(activityState(ago(DAY), now), "today");
  assert.equal(activityState(ago(2 * DAY), now), "week");
  assert.equal(activityState(ago(7 * DAY), now), "week");
  assert.equal(activityState(ago(8 * DAY), now), "idle");
  assert.equal(activityState(ago(30 * DAY), now), "idle");
  assert.equal(activityState(ago(31 * DAY), now), "dormant");
});

test("latest of several timestamps", () => {
  assert.equal(latest(null, undefined), null);
  assert.equal(latest(ago(DAY), null, ago(MIN))?.getTime(), ago(MIN).getTime());
});

test("outdated desktop versions", () => {
  assert.equal(isOlderVersion("2.0.1", "2.0.2"), true);
  assert.equal(isOlderVersion("1.9.0", "2.0.2"), true);
  assert.equal(isOlderVersion("2.0.2", "2.0.2"), false);
  assert.equal(isOlderVersion("2.0.10", "2.0.2"), false, "numeric, not text");
  assert.equal(isOlderVersion(null, "2.0.2"), false);
  assert.equal(isOlderVersion("2.0.1", null), false);
});

test("restamp only when stale", () => {
  assert.equal(shouldRestamp(null, 5 * MIN, now), true);
  assert.equal(shouldRestamp(ago(4 * MIN), 5 * MIN, now), false);
  assert.equal(shouldRestamp(ago(5 * MIN), 5 * MIN, now), true);
});
