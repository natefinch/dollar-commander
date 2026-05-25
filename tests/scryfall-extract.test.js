// Tests for Scryfall card-id extraction. We build minimal DOM stubs that
// support the subset of querySelector / querySelectorAll / getAttribute
// behavior used by collectCardCandidates.

import test from "node:test";
import assert from "node:assert/strict";

import { collectCardCandidates, findScryfallIdNear } from "../src/content/scryfall.js";

function makeEl({ tag = "div", attrs = {}, children = [], parent = null } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    _attrs: { ...attrs },
    children: [],
    parentElement: parent,
    classList: {
      contains(name) {
        const cls = el._attrs.class ?? "";
        return cls.split(/\s+/).includes(name);
      },
    },
    getAttribute(n) { return this._attrs[n] ?? null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    querySelector(sel) { return this._find(sel, true)[0] ?? null; },
    querySelectorAll(sel) { return this._find(sel, false); },
    _find(sel, firstOnly) {
      const out = [];
      const matcher = makeMatcher(sel);
      const visit = (node) => {
        if (matcher(node)) {
          out.push(node);
          if (firstOnly) return true;
        }
        for (const c of node.children) {
          if (visit(c)) return true;
        }
        return false;
      };
      for (const c of this.children) {
        if (visit(c)) break;
      }
      return out;
    },
  };
  for (const c of children) {
    c.parentElement = el;
    el.children.push(c);
  }
  return el;
}

function makeMatcher(selector) {
  // Supports comma-separated selectors of the form:
  //   tag, .class, [attr], [attr='val'], tag.class, tag[attr],
  //   .class[attr], tag.class[attr], descendant combinators (space).
  const groups = selector.split(",").map((s) => s.trim()).filter(Boolean);
  return (node) => groups.some((g) => matchCompound(g, node));
}

// Match a possibly-descendant selector like "table.checklist tr[data-card-id]".
// We split on whitespace; each segment must match an ancestor in order.
function matchCompound(selector, node) {
  const segments = selector.split(/\s+/).filter(Boolean);
  // Match rightmost segment against the node itself.
  if (!matchSimple(segments[segments.length - 1], node)) return false;
  // For ancestor segments, walk up parentElement chain.
  let cursor = node.parentElement;
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i];
    while (cursor) {
      if (matchSimple(seg, cursor)) {
        cursor = cursor.parentElement;
        break;
      }
      cursor = cursor.parentElement;
    }
    if (!cursor && i >= 0 && !matchSimple(seg, node)) {
      // Failed to find an ancestor matching this segment.
      // (Re-check: if we exhausted parents, no match.)
      return false;
    }
  }
  return true;
}

function matchSimple(selector, node) {
  // Parse: tag? (.class)* ([attr] | [attr='val'])*
  let tag = null;
  const classes = [];
  const attrs = [];

  // Strip and capture pieces in order.
  let s = selector;
  // tag prefix (letters / *)
  const tagMatch = s.match(/^([a-zA-Z][a-zA-Z0-9]*|\*)/);
  if (tagMatch) {
    tag = tagMatch[1] === "*" ? null : tagMatch[1].toUpperCase();
    s = s.slice(tagMatch[0].length);
  }
  while (s.length > 0) {
    if (s.startsWith(".")) {
      const m = s.match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)/);
      if (!m) return false;
      classes.push(m[1]);
      s = s.slice(m[0].length);
    } else if (s.startsWith("[")) {
      const m = s.match(/^\[([^\]=]+)(?:=['"]?([^'"\]]*)['"]?)?\]/);
      if (!m) return false;
      attrs.push([m[1], m[2] ?? null]);
      s = s.slice(m[0].length);
    } else {
      return false;
    }
  }

  if (tag && node.tagName !== tag) return false;
  for (const cls of classes) {
    if (!node.classList?.contains?.(cls)) return false;
  }
  for (const [name, value] of attrs) {
    const got = node.getAttribute?.(name);
    if (got === null || got === undefined) return false;
    if (value !== null && got !== value) return false;
  }
  return true;
}

const OID = "a7e97fa9-4b72-4548-b854-5be5f18a6f1a";
const SID = "658c5caa-d739-4d30-a512-43ac4de900cb";
const SID2 = "9976eb70-0d39-4882-8041-a4d29527c292";

test("detail page: extracts oracle_id + card_id from meta tags into a legality-row candidate", () => {
  const pennyDt = makeEl({ tag: "dt" });
  pennyDt.textContent = "Penny";
  const dl = makeEl({
    tag: "dl", attrs: { class: "card-legality" },
    children: [
      makeEl({
        tag: "div", attrs: { class: "card-legality-row" },
        children: [
          makeEl({
            tag: "div", attrs: { class: "card-legality-item" },
            children: [pennyDt],
          }),
        ],
      }),
    ],
  });
  const doc = makeEl({
    children: [
      makeEl({ tag: "meta", attrs: { name: "scryfall:oracle:id", content: OID } }),
      makeEl({ tag: "meta", attrs: { name: "scryfall:card:id", content: SID } }),
      dl,
    ],
  });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, dl);
  assert.equal(info.oracleId, OID);
  assert.equal(info.scryfallId, SID);
  assert.equal(info.placement, "legality-row");
});

test("detail page: prefers dl.card-legality + Penny row over pill badge", () => {
  const cardName = makeEl({
    tag: "span", attrs: { class: "card-text-card-name" },
  });
  const pennyDt = makeEl({ tag: "dt" });
  pennyDt.textContent = "Penny";
  const pennyItem = makeEl({
    tag: "div", attrs: { class: "card-legality-item" },
    children: [pennyDt],
  });
  const pennyRow = makeEl({
    tag: "div", attrs: { class: "card-legality-row" },
    children: [pennyItem],
  });
  const dl = makeEl({
    tag: "dl", attrs: { class: "card-legality" },
    children: [pennyRow],
  });
  const doc = makeEl({
    children: [
      makeEl({ tag: "meta", attrs: { name: "scryfall:oracle:id", content: OID } }),
      makeEl({ tag: "meta", attrs: { name: "scryfall:card:id", content: SID } }),
      cardName,
      dl,
    ],
  });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, dl, "host must be the dl.card-legality, not the title span");
  assert.equal(info.oracleId, OID);
  assert.equal(info.scryfallId, SID);
  assert.equal(info.placement, "legality-row");
});

test("detail page emits no candidate when dl.card-legality has no Penny anchor", () => {
  const cardName = makeEl({
    tag: "span", attrs: { class: "card-text-card-name" },
  });
  // dl.card-legality exists but contains only other formats (no Penny).
  const standardDt = makeEl({ tag: "dt" });
  standardDt.textContent = "Standard";
  const dl = makeEl({
    tag: "dl", attrs: { class: "card-legality" },
    children: [
      makeEl({
        tag: "div", attrs: { class: "card-legality-row" },
        children: [
          makeEl({
            tag: "div", attrs: { class: "card-legality-item" },
            children: [standardDt],
          }),
        ],
      }),
    ],
  });
  const doc = makeEl({
    children: [
      makeEl({ tag: "meta", attrs: { name: "scryfall:oracle:id", content: OID } }),
      cardName,
      dl,
    ],
  });

  const candidates = collectCardCandidates(doc);
  // No Penny anchor → render nothing on the detail page (user preference:
  // don't put words next to the card title).
  assert.equal(candidates.size, 0);
});

test("grid view: extracts scryfallId from .card-grid-item[data-card-id], mounts on the grid item itself", () => {
  const item1 = makeEl({
    tag: "div", attrs: { "data-card-id": SID, class: "card-grid-item" },
    children: [makeEl({ tag: "a", attrs: { class: "card-grid-item-card", href: "/card/x" } })],
  });
  const item2 = makeEl({
    tag: "div", attrs: { "data-card-id": "not-a-uuid", class: "card-grid-item" },
    children: [makeEl({ tag: "a", attrs: { href: "/card/y" } })],
  });
  const doc = makeEl({ children: [item1, item2] });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, item1, "host must be the .card-grid-item wrapper, not the inner anchor");
  assert.equal(info.scryfallId, SID);
  assert.equal(info.placement, "absolute");
});

test("grid view ignores non-grid [data-card-id] elements (buttons, lang flags, tooltips)", () => {
  // Simulate a card detail page where Scryfall sprinkles data-card-id all
  // over the DOM. None of these should produce candidates beyond the
  // single dl.card-legality host emitted by Strategy A.
  const cardName = makeEl({ tag: "span", attrs: { class: "card-text-card-name" } });
  const pennyDt = makeEl({ tag: "dt" });
  pennyDt.textContent = "Penny";
  const dl = makeEl({
    tag: "dl", attrs: { class: "card-legality" },
    children: [
      makeEl({
        tag: "div", attrs: { class: "card-legality-row" },
        children: [
          makeEl({
            tag: "div", attrs: { class: "card-legality-item" },
            children: [pennyDt],
          }),
        ],
      }),
    ],
  });
  const doc = makeEl({
    children: [
      makeEl({ tag: "meta", attrs: { name: "scryfall:oracle:id", content: OID } }),
      makeEl({ tag: "meta", attrs: { name: "scryfall:card:id", content: SID } }),
      makeEl({ tag: "button", attrs: {
        class: "button-n vh deckbuilder-card-add-button",
        "data-card-id": SID,
      }}),
      makeEl({ tag: "a", attrs: {
        class: "print-langs-item current",
        "data-card-id": SID2,
      }}),
      makeEl({ tag: "a", attrs: {
        "data-component": "card-tooltip",
        "data-card-id": SID2,
      }}),
      cardName,
      dl,
    ],
  });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1, "only the dl.card-legality host should be selected");
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, dl);
  assert.equal(info.placement, "legality-row");
});

test("full view: scopes per .card-profile and mounts on its .card-text-card-name", () => {
  const profile1Name = makeEl({ tag: "span", attrs: { class: "card-text-card-name" } });
  const profile1 = makeEl({
    tag: "div", attrs: { class: "card-profile" },
    children: [
      makeEl({ tag: "button", attrs: {
        class: "button-n vh deckbuilder-card-add-button",
        "data-card-id": SID,
      }}),
      profile1Name,
      // Decoy: print-langs sibling with a different data-card-id must not
      // become a candidate.
      makeEl({ tag: "a", attrs: {
        class: "print-langs-item",
        "data-card-id": SID2,
      }}),
    ],
  });
  const profile2Name = makeEl({ tag: "span", attrs: { class: "card-text-card-name" } });
  const profile2 = makeEl({
    tag: "div", attrs: { class: "card-profile" },
    children: [
      makeEl({ tag: "button", attrs: {
        class: "button-n vh deckbuilder-card-add-button",
        "data-card-id": SID2,
      }}),
      profile2Name,
    ],
  });
  const doc = makeEl({ children: [profile1, profile2] });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 2);
  const entries = [...candidates.entries()];
  assert.equal(entries[0][0], profile1Name);
  assert.equal(entries[0][1].scryfallId, SID);
  assert.equal(entries[0][1].placement, "inline");
  assert.equal(entries[1][0], profile2Name);
  assert.equal(entries[1][1].scryfallId, SID2);
});

test("checklist view: mounts on the USD-price cell (non-ellipsis), not the clipped name anchor", () => {
  const nameAnchor = makeEl({ tag: "a", attrs: { href: "/card/x" } });
  const nameCell = makeEl({
    tag: "td", attrs: { class: "ellipsis" }, children: [nameAnchor],
  });
  const usdAnchor = makeEl({
    tag: "a", attrs: { class: "currency-usd", title: "Nonfoil: $12.72" },
  });
  const usdCell = makeEl({
    tag: "td", attrs: { class: "right" }, children: [usdAnchor],
  });
  const row = makeEl({
    tag: "tr", attrs: {
      "data-component": "card-tooltip",
      "data-card-id": SID,
    },
    children: [
      makeEl({ tag: "td", children: [makeEl({ tag: "a", attrs: { href: "/card/x" } })] }),
      nameCell,
      usdCell,
    ],
  });
  const tbody = makeEl({ tag: "tbody", children: [row] });
  const table = makeEl({
    tag: "table", attrs: { class: "checklist" }, children: [tbody],
  });
  const doc = makeEl({ children: [table] });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, usdCell, "host must be the USD-price <td>, not the ellipsis-clipped name anchor");
  assert.equal(info.scryfallId, SID);
  assert.equal(info.placement, "inline");
});

test("checklist view falls back to name anchor when USD cell missing", () => {
  const nameAnchor = makeEl({ tag: "a", attrs: { href: "/card/x" } });
  const nameCell = makeEl({
    tag: "td", attrs: { class: "ellipsis" }, children: [nameAnchor],
  });
  const row = makeEl({
    tag: "tr", attrs: {
      "data-component": "card-tooltip",
      "data-card-id": SID,
    },
    children: [nameCell],
  });
  const tbody = makeEl({ tag: "tbody", children: [row] });
  const table = makeEl({
    tag: "table", attrs: { class: "checklist" }, children: [tbody],
  });
  const doc = makeEl({ children: [table] });

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host]] = [...candidates.entries()];
  assert.equal(host, nameAnchor);
});

test("findScryfallIdNear walks ancestors looking for a UUID attribute", () => {
  const inner = makeEl({ tag: "span" });
  const mid = makeEl({ tag: "div", children: [inner] });
  const top = makeEl({
    tag: "section", attrs: { "data-card-id": SID }, children: [mid],
  });
  inner.parentElement = mid;
  mid.parentElement = top;
  assert.equal(findScryfallIdNear(inner), SID);
});

test("findScryfallIdNear rejects non-UUID attribute values", () => {
  const inner = makeEl({ tag: "span" });
  const top = makeEl({
    tag: "section", attrs: { "data-card-id": "not-a-uuid" }, children: [inner],
  });
  inner.parentElement = top;
  assert.equal(findScryfallIdNear(inner), null);
});
