// Dollar Commander popup — threshold editor + data freshness display.
//
// Source of truth: chrome.storage.local. Background SW also reads from there,
// so changing the threshold in this popup automatically affects new lookups
// from content scripts without any direct message round-trip.

import { DEFAULTS, getSettings, setSettings } from "./lib/settings.js";

const els = {
  threshold:        document.getElementById("threshold-input"),
  thresholdReset:   document.getElementById("threshold-reset"),
  thresholdHelp:    document.getElementById("threshold-help"),
  staleBanner:      document.getElementById("stale-banner"),
  statusAsof:       document.getElementById("status-asof"),
  statusAge:        document.getElementById("status-age"),
  statusCards:      document.getElementById("status-cards"),
  refreshBtn:       document.getElementById("refresh-btn"),
  refreshStatus:    document.getElementById("refresh-status"),
  advLookback:      document.getElementById("adv-lookback"),
  advGrace:         document.getElementById("adv-grace"),
  siteScryfall:     document.getElementById("site-scryfall"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const settings = await getSettings();
  paintSettings(settings);

  els.threshold.addEventListener("input", onThresholdInput);
  els.threshold.addEventListener("change", onThresholdCommit);
  els.thresholdReset.addEventListener("click", onThresholdReset);
  els.siteScryfall.addEventListener("change", onScryfallToggle);
  els.refreshBtn.addEventListener("click", onRefreshClick);

  // Pull current status from the background SW (which carries dataAsOf and
  // manifest counts via the in-memory cache).
  await refreshStatusFromBackground();
}

function paintSettings(settings) {
  els.threshold.value = settings.thresholdUsd.toFixed(2);
  els.threshold.min = settings.thresholdMin;
  els.threshold.max = settings.thresholdMax;
  els.thresholdHelp.textContent =
    `Between $${settings.thresholdMin.toFixed(2)} and $${settings.thresholdMax.toFixed(2)}.`;
  els.siteScryfall.checked = !!settings.enabledSites?.scryfall;
  els.advLookback.textContent = `${settings.lookbackDays} days`;
}

// Persist live edits with a small debounce so content scripts re-render
// quickly without thrashing on every keystroke.
let inputDebounceTimer = null;
const INPUT_DEBOUNCE_MS = 200;

function onThresholdInput(event) {
  if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
  const raw = event.target.value;
  inputDebounceTimer = setTimeout(async () => {
    inputDebounceTimer = null;
    // Only persist if the input parses cleanly. Otherwise wait for blur.
    const parsed = Number(raw);
    if (raw !== "" && Number.isFinite(parsed)) {
      await setSettings({ thresholdUsd: raw });
    }
  }, INPUT_DEBOUNCE_MS);
}

async function onThresholdCommit(event) {
  if (inputDebounceTimer) {
    clearTimeout(inputDebounceTimer);
    inputDebounceTimer = null;
  }
  const raw = event.target.value;
  const updated = await setSettings({ thresholdUsd: raw });
  // Snap the displayed value back to the canonical clamped form so the
  // user sees what was actually saved.
  els.threshold.value = updated.thresholdUsd.toFixed(2);
}

async function onThresholdReset() {
  const updated = await setSettings({ thresholdUsd: DEFAULTS.thresholdUsd });
  els.threshold.value = updated.thresholdUsd.toFixed(2);
}

async function onScryfallToggle(event) {
  const current = await getSettings();
  await setSettings({
    enabledSites: { ...current.enabledSites, scryfall: event.target.checked },
  });
}

let refreshClearTimer = null;

async function onRefreshClick() {
  els.refreshBtn.disabled = true;
  els.refreshStatus.textContent = "Refreshing…";
  if (refreshClearTimer) {
    clearTimeout(refreshClearTimer);
    refreshClearTimer = null;
  }
  try {
    const response = await sendMessage({ type: "dollar-commander:refresh" });
    if (response?.ok) {
      els.refreshStatus.textContent = "Refreshed.";
      await refreshStatusFromBackground();
    } else {
      els.refreshStatus.textContent = `Failed: ${response?.error ?? "unknown error"}`;
    }
  } catch (err) {
    els.refreshStatus.textContent = `Failed: ${err.message}`;
  } finally {
    els.refreshBtn.disabled = false;
    refreshClearTimer = setTimeout(() => {
      els.refreshStatus.textContent = "";
      refreshClearTimer = null;
    }, 4000);
  }
}

async function refreshStatusFromBackground() {
  const response = await sendMessage({ type: "dollar-commander:status" }).catch(
    () => ({ ok: false }),
  );
  const asOf = response?.dataAsOf ?? null;
  if (!asOf) {
    els.statusAsof.textContent = "not yet loaded";
    els.statusAge.textContent = "waiting for first fetch";
    els.staleBanner.hidden = true;
    return;
  }
  els.statusAsof.textContent = asOf;
  const ageDays = daysBetween(new Date(asOf + "T00:00:00Z"), new Date());
  els.statusAge.textContent = ageDays === 0 ? "today" : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;

  if (ageDays > 7) {
    els.staleBanner.hidden = false;
    els.staleBanner.textContent =
      `Data is ${ageDays} days old; legality may be out of date. Try "Refresh now".`;
  } else {
    els.staleBanner.hidden = true;
  }

  // The status message doesn't carry card_count yet; use chrome.storage's
  // last-good copy if available (Phase 6 persists it there).
  try {
    const stored = await chrome.storage.local.get("dollar-commander:last-index");
    const cards = stored["dollar-commander:last-index"]?.priceIndex?.card_count;
    els.statusCards.textContent = Number.isFinite(cards)
      ? cards.toLocaleString()
      : "—";
  } catch {
    els.statusCards.textContent = "—";
  }
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function daysBetween(then, now) {
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

