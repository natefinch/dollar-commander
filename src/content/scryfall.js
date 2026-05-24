// Scryfall content script — extracts oracle_ids from scryfall.com pages and
// mounts Dollar Commander badges next to card titles.
//
// Lives in the extension's ISOLATED world. Scryfall conveniently exposes
// stable identifiers in the DOM:
//
//   * Card detail pages (`/card/{set}/{cn}/{slug}`) carry
//     `<meta name="scryfall:oracle:id" content="...">` and
//     `<meta name="scryfall:card:id" content="...">` in <head>.
//   * Search grid results render `.card-grid-item[data-card-id="UUID"]`
//     containers whose anchors link to /card/{set}/{cn}/{slug}.

import { mountBadge, removeBadgesIn } from "./common/overlay.js";
import { settingsKey } from "../lib/settings.js";

const ROOT_ATTR = "data-dc-anchor";
const RUNTIME_MSG = "dollar-commander:lookup";
const MUTATION_DEBOUNCE_MS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let mutationTimer = null;
let lastBatchKey = "";

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
  scheduleScan();
  observeMutations();
  window.addEventListener("popstate", scheduleScan);
}

function observeMutations() {
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations that are only badge insertions to avoid feedback loops.
    let interesting = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && !node.classList?.contains("dollar-commander-badge")) {
          interesting = true; break;
        }
      }
      if (interesting) break;
    }
    if (interesting) scheduleScan();
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

// ---------------------------------------------------------------------------
// Scan + badge
// ---------------------------------------------------------------------------

async function scanAndBadge() {
  const enabled = await isEnabled();
  if (!enabled) {
    removeBadgesIn(document.body);
    return;
  }

  const candidates = collectCardCandidates(document);
  if (candidates.size === 0) return;

  const oracleIds = new Set();
  const scryfallIds = new Set();
  for (const c of candidates.values()) {
    if (c.oracleId) oracleIds.add(c.oracleId);
    if (c.scryfallId) scryfallIds.add(c.scryfallId);
  }

  // Skip the round-trip if the candidate batch is identical to the previous
  // scan; the badges already reflect the current state.
  const batchKey = [...oracleIds].sort().join("|") + "::" + [...scryfallIds].sort().join("|");
  if (batchKey === lastBatchKey) return;
  lastBatchKey = batchKey;

  const response = await sendMessage({
    type: RUNTIME_MSG,
    oracleIds: [...oracleIds],
    scryfallIds: [...scryfallIds],
  });
  if (!response?.ok) return;

  const stale = !!response.dataStale;
  const oraclesByScryfall = new Map(
    response.scryfall.map((r) => [r.scryfallId, r]),
  );

  for (const [host, c] of candidates) {
    let evaluation = null;
    if (c.oracleId && response.oracles[c.oracleId]) {
      evaluation = response.oracles[c.oracleId];
    } else if (c.scryfallId && oraclesByScryfall.has(c.scryfallId)) {
      const r = oraclesByScryfall.get(c.scryfallId);
      evaluation = {
        state: r.state,
        record: r.record,
        lastUnder: r.lastUnder,
        daysUntilRotation: r.daysUntilRotation,
        nextRotation: r.nextRotation,
      };
    }
    if (!evaluation) continue;

    mountBadge(host, evaluation, {
      thresholdUsd: response.settings?.thresholdUsd,
      stale,
    });
  }
}

// ---------------------------------------------------------------------------
// Card discovery
// ---------------------------------------------------------------------------

/**
 * Walk the DOM and return a Map of `host element` -> `{oracleId?, scryfallId?}`.
 *
 * Exported for tests so a synthetic DOM can exercise the extraction
 * heuristics without going through the full background-SW round-trip.
 */
export function collectCardCandidates(doc) {
  const out = new Map();

  // Strategy 1: card-detail page — read the meta tags Scryfall ships in
  // <head>. We append the badge to the card-name element if present; else
  // to <h1> as a fallback.
  const oracleMeta = doc.querySelector("meta[name='scryfall:oracle:id']");
  const cardMeta   = doc.querySelector("meta[name='scryfall:card:id']");
  const oracleId   = oracleMeta?.getAttribute?.("content");
  const cardId     = cardMeta?.getAttribute?.("content");
  if (oracleId && UUID_RE.test(oracleId)) {
    const host = doc.querySelector(".card-text-card-name")
              ?? doc.querySelector("h1");
    if (host) {
      out.set(host, {
        oracleId,
        scryfallId: cardId && UUID_RE.test(cardId) ? cardId : undefined,
      });
      host.setAttribute(ROOT_ATTR, "1");
    }
  }

  // Strategy 2: search-grid items. Scryfall renders `.card-grid-item`
  // wrappers with `data-card-id="UUID"`; the anchor inside is the natural
  // place to hang a small badge.
  for (const item of doc.querySelectorAll("[data-card-id]")) {
    const sid = item.getAttribute("data-card-id");
    if (!sid || !UUID_RE.test(sid)) continue;
    const host = item.querySelector("a") ?? item;
    if (out.has(host)) continue;
    out.set(host, { scryfallId: sid });
    host.setAttribute(ROOT_ATTR, "1");
  }

  // Strategy 3: anchors with a scoped attribute we can also recognize.
  for (const a of doc.querySelectorAll("a[data-scryfall-id], a[data-card-id]")) {
    const sid = a.getAttribute("data-scryfall-id") ?? a.getAttribute("data-card-id");
    if (!sid || !UUID_RE.test(sid)) continue;
    if (out.has(a)) continue;
    out.set(a, { scryfallId: sid });
    a.setAttribute(ROOT_ATTR, "1");
  }

  return out;
}

// Exposed for follow-up phases; walks up from `element` looking for a UUID
// attribute Scryfall may render on a nearby ancestor.
export function findScryfallIdNear(element) {
  let cursor = element;
  for (let i = 0; cursor && i < 6; i++) {
    const attr =
      cursor.getAttribute?.("data-card-id") ??
      cursor.getAttribute?.("data-scryfall-id");
    if (typeof attr === "string" && UUID_RE.test(attr)) return attr;
    cursor = cursor.parentElement;
  }
  return null;
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
