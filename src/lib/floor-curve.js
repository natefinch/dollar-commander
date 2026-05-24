// floor-curve — pure functions over the published per-card price-floor curve.
//
// The published curve is an ascending-by-price list of [priceUsd, isoDate]
// pairs representing the Pareto frontier of (price, date) observations in
// the lookback window: for each entry, no later date had a price <= entry.price.
// This shape supports two queries efficiently for any user-chosen threshold T:
//
//   1. `legal = minFloorPrice(floor) <= T`
//   2. `lastAtOrBelow(floor, T)` = the most recent ISO date where the card
//      was at-or-below T. Used for warning/rotation state.

/**
 * Return the most recent ISO date the card was at-or-below `thresholdUsd`,
 * or null if no entry qualifies.
 */
export function lastAtOrBelow(floor, thresholdUsd) {
  if (!Array.isArray(floor) || floor.length === 0) return null;
  if (!Number.isFinite(thresholdUsd)) return null;

  let bestDate = null;
  for (const entry of floor) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [price, date] = entry;
    if (!Number.isFinite(price) || typeof date !== "string") continue;
    if (price > thresholdUsd) break;            // floor is sorted ascending by price
    bestDate = date;                            // keep walking to find the largest qualifying price
  }
  return bestDate;
}

/** Return the cheapest price on the floor, or null if the floor is empty. */
export function minFloorPrice(floor) {
  if (!Array.isArray(floor) || floor.length === 0) return null;
  const first = floor[0];
  if (!Array.isArray(first) || first.length !== 2) return null;
  const [price] = first;
  return Number.isFinite(price) ? price : null;
}

/**
 * Validate a floor-curve array. Returns true iff the input matches the
 * published schema (array of two-element [price, dateString] pairs, sorted
 * ascending by price). Used to reject malformed inputs at the boundary.
 */
export function isValidFloor(floor) {
  if (!Array.isArray(floor)) return false;
  let prevPrice = -Infinity;
  for (const entry of floor) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [price, date] = entry;
    if (!Number.isFinite(price) || price < 0) return false;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    if (price < prevPrice) return false;
    prevPrice = price;
  }
  return true;
}
