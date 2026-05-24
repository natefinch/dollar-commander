// Tests for Scryfall card-id extraction. We build minimal DOM stubs that
// support the subset of querySelector / querySelectorAll / getAttribute
// behavior used by collectCardCandidates.

import test from "node:test";
import assert from "node:assert/strict";

import { collectCardCandidates, findScryfallIdNear } from "../src/content/scryfall.js";

function makeEl({ tag = "div", attrs = {}, name = "", children = [], parent = null } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    _name: name,
    _attrs: { ...attrs },
    children: [],
    parentElement: parent,
    classList: { contains: () => false },
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
  // Tiny selector engine supporting:
  //  - tag name
  //  - "[attr]"
  //  - "[attr='value']"  /  '[attr="value"]'
  //  - "meta[name='x']"
  //  - "a[data-card-id]"
  //  - "a[data-scryfall-id], a[data-card-id]" (comma-split)
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  return (node) => parts.some((p) => oneMatch(p, node));
}

function oneMatch(selector, node) {
  const m = selector.match(/^([a-zA-Z*]+)?(\[[^\]]+\])*$/);
  if (!m) return false;

  let tag = null;
  const attrs = [];
  const re = /([a-zA-Z][a-zA-Z*]*)|\[([^=\]]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g;
  let mm;
  while ((mm = re.exec(selector)) !== null) {
    if (mm[1] && tag === null) tag = mm[1].toUpperCase();
    else if (mm[2]) attrs.push([mm[2], mm[3] ?? null]);
  }

  if (tag && tag !== "*" && node.tagName !== tag) return false;
  for (const [name, value] of attrs) {
    const got = node.getAttribute(name);
    if (got === null) return false;
    if (value !== null && got !== value) return false;
  }
  return true;
}

const OID = "a7e97fa9-4b72-4548-b854-5be5f18a6f1a";
const SID = "658c5caa-d739-4d30-a512-43ac4de900cb";

test("detail page: extracts oracle_id + card_id from meta tags", () => {
  const cardName = makeEl({
    tag: "span", attrs: { class: "card-text-card-name" }, name: "card-text-card-name",
  });
  cardName.className = "card-text-card-name";
  // Custom _matches for the class selector used by collectCardCandidates.
  cardName.tagName = "SPAN";
  cardName._attrs.class = "card-text-card-name";

  const doc = makeEl({
    children: [
      makeEl({ tag: "meta", attrs: { name: "scryfall:oracle:id", content: OID } }),
      makeEl({ tag: "meta", attrs: { name: "scryfall:card:id", content: SID } }),
      cardName,
    ],
  });

  // The selector ".card-text-card-name" requires a tiny extension to the
  // matcher; bypass by injecting an attribute matcher equivalent.
  doc.querySelector = (sel) => {
    if (sel === ".card-text-card-name") return cardName;
    if (sel === "h1") return null;
    if (sel === "meta[name='scryfall:oracle:id']") {
      return doc._find("meta[name='scryfall:oracle:id']", true)[0] ?? null;
    }
    if (sel === "meta[name='scryfall:card:id']") {
      return doc._find("meta[name='scryfall:card:id']", true)[0] ?? null;
    }
    return null;
  };
  doc.querySelectorAll = (sel) => {
    if (sel === "[data-card-id]") return [];
    if (sel === "a[data-scryfall-id], a[data-card-id]") return [];
    return [];
  };

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, cardName);
  assert.equal(info.oracleId, OID);
  assert.equal(info.scryfallId, SID);
});

test("search grid: extracts scryfallId from data-card-id wrappers", () => {
  const anchor1 = makeEl({ tag: "a", attrs: { href: "/card/x" } });
  const anchor2 = makeEl({ tag: "a", attrs: { href: "/card/y" } });
  const wrap1 = makeEl({
    tag: "div",
    attrs: { "data-card-id": SID, class: "card-grid-item" },
    children: [anchor1],
  });
  const wrap2 = makeEl({
    tag: "div",
    attrs: { "data-card-id": "not-a-uuid", class: "card-grid-item" },
    children: [anchor2],
  });

  const doc = makeEl({ children: [wrap1, wrap2] });
  // Wire up our minimal selectors.
  doc.querySelector = (sel) => {
    if (sel === ".card-text-card-name" || sel === "h1") return null;
    if (sel === "meta[name='scryfall:oracle:id']") return null;
    if (sel === "meta[name='scryfall:card:id']") return null;
    return null;
  };
  doc.querySelectorAll = (sel) => {
    if (sel === "[data-card-id]") return [wrap1, wrap2];
    if (sel === "a[data-scryfall-id], a[data-card-id]") return [];
    return [];
  };
  wrap1.querySelector = (sel) => (sel === "a" ? anchor1 : null);
  wrap2.querySelector = (sel) => (sel === "a" ? anchor2 : null);

  const candidates = collectCardCandidates(doc);
  assert.equal(candidates.size, 1);
  const [[host, info]] = [...candidates.entries()];
  assert.equal(host, anchor1);
  assert.equal(info.scryfallId, SID);
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
