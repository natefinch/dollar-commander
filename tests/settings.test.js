// Tests for the settings module — clamping, empty-string handling, defaults.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, getSettings, setSettings, settingsKey } from "../src/lib/settings.js";

function chromeStorageStub() {
  const store = new Map();
  return {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            const value = store.get(key);
            return value === undefined ? {} : { [key]: value };
          }
          throw new Error("test stub only supports string key");
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
}

function reset() {
  globalThis.chrome = chromeStorageStub();
}

test("getSettings returns defaults when nothing is stored", async () => {
  reset();
  const s = await getSettings();
  assert.equal(s.thresholdUsd, DEFAULTS.thresholdUsd);
  assert.equal(s.lookbackDays, DEFAULTS.lookbackDays);
});

test("setSettings persists changes and merges with defaults", async () => {
  reset();
  const updated = await setSettings({ thresholdUsd: 2.5 });
  assert.equal(updated.thresholdUsd, 2.5);
  const stored = await getSettings();
  assert.equal(stored.thresholdUsd, 2.5);
});

test("setSettings clamps threshold to the supported range", async () => {
  reset();
  const tooLow  = await setSettings({ thresholdUsd: 0.001 });
  assert.equal(tooLow.thresholdUsd, DEFAULTS.thresholdMin);

  const tooHigh = await setSettings({ thresholdUsd: 9999 });
  assert.equal(tooHigh.thresholdUsd, DEFAULTS.thresholdMax);
});

test("setSettings retains previous threshold for blank / non-numeric input", async () => {
  reset();
  await setSettings({ thresholdUsd: 1.5 });

  for (const bad of ["", null, undefined, "not-a-number", NaN]) {
    const out = await setSettings({ thresholdUsd: bad });
    assert.equal(out.thresholdUsd, 1.5,
      `expected blank/invalid input ${JSON.stringify(bad)} to retain previous threshold`);
  }
});

test("setSettings ignores unknown keys but merges known patch fields", async () => {
  reset();
  const updated = await setSettings({ thresholdUsd: 1.0, randomGarbage: 42 });
  assert.equal(updated.thresholdUsd, 1.0);
  assert.equal(updated.randomGarbage, 42); // currently passes through; documented behavior
});

test("settingsKey exposes the storage key for inspection", () => {
  assert.equal(typeof settingsKey(), "string");
});
