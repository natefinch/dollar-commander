// settings — typed accessors for chrome.storage.local user preferences.
//
// `getSettings()` always returns a defaults-merged object so callers can read
// any setting without worrying about undefined keys. `setSettings(patch)`
// clamps the threshold to the supported MVP range.

const SETTINGS_KEY = "dollar-commander:settings";

export const DEFAULTS = Object.freeze({
  thresholdUsd: 1.0,
  lookbackDays: 365,
  warningDaysOut: 90,
  rotationMonths: [1, 7],
  thresholdMin: 0.05,
  thresholdMax: 25.0,
  enabledSites: { scryfall: true, moxfield: false, archidekt: false },
});

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.freeze({ ...DEFAULTS, ...(stored[SETTINGS_KEY] ?? {}) });
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };

  // Threshold: only update when the patch supplies a finite, non-blank
  // value. Empty strings, null, NaN, etc. retain the previous value rather
  // than silently clamping the user out of their intended setting.
  if (Object.prototype.hasOwnProperty.call(patch, "thresholdUsd")) {
    const raw = patch.thresholdUsd;
    const isBlank = raw === "" || raw === null || raw === undefined;
    const parsed = isBlank ? NaN : Number(raw);
    if (Number.isFinite(parsed)) {
      next.thresholdUsd = Math.min(
        DEFAULTS.thresholdMax,
        Math.max(DEFAULTS.thresholdMin, parsed),
      );
    } else {
      next.thresholdUsd = current.thresholdUsd;
    }
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function settingsKey() {
  return SETTINGS_KEY;
}
