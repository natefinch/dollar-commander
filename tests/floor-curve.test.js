import test from "node:test";
import assert from "node:assert/strict";

import { isValidFloor, lastAtOrBelow, minFloorPrice } from "../src/lib/floor-curve.js";

test("lastAtOrBelow returns null on empty or invalid input", () => {
  assert.equal(lastAtOrBelow([], 1.0), null);
  assert.equal(lastAtOrBelow(null, 1.0), null);
  assert.equal(lastAtOrBelow(undefined, 1.0), null);
  assert.equal(lastAtOrBelow([[0.10, "2026-01-01"]], NaN), null);
});

test("lastAtOrBelow picks the largest qualifying price's date", () => {
  const floor = [
    [0.18, "2026-03-14"],
    [0.55, "2026-04-30"],
    [1.30, "2026-05-22"],
  ];
  assert.equal(lastAtOrBelow(floor, 0.10), null);
  assert.equal(lastAtOrBelow(floor, 0.18), "2026-03-14");
  assert.equal(lastAtOrBelow(floor, 0.20), "2026-03-14");
  assert.equal(lastAtOrBelow(floor, 0.55), "2026-04-30");
  assert.equal(lastAtOrBelow(floor, 1.00), "2026-04-30");
  assert.equal(lastAtOrBelow(floor, 1.30), "2026-05-22");
  assert.equal(lastAtOrBelow(floor, 100), "2026-05-22");
});

test("lastAtOrBelow handles a single-entry floor", () => {
  const floor = [[0.10, "2026-05-01"]];
  assert.equal(lastAtOrBelow(floor, 0.10), "2026-05-01");
  assert.equal(lastAtOrBelow(floor, 0.09), null);
});

test("lastAtOrBelow skips malformed entries silently", () => {
  const floor = [
    [0.18, "2026-03-14"],
    "not-a-pair",
    [Number.NaN, "2026-04-01"],
    [0.55, "2026-04-30"],
  ];
  assert.equal(lastAtOrBelow(floor, 1.0), "2026-04-30");
});

test("minFloorPrice returns the cheapest price or null", () => {
  assert.equal(minFloorPrice([]), null);
  assert.equal(minFloorPrice(null), null);
  assert.equal(minFloorPrice([[0.18, "2026-03-14"], [1.30, "2026-05-22"]]), 0.18);
});

test("isValidFloor accepts well-formed input", () => {
  assert.equal(isValidFloor([[0.18, "2026-03-14"], [1.30, "2026-05-22"]]), true);
  assert.equal(isValidFloor([]), true);
});

test("isValidFloor rejects malformed input", () => {
  assert.equal(isValidFloor("not-an-array"), false);
  assert.equal(isValidFloor([[0.18, "bad-date"]]), false);
  assert.equal(isValidFloor([[-1, "2026-05-22"]]), false);
  assert.equal(isValidFloor([[1.30, "2026-05-22"], [0.18, "2026-03-14"]]), false);
});
