// Dollar Commander background service worker.

import { evaluate, isStale, STATES } from "./lib/legality.js";
import {
  dataAsOf,
  getCachedIndex,
  getIndex,
  hasIndex,
  invalidateCache,
  isFetching,
  warmFromStorage,
} from "./lib/price-index.js";
import { getSettings } from "./lib/settings.js";

const REFRESH_ALARM = "dollar-commander:refresh";
const REFRESH_PERIOD_MIN = 60 * 12;  // 12 hours
const RETRY_ALARM = "dollar-commander:refresh-retry";
const RETRY_DELAY_MIN = 15;

// Throttle on-demand refreshes (those kicked by handleLookup, NOT by the
// alarms or the popup's manual refresh). When the network is failing, the
// content-script's 5s loading-retry combined with the cacheAge check below
// could trigger a fresh refresh on every lookup; this floor keeps the
// retry cadence sane (~1 attempt/min) while the 15-min retry alarm handles
// real backoff.
const ONDEMAND_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
let lastOndemandRefreshAt = 0;

// Tabs we broadcast `data-ready` to once the index becomes available.
// Must match the `host_permissions` for any site that has a content script.
const BROADCAST_TAB_URLS = ["https://scryfall.com/*"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
  initialWarmAndRefresh();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
  initialWarmAndRefresh();
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === REFRESH_ALARM || name === RETRY_ALARM) {
    refreshWithRetry();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;

  if (msg.type === "dollar-commander:lookup") {
    handleLookup(msg).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
    return true; // async response
  }

  if (msg.type === "dollar-commander:refresh") {
    invalidateCache();
    refreshAndBroadcast()
      .then(() => sendResponse({ ok: true, dataAsOf: dataAsOf() }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg.type === "dollar-commander:status") {
    sendResponse({
      ok: true,
      dataAsOf: dataAsOf(),
      // `loading` lets the popup distinguish "fetch in progress" from
      // "fetch failed; we have nothing to show".
      loading: !hasIndex() && isFetching(),
      hasIndex: hasIndex(),
    });
    return false;
  }

  return false;
});

async function initialWarmAndRefresh() {
  // Warm from storage first so a slow/failed network doesn't leave the
  // extension lookup-less on a cold start.
  await warmFromStorage().catch(() => null);
  refreshAndBroadcast().catch(() => {
    // refreshAndBroadcast already logs + schedules a retry; swallow here so
    // the unhandled-rejection logger doesn't fire on a known recoverable
    // path.
  });
}

function refreshWithRetry() {
  refreshAndBroadcast().catch(() => { /* already handled */ });
}

/**
 * Refresh the index and, on success, tell every open Scryfall content
 * script to re-scan so it can replace any "Downloading…" placeholders with
 * real legality info.
 *
 * "Success" here means a *fresh* fetch landed — not just that getIndex()
 * returned a value. getIndex() falls back to stale cache on network
 * failure (graceful degradation), but we don't want that path to clear
 * the retry alarm or fire data-ready, because no new data actually
 * landed. We detect this by comparing parsedAt before/after.
 */
async function refreshAndBroadcast() {
  const before = getCachedIndex()?.parsedAt ?? 0;
  try {
    await getIndex({ force: true });
  } catch (err) {
    console.warn("Index refresh failed; scheduling retry:", err?.message ?? err);
    chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MIN });
    throw err;
  }
  const after = getCachedIndex()?.parsedAt ?? 0;
  if (after > before) {
    chrome.alarms.clear(RETRY_ALARM);
    broadcastDataReady();
  } else {
    // getIndex returned stale cached fallback after a network failure
    // it swallowed. Treat as a real failure so the retry alarm fires.
    console.warn("Refresh fell back to stale cache; scheduling retry");
    chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MIN });
  }
}

/**
 * Throttled on-demand refresh kick. Used by handleLookup so that a stuck
 * content-script retry loop can't translate into one network attempt per
 * lookup when fetches are failing.
 */
function maybeKickOndemandRefresh() {
  const now = Date.now();
  if (now - lastOndemandRefreshAt < ONDEMAND_REFRESH_MIN_INTERVAL_MS) return;
  lastOndemandRefreshAt = now;
  refreshAndBroadcast().catch(() => { /* retry alarm handles it */ });
}

function broadcastDataReady() {
  // `chrome.tabs.query` may not be available in unit-test contexts; bail
  // quietly. In a real SW with our host permissions for scryfall.com, this
  // succeeds without needing the `tabs` permission.
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
  chrome.tabs.query({ url: BROADCAST_TAB_URLS }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      try {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "dollar-commander:data-ready", dataAsOf: dataAsOf() },
          () => {
            // Ignore "Receiving end does not exist" — that tab simply has
            // no content script loaded (e.g., it was opened before the
            // extension was installed).
            void chrome.runtime.lastError;
          },
        );
      } catch { /* defensive: never let broadcast throw */ }
    }
  });
}

async function handleLookup({ oracleIds = [], scryfallIds = [] }) {
  // First-fetch behaviour: don't block the content script on a fresh ~21 MB
  // download. Surface a `loading` error so it can render "Downloading…"
  // placeholders, and ensure a fetch is actually in motion (the SW may
  // have been killed since install and just woken up).
  if (!hasIndex()) {
    // The SW may have been killed by MV3 after a successful fetch; the
    // last-good index still lives in chrome.storage.local. Warm from
    // storage before deciding to show "Downloading…", so a cold-restart
    // doesn't regress every page back to a loading placeholder.
    await warmFromStorage().catch(() => null);
  }
  if (!hasIndex()) {
    if (!isFetching()) {
      maybeKickOndemandRefresh();
    }
    return { ok: false, error: "loading" };
  }

  // Use the in-memory cache directly rather than awaiting getIndex(): a
  // warmed-from-storage cache is intentionally marked stale (parsedAt=0)
  // and getIndex() would block on a fresh ~21 MB fetch. We want the
  // content-script lookup to return immediately with the warmed data,
  // letting a background refresh fire separately.
  const idx = getCachedIndex();

  // If the in-memory cache is stale (e.g., warmed from storage, or older
  // than STALE_AFTER_MS), kick a background refresh — throttled — so the
  // data eventually updates without blocking this lookup or hammering the
  // origin if fetches are failing.
  const cacheAgeMs = Date.now() - (idx.parsedAt ?? 0);
  if (cacheAgeMs >= 6 * 60 * 60 * 1000 && !isFetching()) {
    maybeKickOndemandRefresh();
  }
  const settings = await getSettings();
  const asOf = idx.manifest.as_of_date ?? null;
  const stale = isStale(asOf);

  // Resolve scryfallIds → oracleIds against the loaded card-index directly.
  const sidResolutions = scryfallIds.map((sid) => {
    const oracleId = idx.cardIndex.scryfall_id_to_oracle[sid] ?? null;
    return { sid, oracleId };
  });

  const oracleBatch = new Set(oracleIds);
  for (const { oracleId } of sidResolutions) {
    if (oracleId) oracleBatch.add(oracleId);
  }

  const oracleResults = {};
  for (const oid of oracleBatch) {
    const record = idx.priceIndex.cards[oid] ?? null;
    oracleResults[oid] = evaluate(record, settings);
  }

  const scryfallResults = sidResolutions.map(({ sid, oracleId }) => ({
    scryfallId: sid,
    oracleId: oracleId ?? null,
    ...(oracleId ? oracleResults[oracleId] : { state: STATES.UNKNOWN }),
  }));

  return {
    ok: true,
    dataAsOf: asOf,
    dataStale: stale,
    settings: { thresholdUsd: settings.thresholdUsd, lookbackDays: settings.lookbackDays },
    oracles: oracleResults,
    scryfall: scryfallResults,
  };
}
