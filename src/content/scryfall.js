// Scryfall content script — injects a Dollar Commander row into the
// legality table on Scryfall card detail pages.
//
// Lives in the extension's ISOLATED world. Card detail pages
// (`/card/{set}/{cn}/{slug}`) ship `<meta name="scryfall:oracle:id">` +
// `<meta name="scryfall:card:id">` in <head>, and render Scryfall's
// native `<dl class="card-legality">` table on the page. We inject a
// "$ Commander" row directly under the existing "Penny" row so it
// blends with the surrounding format-legality list.
//
// We deliberately do NOT render anything on search-result pages (grid,
// full, checklist views): the pill badges were too intrusive next to
// card titles and didn't carry their weight relative to the price info
// Scryfall already shows.

import { removeOverlayIn, renderLegalityRow } from "./common/overlay.js";
import { settingsKey } from "../lib/settings.js";

const RUNTIME_MSG = "dollar-commander:lookup";
const MUTATION_DEBOUNCE_MS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let mutationTimer = null;
let lastBatchKey = "";
let loadingRetryTimer = null;
const LOADING_RETRY_MS = 5000;

// Auto-bootstrap when running in a browser content-script context. The guard
// lets us import this module from Node-based unit tests without side effects.
if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) {
  bootstrap();
}

function bootstrap() {
  if (window.location.hostname !== "scryfall.com" &&
      window.location.hostname !== "www.scryfall.com") {
    return;
  }
  chrome.storage?.onChanged?.addListener?.((_changes, area) => {
    if (area !== "local") return;
    lastBatchKey = "";              // force re-render after settings change
    scheduleScan();
  });
  // Background SW broadcasts this when its first successful fetch lands;
  // re-scan so any "Downloading…" placeholders pick up real legality data.
  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.type === "dollar-commander:data-ready") {
      clearLoadingRetry();
      lastBatchKey = "";
      scheduleScan();
    }
  });
  scheduleScan();
  observeMutations();
  window.addEventListener("popstate", scheduleScan);
}

function observeMutations() {
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations that are only our own legality-row insertions to
    // avoid feedback loops.
    let interesting = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains("dollar-commander-legality-row")) continue;
        if (node.closest?.(".dollar-commander-legality-row")) continue;
        interesting = true; break;
      }
      if (interesting) break;
    }
    if (interesting) {
      // The page DOM changed under us — Scryfall's SPA navigations swap
      // the legality table when moving between cards, and our previously
      // injected row is gone. Force a re-render.
      lastBatchKey = "";
      scheduleScan();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function scheduleScan() {
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => {
    mutationTimer = null;
    scanAndBadge().catch((err) => console.warn("[dollar-commander]", err));
  }, MUTATION_DEBOUNCE_MS);
}

// Safety net for when the SW's `dollar-commander:data-ready` broadcast
// doesn't reach us (cold-loaded tab, SW killed before broadcast, etc.).
// Forces a re-scan every LOADING_RETRY_MS until a lookup actually succeeds,
// at which point `clearLoadingRetry()` stops the loop.
function scheduleLoadingRetry() {
  if (loadingRetryTimer) return;
  loadingRetryTimer = setTimeout(() => {
    loadingRetryTimer = null;
    lastBatchKey = "";
    scheduleScan();
  }, LOADING_RETRY_MS);
}

function clearLoadingRetry() {
  if (loadingRetryTimer) {
    clearTimeout(loadingRetryTimer);
    loadingRetryTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Scan + render
// ---------------------------------------------------------------------------

async function scanAndBadge() {
  const enabled = await isEnabled();
  if (!enabled) {
    removeOverlayIn(document.body);
    return;
  }

  const candidates = collectCardCandidates(document);
  if (candidates.size === 0) return;

  const oracleIds = new Set();
  for (const c of candidates.values()) {
    if (c.oracleId) oracleIds.add(c.oracleId);
  }

  // Skip the round-trip if the candidate batch is identical to the previous
  // scan; the legality row already reflects the current state.
  const batchKey = [...oracleIds].sort().join("|");
  if (batchKey === lastBatchKey) return;
  lastBatchKey = batchKey;

  const response = await sendMessage({
    type: RUNTIME_MSG,
    oracleIds: [...oracleIds],
  });
  if (!response?.ok) {
    if (response?.error === "loading") {
      // SW is still pulling the initial ~21 MB index. Render a "Downloading…"
      // placeholder per candidate so the user sees that something is
      // happening rather than a silent empty row.
      //
      // Recovery: we *expect* the SW to broadcast `dollar-commander:data-ready`
      // once the fetch lands, and that handler resets lastBatchKey + reschedules
      // the scan. As a safety net for missed broadcasts (cold-loaded tabs,
      // SW killed mid-fetch, etc.), we also kick a periodic retry that
      // forces another lookup until we get real data. Keep lastBatchKey
      // set to its current value so unrelated DOM churn doesn't trigger
      // a flood of duplicate "loading" lookups.
      const loadingCtx = { thresholdUsd: undefined, stale: false };
      for (const [host] of candidates) {
        renderLegalityRow(host, { state: "loading" }, loadingCtx);
      }
      scheduleLoadingRetry();
    }
    return;
  }

  clearLoadingRetry();

  const stale = !!response.dataStale;
  for (const [host, c] of candidates) {
    const evaluation = response.oracles?.[c.oracleId];
    if (!evaluation) continue;

    renderLegalityRow(host, evaluation, {
      thresholdUsd: response.settings?.thresholdUsd,
      stale,
    });
  }
}

// ---------------------------------------------------------------------------
// Card discovery
// ---------------------------------------------------------------------------

/**
 * Walk the DOM and return a Map of `host element` -> candidate descriptor
 * for every card we want to annotate. Each descriptor carries an `oracleId`
 * that handleLookup resolves through the price index.
 *
 * The detail page is the ONLY render target — search-result pages (grid,
 * full, checklist) are deliberately ignored. The detail page exposes the
 * canonical oracle_id via `<meta name="scryfall:oracle:id">` in <head>,
 * and we render exclusively inside the native `dl.card-legality` table.
 *
 * Exported for tests so a synthetic DOM can exercise the extraction logic
 * without going through the full background-SW round-trip.
 */
export function collectCardCandidates(doc) {
  const out = new Map();

  const oracleMeta = doc.querySelector("meta[name='scryfall:oracle:id']");
  const metaOracleId = oracleMeta?.getAttribute?.("content") ?? null;

  // Single-card detail page (`/card/...`). If no oracle meta, this isn't
  // a detail page and we render nothing.
  if (!metaOracleId || !UUID_RE.test(metaOracleId)) return out;

  // Anchor on Scryfall's native `dl.card-legality`, inserting our row
  // directly under "Penny". If the table or the Penny anchor is missing
  // (schemes, vanguard, tokens, or a future localized layout) we render
  // nothing on this page rather than slap a pill next to the card title
  // — explicit user preference.
  const dl = doc.querySelector("dl.card-legality");
  if (dl && hasPennyAnchor(dl)) {
    out.set(dl, { oracleId: metaOracleId });
  }
  return out;
}

// Returns true iff `dl` contains a `<dt>` with textContent "Penny".
// We require this anchor before injecting our Dollar row so we never
// blind-append on cards with non-standard / localized legality markup.
function hasPennyAnchor(dl) {
  for (const dt of dl.querySelectorAll("dt")) {
    if ((dt.textContent ?? "").trim() === "Penny") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Settings + messaging helpers
// ---------------------------------------------------------------------------

async function isEnabled() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(settingsKey(), (data) => {
        const s = data?.[settingsKey()];
        if (s && s.enabledSites && typeof s.enabledSites.scryfall === "boolean") {
          resolve(s.enabledSites.scryfall);
        } else {
          resolve(true);   // default enabled
        }
      });
    } catch {
      resolve(true);
    }
  });
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) });
    }
  });
}
