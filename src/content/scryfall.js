// Scryfall content script — extracts oracle_ids from scryfall.com pages and
// mounts Dollar Commander badges next to card titles.
//
// Lives in the extension's ISOLATED world. Scryfall conveniently exposes
// stable identifiers in the DOM across four page modes:
//
//   * Card detail pages (`/card/{set}/{cn}/{slug}`) ship
//     `<meta name="scryfall:oracle:id">` + `<meta name="scryfall:card:id">`
//     in <head>, with the title rendered as `<span class="card-text-card-name">`.
//   * Full search view (`/search?as=full`) stacks multiple `.card-profile`
//     blocks — each holds a `button.deckbuilder-card-add-button[data-card-id]`
//     plus its own `.card-text-card-name`.
//   * Grid search view (`/search?as=grid`, the default) renders
//     `.card-grid-item[data-card-id]` wrappers around card images.
//   * Checklist search view (`/search?as=checklist`) renders
//     `table.checklist > tbody > tr[data-card-id]` rows; the name lives
//     in a `<td class="ellipsis"><a>...</a></td>` cell.
//
// We must NOT blindly select every `[data-card-id]` on the page — Scryfall
// scatters that attribute across visually-hidden buttons, language-flag
// anchors, print-history links, and card-tooltip popovers, and appending a
// badge into any of those is either invisible or wrecks the layout.

import { mountBadge, removeBadgesIn, renderLegalityRow } from "./common/overlay.js";
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
    // Ignore mutations that are only our own badge / legality-row insertions
    // to avoid feedback loops.
    let interesting = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const cls = node.classList;
        if (cls?.contains("dollar-commander-badge")) continue;
        if (cls?.contains("dollar-commander-legality-row")) continue;
        if (node.closest?.(".dollar-commander-legality-row")) continue;
        interesting = true; break;
      }
      if (interesting) break;
    }
    if (interesting) {
      // The page DOM changed under us — if Scryfall replaced the same card
      // tiles (e.g., Vue rerender of a search grid that happens to contain
      // the same set of UUIDs), the new host elements have no badges yet
      // even though our batch key is unchanged. Force a re-mount.
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

    mountFor(host, evaluation, c, response, stale);
  }
}

function mountFor(host, evaluation, candidate, response, stale) {
  const ctx = {
    thresholdUsd: response.settings?.thresholdUsd,
    stale,
    placement: candidate.placement ?? "inline",
  };
  if (candidate.placement === "legality-row") {
    renderLegalityRow(host, evaluation, ctx);
  } else {
    mountBadge(host, evaluation, ctx);
  }
}

// ---------------------------------------------------------------------------
// Card discovery
// ---------------------------------------------------------------------------

/**
 * Walk the DOM and return a Map of `host element` -> candidate descriptor.
 * Each descriptor may carry `oracleId`, `scryfallId`, and a `placement` hint
 * (`"inline"` for badges that flow next to text, `"absolute"` for corner
 * overlays on card-image tiles).
 *
 * Exported for tests so a synthetic DOM can exercise the extraction
 * heuristics without going through the full background-SW round-trip.
 */
export function collectCardCandidates(doc) {
  const out = new Map();

  const oracleMeta = doc.querySelector("meta[name='scryfall:oracle:id']");
  const cardMeta   = doc.querySelector("meta[name='scryfall:card:id']");
  const metaOracleId = oracleMeta?.getAttribute?.("content") ?? null;
  const metaCardId   = cardMeta?.getAttribute?.("content") ?? null;

  // -------------------------------------------------------------------------
  // Strategy A — single-card detail page (`/card/...`). The <head> meta
  // tags carry the canonical oracle_id, so we can skip the scryfall_id
  // round-trip entirely.
  //
  // Preferred render target on detail pages is Scryfall's native
  // `dl.card-legality` table — we inject a new "Dollar" row right under
  // "Penny" so it blends with the existing format-legality list. If the
  // table or the Penny anchor is missing (older cards, schemes, vanguard,
  // or a future localized layout), fall back to a pill badge next to the
  // card title so the user always sees *something*.
  // -------------------------------------------------------------------------
  if (metaOracleId && UUID_RE.test(metaOracleId)) {
    const dl = doc.querySelector("dl.card-legality");
    const hasPenny = dl ? hasPennyAnchor(dl) : false;
    const candidateInfo = {
      oracleId: metaOracleId,
      scryfallId: metaCardId && UUID_RE.test(metaCardId) ? metaCardId : undefined,
    };
    if (dl && hasPenny) {
      out.set(dl, { ...candidateInfo, placement: "legality-row" });
      dl.setAttribute(ROOT_ATTR, "1");
    } else {
      const host = doc.querySelector(".card-text-card-name")
                ?? doc.querySelector("h1");
      if (host) {
        out.set(host, { ...candidateInfo, placement: "inline" });
        host.setAttribute(ROOT_ATTR, "1");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Strategy B — full search view (`?as=full`) renders multiple
  // `.card-profile` blocks. Within each profile, the visually-hidden
  // deckbuilder-add button carries the printing's scryfall_id, and the
  // visible `.card-text-card-name` is our badge host.
  // -------------------------------------------------------------------------
  for (const profile of doc.querySelectorAll(".card-profile")) {
    const btn = profile.querySelector(".deckbuilder-card-add-button[data-card-id]");
    const sid = btn?.getAttribute?.("data-card-id");
    if (!sid || !UUID_RE.test(sid)) continue;
    const host = profile.querySelector(".card-text-card-name");
    if (!host || out.has(host)) continue;
    out.set(host, { scryfallId: sid, placement: "inline" });
    host.setAttribute(ROOT_ATTR, "1");
  }

  // -------------------------------------------------------------------------
  // Strategy C — grid search view (`?as=grid`, the default).
  // `.card-grid-item[data-card-id]` is the wrapper around each card image.
  // We mount on the wrapper (NOT the inner image-link `<a>`) because
  // appending a child inside the image-link gets clipped by Scryfall's
  // layout. The badge floats absolutely in the top-right corner of the
  // card tile.
  // -------------------------------------------------------------------------
  for (const item of doc.querySelectorAll(".card-grid-item[data-card-id]")) {
    const sid = item.getAttribute("data-card-id");
    if (!sid || !UUID_RE.test(sid)) continue;
    if (out.has(item)) continue;
    out.set(item, { scryfallId: sid, placement: "absolute" });
    item.setAttribute(ROOT_ATTR, "1");
  }

  // -------------------------------------------------------------------------
  // Strategy D — checklist search view (`?as=checklist`). Rows under
  // `table.checklist` carry `data-card-id`. Mount in the USD-price `<td>`
  // (the cell containing `a.currency-usd`) — that cell is non-`.ellipsis`,
  // so the badge isn't clipped, and it's the column the user is already
  // scanning for affordability info. Falls back to a sane row anchor.
  // -------------------------------------------------------------------------
  for (const row of doc.querySelectorAll("table.checklist tr[data-card-id]")) {
    const sid = row.getAttribute("data-card-id");
    if (!sid || !UUID_RE.test(sid)) continue;
    const usdLink = row.querySelector("a.currency-usd");
    const host = usdLink?.parentElement
              ?? row.querySelector(".ellipsis a")
              ?? row.querySelector("a");
    if (!host || out.has(host)) continue;
    out.set(host, { scryfallId: sid, placement: "inline" });
    host.setAttribute(ROOT_ATTR, "1");
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
