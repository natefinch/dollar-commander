// legality — pure threshold-evaluation logic.
//
// Given a per-card record from the published price-index and a settings
// object, evaluate the card's Dollar Commander legality state. All inputs
// are numerically validated; nullish/non-finite fields never accidentally
// pass a numeric comparison.

import { lastAtOrBelow } from "./floor-curve.js";

export const STATES = Object.freeze({
  LEGAL_RECENT:     "legal_recent",       // today <= threshold
  LEGAL_AGING:      "legal_aging",        // today > threshold; last_under fresh
  WARNING:          "warning",            // last_under within `lookbackDays - warningDaysOut`
  SCHEDULED:        "scheduled_illegal",  // last_under outside lookback; rotates next cutoff
  ILLEGAL:          "illegal",            // never under threshold in window
  UNKNOWN:          "unknown",            // card not in the index
});

const DATA_FRESHNESS_LIMIT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * Evaluate one card's legality state. Staleness is **not** mixed into the
 * per-card state; callers compute it once for the whole batch using
 * `isStale(dataAsOf)` and surface a banner in the popup. Per-card
 * legality continues to evaluate against the cached last-good index data.
 */
export function evaluate(record, settings, ctx = {}) {
  if (record == null) return { state: STATES.UNKNOWN };

  const thresholdUsd = Number(settings?.thresholdUsd);
  const lookbackDays = Number(settings?.lookbackDays);
  const warningDaysOut = Number(settings?.warningDaysOut);
  if (!Number.isFinite(thresholdUsd) || !Number.isFinite(lookbackDays) ||
      !Number.isFinite(warningDaysOut)) {
    return { state: STATES.UNKNOWN, reason: "invalid_settings" };
  }

  const today = Number.isFinite(record.today) ? record.today : null;
  const todayLegal = today !== null && today <= thresholdUsd;
  if (todayLegal) return { state: STATES.LEGAL_RECENT, record };

  const lastUnder = lastAtOrBelow(record.floor, thresholdUsd);
  if (!lastUnder) {
    return { state: STATES.ILLEGAL, record };
  }

  const lastUnderDate = parseUtcDate(lastUnder);
  if (isNaN(lastUnderDate.getTime())) {
    // Corrupt index entry. Don't claim legality with bad data.
    return { state: STATES.UNKNOWN, record, reason: "invalid_record" };
  }

  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const ageDays = Math.floor((now.getTime() - lastUnderDate.getTime()) / MS_PER_DAY);

  if (ageDays >= lookbackDays) {
    return {
      state: STATES.SCHEDULED,
      record,
      lastUnder,
      nextRotation: nextRotationISO(now, settings.rotationMonths ?? [1, 7]),
    };
  }
  if (ageDays >= lookbackDays - warningDaysOut) {
    return {
      state: STATES.WARNING,
      record,
      lastUnder,
      daysUntilRotation: lookbackDays - ageDays,
    };
  }
  return { state: STATES.LEGAL_AGING, record, lastUnder };
}

/** Return true iff `dataAsOf` is more than 7 days old (or unparseable). */
export function isStale(dataAsOf, now = new Date()) {
  if (typeof dataAsOf !== "string") return true;
  const parsed = parseUtcDate(dataAsOf);
  if (isNaN(parsed.getTime())) return true;
  const ageDays = Math.floor((now.getTime() - parsed.getTime()) / MS_PER_DAY);
  return ageDays > DATA_FRESHNESS_LIMIT_DAYS;
}

function parseUtcDate(isoYYYYMMDD) {
  return new Date(isoYYYYMMDD + "T00:00:00Z");
}

/** Return the next Jan 1 or Jul 1 (UTC) at-or-after `now`. */
export function nextRotationISO(now, months = [1, 7]) {
  const y = now.getUTCFullYear();
  const candidates = [];
  for (const m of months) {
    candidates.push(new Date(Date.UTC(y, m - 1, 1)));
    candidates.push(new Date(Date.UTC(y + 1, m - 1, 1)));
  }
  candidates.sort((a, b) => a - b);
  const future = candidates.find((d) => d > now);
  return future ? future.toISOString().slice(0, 10) : null;
}
