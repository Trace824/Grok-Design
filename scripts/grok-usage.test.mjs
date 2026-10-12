import assert from "node:assert/strict";
import test from "node:test";
import { parseBillingBody } from "../src/lib/grok-run/usage.ts";

const VIEW_KEYS = ["extraCreditCents", "period", "resetsAt", "tier", "unavailable", "usedPercent"];

const WEEKLY = {
  creditUsagePercent: 42,
  currentPeriod: {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-10-07T01:53:09.930Z",
    end: "2026-10-14T01:53:09.930Z",
  },
  prepaidBalance: { val: 0 },
  key: "should-not-leak",
};

test("parseBillingBody reads a flat weekly credits body and drops tokens", () => {
  const view = parseBillingBody(WEEKLY);
  assert.equal(view.unavailable, false);
  if (view.unavailable) return;
  assert.equal(view.usedPercent, 42);
  assert.equal(view.period, "week");
  assert.equal(view.resetsAt, "2026-10-14T01:53:09.930Z");
  assert.equal(view.tier, null);
  assert.equal(view.extraCreditCents, null);
  assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS);
  assert.equal(JSON.stringify(view).includes("should-not-leak"), false);
});

test("parseBillingBody reads a wrapped body with tier and extra credits", () => {
  const view = parseBillingBody({
    config: {
      creditUsagePercent: 10.4,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-11-01T00:00:00.000Z" },
      prepaidBalance: { val: 250 },
      refresh_token: "should-not-leak",
    },
    subscriptionTier: "SuperGrok",
    user_id: "should-not-leak",
  });
  assert.deepEqual(view, {
    unavailable: false,
    usedPercent: 10.4,
    period: "month",
    resetsAt: "2026-11-01T00:00:00.000Z",
    tier: "SuperGrok",
    extraCreditCents: 250,
  });
  assert.equal(JSON.stringify(view).includes("should-not-leak"), false);
});

test("parseBillingBody treats a missing percent on a credits body as zero", () => {
  const view = parseBillingBody({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-10-06T16:27:21.573493+00:00",
        end: "2026-10-13T16:27:21.573493+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    },
  });
  assert.equal(view.unavailable, false);
  if (view.unavailable) return;
  assert.equal(view.usedPercent, 0);
  assert.equal(view.period, "week");
  assert.equal(view.resetsAt, "2026-10-13T16:27:21.573493+00:00");
  assert.equal(view.extraCreditCents, null);
});

test("parseBillingBody reports unavailable when the body is not credits", () => {
  assert.deepEqual(parseBillingBody(null), { unavailable: true });
  assert.deepEqual(parseBillingBody({ error: "nope" }), { unavailable: true });
  assert.deepEqual(parseBillingBody({ config: { topUpMethod: "none" } }), { unavailable: true });
});
