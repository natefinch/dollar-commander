// Shared overlay rendering for Dollar Commander badges across sites.
//
// `mountBadge(host, evaluation)` attaches a pill-shaped badge to the given
// host element. All visible text comes from `textContent` (never
// `innerHTML`) so data from the published index can never inject markup.

const BADGE_CLASS = "dollar-commander-badge";
const BADGE_DATA_ATTR = "data-dc-mounted";
const LEGALITY_ROW_CLASS = "dollar-commander-legality-row";
const LEGALITY_ROW_ATTR = "data-dc-format-row";

const STATE_STYLES = Object.freeze({
  legal_recent:     { label: "Legal",         color: "#14532d", bg: "#dcfce7", outline: "#86efac" },
  legal_aging:      { label: "Legal (aging)", color: "#1e3a8a", bg: "#dbeafe", outline: "#93c5fd" },
  warning:          { label: "Warning",       color: "#78350f", bg: "#fef3c7", outline: "#fcd34d" },
  scheduled_illegal:{ label: "Rotating out",  color: "#7c2d12", bg: "#ffedd5", outline: "#fdba74" },
  illegal:          { label: "Illegal",       color: "#7f1d1d", bg: "#fee2e2", outline: "#fca5a5" },
  unknown:          { label: "Unknown",       color: "#475569", bg: "#f1f5f9", outline: "#cbd5e1" },
  loading:          { label: "Downloading…",  color: "#475569", bg: "#f1f5f9", outline: "#cbd5e1" },
});

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

/**
 * Render or update a Dollar Commander badge on `host`.
 *
 * @param host  DOM element to anchor the badge to. The badge is appended
 *              once; subsequent calls update the existing badge in place.
 * @param evaluation  output of legality.evaluate(): { state, record?, lastUnder?, daysUntilRotation?, nextRotation? }.
 * @param ctx
 *   ctx.thresholdUsd     the threshold used for evaluation (for tooltip).
 *   ctx.stale (bool)     whether the data feed is stale (banner-style hint).
 *   ctx.placement        "inline" (default) flows next to text; "absolute"
 *                        floats the badge into the host's top-right corner.
 *                        Use "absolute" for image-tile hosts (card grids).
 */
export function mountBadge(host, evaluation, ctx = {}) {
  if (!host || !evaluation) return null;
  let badge = host.querySelector(`.${BADGE_CLASS}`);
  if (!badge) {
    badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.setAttribute(BADGE_DATA_ATTR, "1");
    host.appendChild(badge);
  }

  const style = STATE_STYLES[evaluation.state] ?? STATE_STYLES.unknown;
  const placement = ctx.placement === "absolute" ? "absolute" : "inline";

  const baseStyles = {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    borderRadius: "999px",
    border: `1px solid ${style.outline}`,
    background: style.bg,
    color: style.color,
    font: "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    lineHeight: "1.3",
    cursor: "default",
  };

  if (placement === "absolute") {
    // Only promote host to positioned context if it is currently static —
    // we must not clobber Scryfall's own positioned layouts.
    try {
      const view = host.ownerDocument?.defaultView ?? globalThis;
      const computed = view?.getComputedStyle?.(host);
      if (computed && computed.position === "static") {
        host.style.position = "relative";
      }
    } catch { /* getComputedStyle unavailable in tests; ignore */ }

    Object.assign(badge.style, baseStyles, {
      position: "absolute",
      top: "6px",
      right: "6px",
      // Modest z-index — wins over the card image inside the tile, but
      // stays below page-wide Scryfall modals / image-zoom popovers.
      zIndex: "10",
      // Keep pointer-events: auto so the browser surfaces the native
      // `title` tooltip on hover. The small badge in the corner blocks
      // ~50px of click area on the card image link; the user can still
      // click the rest of the tile to navigate to the card detail page.
      pointerEvents: "auto",
      boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
    });
  } else {
    Object.assign(badge.style, baseStyles, {
      position: "static",
      marginLeft: "6px",
      verticalAlign: "middle",
      zIndex: "auto",
      pointerEvents: "auto",
    });
  }

  // textContent only — never assign innerHTML with data-driven strings.
  badge.textContent = style.label + (ctx.stale ? " (stale)" : "");
  badge.title = buildTooltip(evaluation, ctx);
  badge.setAttribute("aria-label", badge.title);

  return badge;
}

export function removeBadgesIn(root) {
  if (!root) return;
  for (const badge of root.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
  // Also remove any injected native-styled legality rows so the page is
  // returned to its pristine state when the extension is disabled.
  for (const row of root.querySelectorAll(`.${LEGALITY_ROW_CLASS}`)) row.remove();
}

/**
 * Render or update a "Dollar" entry inside Scryfall's native `dl.card-legality`
 * table. Idempotent: subsequent calls update the existing row in place.
 *
 * The caller MUST verify a Penny `<dt>` is present in `dl` before invoking;
 * we use it as the insertion anchor so the new row sits directly under
 * Penny. If absent (older/unfinished cards, localized markup) this function
 * returns null so the caller can fall back to a pill badge.
 *
 * @param dl          The `<dl class="card-legality">` element.
 * @param evaluation  legality.evaluate() output (see mountBadge docs).
 * @param ctx         Same shape as mountBadge ctx (thresholdUsd, stale).
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
  return STATE_STYLES[state]?.label ?? "Unknown";
}
