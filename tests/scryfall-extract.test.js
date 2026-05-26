// Tests for Scryfall card-id extraction. We build minimal DOM stubs that
// support the subset of querySelector / querySelectorAll / getAttribute
// behavior used by collectCardCandidates.

import test from "node:test";
import assert from "node:assert/strict";

import { collectCardCandidates } from "../src/content/scryfall.js";

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
