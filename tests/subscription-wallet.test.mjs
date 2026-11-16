import { test } from "node:test";
import assert from "node:assert/strict";
import { periodsCovered, planWalletDeductions, pricePerPeriodCents, splitAlreadyPaid } from "../src/lib/subscription-wallet.ts";

test("the balance pays owed periods oldest first, whole periods only", () => {
  assert.deepEqual(planWalletDeductions(600_000, 150_000, ["2026-10", "2026-11"]), {
    periods: ["2026-10", "2026-11"],
    spentCents: 300_000,
    balanceAfterCents: 300_000,
  });
  assert.deepEqual(planWalletDeductions(200_000, 150_000, ["2026-10", "2026-11"]), {
    periods: ["2026-10"],
    spentCents: 150_000,
    balanceAfterCents: 50_000,
  });
});

test("a balance below one period's price pays nothing (no part payments)", () => {
  assert.deepEqual(planWalletDeductions(149_999, 150_000, ["2026-11"]), { periods: [], spentCents: 0, balanceAfterCents: 149_999 });
  assert.deepEqual(planWalletDeductions(500_000, null, ["2026-11"]), { periods: [], spentCents: 0, balanceAfterCents: 500_000 });
  assert.deepEqual(planWalletDeductions(500_000, 150_000, []), { periods: [], spentCents: 0, balanceAfterCents: 500_000 });
});

test("price per period: monthly price, yearly maintenance fee, nothing for one-off", () => {
  assert.equal(pricePerPeriodCents({ billingCycle: "MONTHLY", priceCents: 150_000, maintenanceFeeCents: null }), 150_000);
  assert.equal(pricePerPeriodCents({ billingCycle: "YEARLY", priceCents: 9_000_000, maintenanceFeeCents: 1_200_000 }), 1_200_000);
  assert.equal(pricePerPeriodCents({ billingCycle: "YEARLY", priceCents: 9_000_000, maintenanceFeeCents: null }), null);
  assert.equal(pricePerPeriodCents({ billingCycle: "ONCE", priceCents: 9_000_000, maintenanceFeeCents: null }), null);
});

test("periods covered", () => {
  assert.equal(periodsCovered(600_000, 150_000), 4);
  assert.equal(periodsCovered(100_000, 150_000), 0);
  assert.equal(periodsCovered(600_000, null), 0);
});

test("a payment for periods already paid goes to the balance instead of paying them twice", () => {
  assert.deepEqual(splitAlreadyPaid(["2026-11", "2026-12"], 300_000, new Set(["2026-11"])), {
    toRecord: ["2026-12"],
    perPeriodCents: 150_000,
    toBalanceCents: 150_000,
  });
  assert.deepEqual(splitAlreadyPaid(["2026-11"], 150_000, new Set()), { toRecord: ["2026-11"], perPeriodCents: 150_000, toBalanceCents: 0 });
  assert.deepEqual(splitAlreadyPaid([], 50_000, new Set()), { toRecord: [], perPeriodCents: 0, toBalanceCents: 50_000 });
});
