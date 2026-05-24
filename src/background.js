// Dollar Commander background service worker.

import { evaluate, isStale, STATES } from "./lib/legality.js";
import {
  dataAsOf,
  getIndex,
  invalidateCache,
  warmFromStorage,
} from "./lib/price-index.js";
import { getSettings } from "./lib/settings.js";

const REFRESH_ALARM = "dollar-commander:refresh";
const REFRESH_PERIOD_MIN = 60 * 12;  // 12 hours
const RETRY_ALARM = "dollar-commander:refresh-retry";
const RETRY_DELAY_MIN = 15;

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
    getIndex({ force: true })
      .then(() => sendResponse({ ok: true, dataAsOf: dataAsOf() }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }

  if (msg.type === "dollar-commander:status") {
    sendResponse({ ok: true, dataAsOf: dataAsOf() });
    return false;
  }

  return false;
});

async function initialWarmAndRefresh() {
  // Warm from storage first so a slow/failed network doesn't leave the
  // extension lookup-less on a cold start.
  await warmFromStorage().catch(() => null);
  refreshWithRetry();
}

function refreshWithRetry() {
  getIndex({ force: true })
    .then(() => chrome.alarms.clear(RETRY_ALARM))
    .catch((err) => {
      console.warn("Index refresh failed; scheduling retry:", err?.message ?? err);
      chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MIN });
    });
}

async function handleLookup({ oracleIds = [], scryfallIds = [] }) {
  // Await the index once at the top so all lookups share a single fetch and
  // we have a real `dataAsOf` to report (even on the first cold-start call).
  const idx = await getIndex();
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
