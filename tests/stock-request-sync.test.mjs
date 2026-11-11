import { test } from "node:test";
import assert from "node:assert/strict";
import { stockRequestDecisionConflict } from "../src/lib/stock-request-sync.ts";
const now = "2026-11-11T10:00:00.000Z";
for (const status of ["approved", "rejected"]) {
  test(
    status +
      " cannot regress even with no baseline or a newer stale Pending copy",
    () => {
      const stored = { status, localUpdatedAt: new Date(now) };
      assert.equal(
        stockRequestDecisionConflict(stored, {
          status: "pending",
          localUpdatedAt: "2027-01-01",
        }),
        true,
      );
      assert.equal(
        stockRequestDecisionConflict(stored, {
          status: status === "approved" ? "rejected" : "approved",
          localUpdatedAt: now,
        }),
        true,
      );
      assert.equal(
        stockRequestDecisionConflict(stored, {
          status,
          localUpdatedAt: "2026-01-01",
        }),
        true,
      );
      assert.equal(
        stockRequestDecisionConflict(stored, { status, localUpdatedAt: now }),
        false,
      );
    },
  );
}
test("new requests and first decisions remain valid", () => {
  assert.equal(
    stockRequestDecisionConflict(null, { status: "pending" }),
    false,
  );
  assert.equal(
    stockRequestDecisionConflict({ status: "pending" }, { status: "approved" }),
    false,
  );
  assert.equal(
    stockRequestDecisionConflict({ status: "pending" }, { status: "rejected" }),
    false,
  );
});
