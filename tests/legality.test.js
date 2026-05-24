import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  isStale,
  nextRotationISO,
  STATES,
} from "../src/lib/legality.js";

const SETTINGS = Object.freeze({
  thresholdUsd: 1.0,
  lookbackDays: 365,
  warningDaysOut: 90,
  rotationMonths: [1, 7],
});

const FRESH_AS_OF = "2026-05-24";
const NOW = new Date("2026-05-24T12:00:00Z");

function isoDaysAgo(now, daysAgo) {
  const ms = now.getTime() - daysAgo * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

test("evaluate returns UNKNOWN for missing records", () => {
  assert.equal(evaluate(null, SETTINGS, { now: NOW }).state, STATES.UNKNOWN);
  assert.equal(evaluate(undefined, SETTINGS, { now: NOW }).state, STATES.UNKNOWN);
});

test("evaluate returns LEGAL_RECENT when today is at-or-below threshold", () => {
  const record = {
    today: 0.95,
    min_549: 0.18,
    floor: [[0.18, "2026-03-14"], [0.95, "2026-05-24"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.LEGAL_RECENT);
});

test("evaluate returns ILLEGAL when no floor entry is at-or-below threshold", () => {
  const record = {
    today: 5.0,
    min_549: 3.5,
    floor: [[3.5, "2026-03-14"], [5.0, "2026-05-24"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.ILLEGAL);
});

test("evaluate returns LEGAL_AGING when today is above threshold but recent date qualifies", () => {
  const record = {
    today: 2.0,
    min_549: 0.18,
    floor: [[0.18, "2026-05-15"], [2.0, "2026-05-24"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.LEGAL_AGING);
});

test("evaluate returns WARNING when the last qualifying date is older than lookback - warningDaysOut", () => {
  const lastUnder = isoDaysAgo(NOW, 280);
  const record = {
    today: 2.0,
    min_549: 0.18,
    floor: [[0.18, lastUnder], [2.0, "2026-05-24"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.WARNING);
  assert.equal(out.lastUnder, lastUnder);
  assert.ok(out.daysUntilRotation > 0 && out.daysUntilRotation <= 90);
});

test("evaluate returns SCHEDULED when last qualifying date is older than lookback", () => {
  const lastUnder = isoDaysAgo(NOW, 366);
  const record = {
    today: 2.0,
    min_549: 0.18,
    floor: [[0.18, lastUnder], [2.0, "2026-05-24"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.SCHEDULED);
  assert.equal(out.nextRotation, "2026-07-01");
});

test("evaluate returns LEGAL_RECENT for arbitrary threshold > min_549", () => {
  const oldFloor = isoDaysAgo(NOW, 330);
  const record = {
    today: 4.99,
    min_549: 0.30,
    floor: [[0.30, oldFloor], [4.99, "2026-05-24"]],
  };
  const out = evaluate(record, { ...SETTINGS, thresholdUsd: 5.0 }, { now: NOW });
  assert.equal(out.state, STATES.LEGAL_RECENT);
});

test("evaluate rejects null today even when min_549 qualifies", () => {
  const record = {
    today: null,
    today_stale: true,
    min_549: 0.18,
    floor: [[0.18, "2026-05-22"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.notEqual(out.state, STATES.LEGAL_RECENT);
  assert.equal(out.state, STATES.LEGAL_AGING);
});

test("evaluate returns UNKNOWN with reason invalid_record on a corrupt date", () => {
  const record = {
    today: 2.0,
    min_549: 0.18,
    floor: [[0.18, "not-a-date"]],
  };
  const out = evaluate(record, SETTINGS, { now: NOW });
  assert.equal(out.state, STATES.UNKNOWN);
  assert.equal(out.reason, "invalid_record");
});

test("isStale flags dates older than 7 days", () => {
  assert.equal(isStale("2026-05-24", NOW), false);
  assert.equal(isStale("2026-05-17", NOW), false);
  assert.equal(isStale("2026-05-16", NOW), true);
  assert.equal(isStale("bad-date", NOW), true);
});

test("nextRotationISO finds the next Jan/Jul cutoff", () => {
  assert.equal(nextRotationISO(new Date("2026-05-24T12:00:00Z")), "2026-07-01");
  assert.equal(nextRotationISO(new Date("2026-07-01T12:00:00Z")), "2027-01-01");
  assert.equal(nextRotationISO(new Date("2026-12-31T12:00:00Z")), "2027-01-01");
  assert.equal(nextRotationISO(new Date("2026-01-15T12:00:00Z")), "2026-07-01");
});
