// Shared overlay rendering for Dollar Commander on Scryfall.
//
// Only one render target: a "$ Commander" row injected into Scryfall's
// native `dl.card-legality` table on card detail pages. All visible text
// comes from `textContent` (never `innerHTML`) so data from the published
// index can never inject markup.

const LEGALITY_ROW_CLASS = "dollar-commander-legality-row";
const LEGALITY_ROW_ATTR = "data-dc-format-row";

// Native-styled legality row mapping. We piggyback on Scryfall's own
// `dd.legal` / `dd.not-legal` classes so the row blends with the existing
// legality table. Six internal states collapse to two visual states; the
// borderline (warning / scheduled_illegal) states still show "Legal" — they
// ARE legal today — but earn a ⚠️ to flag impending change. All nuance is
// preserved in the title tooltip.
const LEGALITY_STATE_MAP = Object.freeze({
  legal_recent:      { className: "legal",     text: "Legal" },
  legal_aging:       { className: "legal",     text: "Legal" },
  warning:           { className: "legal",     text: "Legal ⚠️" },
  scheduled_illegal: { className: "legal",     text: "Legal ⚠️" },
  illegal:           { className: "not-legal", text: "Not Legal" },
  unknown:           { className: "not-legal", text: "Unknown" },
  loading:           { className: "not-legal", text: "Downloading…" },
});

// Friendly state labels for the tooltip. Independent from the visual
// class/text mapping above so we can describe nuance in the hover text
// without leaking it into the row label.
const TOOLTIP_STATE_LABELS = Object.freeze({
  legal_recent:      "Legal",
  legal_aging:       "Legal (aging)",
  warning:           "Warning",
  scheduled_illegal: "Rotating out",
  illegal:           "Illegal",
  unknown:           "Unknown",
  loading:           "Downloading…",
});

/**
 * Render or update a "$ Commander" entry inside Scryfall's native
 * `dl.card-legality` table. Idempotent: subsequent calls update the
 * existing row in place.
 *
 * The caller MUST verify a Penny `<dt>` is present in `dl` before invoking;
 * we use it as the insertion anchor so the new row sits directly under
 * Penny. If absent (older/unfinished cards, localized markup) this function
 * returns null and renders nothing.
 *
 * @param dl          The `<dl class="card-legality">` element.
 * @param evaluation  legality.evaluate() output: { state, record?, lastUnder?, daysUntilRotation?, nextRotation? }.
 * @param ctx
 *   ctx.thresholdUsd  the threshold used for evaluation (for tooltip).
 *   ctx.stale (bool)  whether the data feed is stale (banner-style hint).
 * @returns the injected `<dd>`, or null if no Penny anchor was found.
 */
export function renderLegalityRow(dl, evaluation, ctx = {}) {
  if (!dl || !evaluation) return null;
  const doc = dl.ownerDocument ?? globalThis.document;
  if (!doc?.createElement) return null;

  let row = dl.querySelector(`[${LEGALITY_ROW_ATTR}="1"]`);
  let dd;
  if (row) {
    dd = row.querySelector("dd");
  } else {
    const pennyRow = findPennyRow(dl);
    if (!pennyRow) return null;     // i18n / missing-format fallback

    const item = doc.createElement("div");
    item.className = "card-legality-item";
    const dt = doc.createElement("dt");
    dt.textContent = "$ Commander";
    dd = doc.createElement("dd");
    item.appendChild(dt);
    item.appendChild(dd);

    row = doc.createElement("div");
    row.className = `card-legality-row ${LEGALITY_ROW_CLASS}`;
    row.setAttribute(LEGALITY_ROW_ATTR, "1");
    row.appendChild(item);

    // Insert directly after the Penny row. `nextSibling === null` means
    // Penny is the last row, in which case insertBefore appends at the end.
    dl.insertBefore(row, pennyRow.nextSibling);
  }

  const mapped = LEGALITY_STATE_MAP[evaluation.state] ?? LEGALITY_STATE_MAP.unknown;
  // We created `dd` ourselves, so overwriting className is safe and avoids
  // any accumulation of stale legality classes across re-renders.
  dd.className = mapped.className;
  dd.textContent = mapped.text + (ctx.stale ? "*" : "");
  dd.title = buildTooltip(evaluation, ctx);
  dd.setAttribute("aria-label", dd.title);
  return dd;
}

/**
 * Remove every injected Dollar Commander legality row from `root`. Used
 * when the extension is disabled on this site so the page returns to its
 * pristine state.
 */
export function removeOverlayIn(root) {
  if (!root) return;
  for (const row of root.querySelectorAll(`.${LEGALITY_ROW_CLASS}`)) row.remove();
}

function findPennyRow(dl) {
  for (const dt of dl.querySelectorAll("dt")) {
    const text = (dt.textContent ?? "").trim();
    if (text === "Penny") {
      // Walk up to the `.card-legality-row` ancestor.
      let cursor = dt.parentElement;
      while (cursor && cursor !== dl) {
        const cls = cursor.className ?? "";
        if (typeof cls === "string" && cls.split(/\s+/).includes("card-legality-row")) {
          return cursor;
        }
        cursor = cursor.parentElement;
      }
    }
  }
  return null;
}

function buildTooltip(evaluation, ctx) {
  if (evaluation.state === "loading") {
    return "Dollar Commander: downloading price data… this should take a few seconds on a fresh install.";
  }
  const lines = [`Dollar Commander: ${labelFor(evaluation.state)}`];
  if (ctx.thresholdUsd !== undefined) {
    lines.push(`Threshold: $${Number(ctx.thresholdUsd).toFixed(2)}`);
  }
  if (evaluation.record?.today != null) {
    lines.push(`Today: $${Number(evaluation.record.today).toFixed(2)}`);
  }
  if (evaluation.record?.min_549 != null) {
    lines.push(`Lowest in lookback: $${Number(evaluation.record.min_549).toFixed(2)}`);
  }
  if (evaluation.lastUnder) {
    lines.push(`Last at-or-below threshold: ${evaluation.lastUnder}`);
  }
  if (evaluation.nextRotation) {
    lines.push(`Rotates: ${evaluation.nextRotation}`);
  }
  if (evaluation.daysUntilRotation) {
    lines.push(`Days until rotation: ${evaluation.daysUntilRotation}`);
  }
  if (ctx.stale) {
    lines.push("Data is stale; legality may be out of date.");
  }
  return lines.join("\n");
}

function labelFor(state) {
  return TOOLTIP_STATE_LABELS[state] ?? "Unknown";
}
