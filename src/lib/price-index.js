// price-index — fetch, validate, persist, cache, and look up the published
// index assets.
//
// Owns the manifest + price-index lifecycle in the MV3 background service
// worker. Content scripts message the SW; they never fetch directly.
//
// Durability: the last successfully-verified index payload is mirrored into
// chrome.storage.local so that an MV3 cold start (which discards module
// state) can serve lookups immediately while a refresh runs in the
// background. Without this, a failed first fetch after a cold start would
// leave the extension unable to evaluate anything.
//
// Configuration: the canonical data-release repo is hardcoded. Forks that
// want to point at a different release stream must edit this file (or extend
// build.js to substitute a build-time value).

const REPO = "natefinch/dollar-commander";
const RELEASE_TAG = "data-latest";
const MANIFEST_URL =
  `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/manifest.json`;
const ASSET_BASE = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/`;

const MAX_ASSET_BYTES = 10 * 1024 * 1024;     // reject above this (sanity guard)
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;     // re-check manifest every 6h
const STORAGE_KEY = "dollar-commander:last-index";

// In-memory cache for the SW lifetime.
let cached = null; // { manifest, priceIndex, cardIndex, parsedAt }

// Single-flight in-flight fetch so 100 concurrent lookups don't trigger 100
// duplicate manifest+asset downloads.
let inFlight = null;

let storageWarmAttempted = false;

/**
 * Return the parsed price-index + card-index. Single-flight: concurrent
 * callers awaiting an in-progress fetch share the same promise.
 *
 * On error: returns the cached object if one is in memory, else attempts
 * to warm from chrome.storage.local; if all sources fail, throws.
 */
export async function getIndex({ force = false } = {}) {
  if (cached && !force && Date.now() - cached.parsedAt < STALE_AFTER_MS) {
    return cached;
  }
  if (inFlight && !force) return inFlight;

  inFlight = (async () => {
    try {
      const manifest = await fetchManifest();
      validateManifest(manifest);

      const [priceIndex, cardIndex] = await Promise.all([
        fetchAndVerifyAsset(manifest.assets.price_index),
        fetchAndVerifyAsset(manifest.assets.card_index),
      ]);

      cached = { manifest, priceIndex, cardIndex, parsedAt: Date.now() };
      await persistToStorage(cached).catch((err) =>
        console.warn("Persist failed (non-fatal):", err)
      );
      return cached;
    } catch (err) {
      // Graceful degradation: in-memory cache, then storage-backed last-good.
      if (cached) return cached;
      const warmed = await tryWarmFromStorage();
      if (warmed) return warmed;
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

async function fetchManifest() {
  const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status}`);
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > 64 * 1024) {
    throw new Error(`Manifest unexpectedly large (${buf.byteLength} bytes)`);
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest is not an object");
  }
  const { major, minor } = manifest.schema_version ?? {};
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new Error("Manifest missing schema_version major/minor");
  }
  if (major !== 1) {
    throw new Error(`Unsupported schema_version major: ${major}`);
  }
  const assets = manifest.assets ?? {};
  for (const key of ["price_index", "card_index"]) {
    const a = assets[key];
    if (!a || !a.filename || !a.sha256 || !Number.isFinite(a.size)) {
      throw new Error(`Manifest assets.${key} is incomplete`);
    }
    if (a.size > MAX_ASSET_BYTES) {
      throw new Error(`Asset ${key} exceeds size guard: ${a.size}`);
    }
  }
  return true;
}

async function fetchAndVerifyAsset({ filename, sha256, size }) {
  const url = ASSET_BASE + filename;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Asset fetch failed (${filename}): HTTP ${response.status}`);
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength !== size) {
    throw new Error(
      `Asset size mismatch (${filename}): manifest=${size} got=${buf.byteLength}`,
    );
  }
  const actualHash = await sha256Hex(buf);
  if (actualHash !== sha256) {
    throw new Error(
      `Asset hash mismatch (${filename}): manifest=${sha256.slice(0, 8)}... got=${actualHash.slice(0, 8)}...`,
    );
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----- Durable persistence -----

async function persistToStorage(payload) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      manifest: payload.manifest,
      priceIndex: payload.priceIndex,
      cardIndex: payload.cardIndex,
      persistedAt: Date.now(),
    },
  });
}

async function tryWarmFromStorage() {
  if (storageWarmAttempted) return cached;
  storageWarmAttempted = true;
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const entry = stored[STORAGE_KEY];
  if (!entry?.manifest || !entry?.priceIndex || !entry?.cardIndex) return null;
  // Re-validate the persisted manifest in case the schema changed under us.
  try {
    validateManifest(entry.manifest);
  } catch {
    return null;
  }
  cached = {
    manifest: entry.manifest,
    priceIndex: entry.priceIndex,
    cardIndex: entry.cardIndex,
    parsedAt: 0,                 // force a refresh on next non-force call
  };
  return cached;
}

/** Eagerly populate the in-memory cache from persisted storage if possible. */
export async function warmFromStorage() {
  return tryWarmFromStorage();
}

/** Look up a card by oracle_id. Returns null if absent. */
export async function lookupByOracle(oracleId) {
  const idx = await getIndex();
  return idx.priceIndex.cards[oracleId] ?? null;
}

/** Resolve a Scryfall printing UUID to {oracleId, record}. */
export async function lookupByScryfallId(scryfallId) {
  const idx = await getIndex();
  const oracleId = idx.cardIndex.scryfall_id_to_oracle[scryfallId];
  if (!oracleId) return null;
  return { oracleId, record: idx.priceIndex.cards[oracleId] ?? null };
}

/** Return manifest.as_of_date or null if no index is loaded yet. */
export function dataAsOf() {
  return cached?.manifest?.as_of_date ?? null;
}

/** Force a fresh fetch on next getIndex(). */
export function invalidateCache() {
  cached = null;
  storageWarmAttempted = false;
}

// Exported for tests.
export const _internal = {
  get cached() { return cached; },
  set cached(v) { cached = v; },
  reset() { cached = null; inFlight = null; storageWarmAttempted = false; },
  MANIFEST_URL,
  ASSET_BASE,
  MAX_ASSET_BYTES,
  STORAGE_KEY,
};
