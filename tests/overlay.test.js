// Overlay rendering tests — DOM-based via a minimal jsdom-like polyfill.
//
// Node's `node --test` does not ship with a DOM by default, but the overlay
// module only uses common DOM APIs (createElement, querySelector, style,
// textContent, setAttribute). We can use a tiny synthetic DOM stub.

import test from "node:test";
import assert from "node:assert/strict";

import { removeOverlayIn, renderLegalityRow } from "../src/content/common/overlay.js";

function makeFakeElement(tagName = "div") {
  const el = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children: [],
    attributes: {},
    style: {},
    textContent: "",
    classList: new Set(),
    className: "",
    title: "",
    parentElement: null,
    ownerDocument: null,
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(newNode, refNode) {
      newNode.parentElement = this;
      if (refNode == null) {
        this.children.push(newNode);
        return newNode;
      }
      const idx = this.children.indexOf(refNode);
      if (idx < 0) {
        this.children.push(newNode);
      } else {
        this.children.splice(idx, 0, newNode);
      }
      return newNode;
    },
    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return this.parentElement.children[idx + 1] ?? null;
    },
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) { return this._findFirst(selector); },
    querySelectorAll(selector) {
      const out = [];
      this._findAll(selector, out);
      return out;
    },
    _matches(selector) {
      // Supports: .class, tag, [attr], [attr="val"]
      if (selector.startsWith(".")) {
        const name = selector.slice(1);
        return this.className === name
          || (typeof this.className === "string" && this.className.split(/\s+/).includes(name));
      }
      if (selector.startsWith("[")) {
        const m = selector.match(/^\[([^\]=]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/);
        if (!m) return false;
        const got = this.getAttribute(m[1]);
        if (got === null) return false;
        if (m[2] !== undefined && got !== m[2]) return false;
        return true;
      }
      // tag selector
      return this.tagName === selector.toUpperCase();
    },
    _findFirst(selector) {
      for (const c of this.children) {
        if (c._matches(selector)) return c;
        const inner = c._findFirst(selector);
        if (inner) return inner;
      }
      return null;
    },
    _findAll(selector, out) {
      for (const c of this.children) {
        if (c._matches(selector)) out.push(c);
        c._findAll(selector, out);
      }
    },
  };
  return el;
}

function withFakeDocument(fn) {
  const previousDocument = globalThis.document;
  const fakeDoc = {
    createElement: (tag) => {
      const el = makeFakeElement(tag);
      el.ownerDocument = fakeDoc;
      return el;
    },
  };
  globalThis.document = fakeDoc;
  try { fn(fakeDoc); } finally { globalThis.document = previousDocument; }
}

// ---------------------------------------------------------------------------
// renderLegalityRow — native-styled row injection on detail pages
// ---------------------------------------------------------------------------

function makeLegalityDl(doc, { includePenny = true } = {}) {
  const dl = doc.createElement("dl");
  dl.className = "card-legality";

  const addRow = (formats) => {
    const row = doc.createElement("div");
    row.className = "card-legality-row";
    for (const [name, status, statusClass] of formats) {
      const item = doc.createElement("div");
      item.className = "card-legality-item";
      const dt = doc.createElement("dt");
      dt.textContent = name;
      const dd = doc.createElement("dd");
      dd.className = statusClass;
      dd.textContent = status;
      item.appendChild(dt);
      item.appendChild(dd);
      row.appendChild(item);
    }
    dl.appendChild(row);
    return row;
  };

  addRow([["Standard", "Not Legal", "not-legal"], ["Modern", "Legal", "legal"]]);
  if (includePenny) {
    addRow([["Commander", "Banned", "banned"], ["Penny", "Not Legal", "not-legal"]]);
  }
  addRow([["Oathbreaker", "Banned", "banned"]]);
  return dl;
}

test("renderLegalityRow injects a Dollar row right after the Penny row", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc);
    const pennyRow = dl.children[1];     // second .card-legality-row
    const beforeCount = dl.children.length;

    const dd = renderLegalityRow(dl, { state: "legal_recent" }, { thresholdUsd: 1 });

    assert.ok(dd, "should return the dd element");
    assert.equal(dl.children.length, beforeCount + 1);
    // New row should be immediately after the Penny row.
    const pennyIdx = dl.children.indexOf(pennyRow);
    const ourRow = dl.children[pennyIdx + 1];
    assert.ok(ourRow.className.includes("dollar-commander-legality-row"));
    assert.equal(ourRow.getAttribute("data-dc-format-row"), "1");
    // The $ Commander row's dt label.
    const dt = ourRow.children[0].children[0];
    assert.equal(dt.textContent, "$ Commander");
  });
});

test("renderLegalityRow maps states to native classes/labels", () => {
  withFakeDocument((doc) => {
    const cases = [
      { state: "legal_recent",      expectClass: "legal",     expectText: "Legal" },
      { state: "legal_aging",       expectClass: "legal",     expectText: "Legal" },
      { state: "warning",           expectClass: "legal",     expectText: "Legal ⚠️" },
      { state: "scheduled_illegal", expectClass: "legal",     expectText: "Legal ⚠️" },
      { state: "illegal",           expectClass: "not-legal", expectText: "Not Legal" },
      { state: "unknown",           expectClass: "not-legal", expectText: "Unknown" },
      { state: "loading",           expectClass: "not-legal", expectText: "Downloading…" },
    ];
    for (const { state, expectClass, expectText } of cases) {
      const dl = makeLegalityDl(doc);
      const dd = renderLegalityRow(dl, { state }, { thresholdUsd: 1 });
      assert.equal(dd.className, expectClass, `${state} -> class`);
      assert.equal(dd.textContent, expectText, `${state} -> text`);
    }
  });
});

test("renderLegalityRow is idempotent — updates the existing row in place", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc);
    renderLegalityRow(dl, { state: "legal_recent" }, { thresholdUsd: 1 });
    const afterFirst = dl.children.length;
    renderLegalityRow(dl, { state: "illegal" }, { thresholdUsd: 1 });
    assert.equal(dl.children.length, afterFirst, "must not add a second row");

    const ourRow = dl.querySelectorAll("[data-dc-format-row=\"1\"]")[0];
    const dd = ourRow.querySelector("dd");
    assert.equal(dd.className, "not-legal");
    assert.equal(dd.textContent, "Not Legal");
  });
});

test("renderLegalityRow returns null when no Penny anchor is present", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc, { includePenny: false });
    const beforeCount = dl.children.length;
    const result = renderLegalityRow(dl, { state: "legal_recent" }, { thresholdUsd: 1 });
    assert.equal(result, null);
    assert.equal(dl.children.length, beforeCount, "must not insert anything");
  });
});

test("renderLegalityRow carries the rich tooltip on the dd", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc);
    const dd = renderLegalityRow(
      dl,
      {
        state: "legal_recent",
        record: { today: 0.5, min_549: 0.3 },
        lastUnder: "2026-05-20",
      },
      { thresholdUsd: 1 },
    );
    assert.match(dd.title, /Threshold: \$1\.00/);
    assert.match(dd.title, /Today: \$0\.50/);
    assert.match(dd.title, /Lowest in lookback: \$0\.30/);
    assert.match(dd.title, /Last at-or-below threshold: 2026-05-20/);
    assert.equal(dd.getAttribute("aria-label"), dd.title);
  });
});

test("renderLegalityRow surfaces the stale marker on the dd text", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc);
    const dd = renderLegalityRow(dl, { state: "legal_recent" }, { thresholdUsd: 1, stale: true });
    assert.ok(dd.textContent.endsWith("*"), "stale marker should be a trailing *");
    assert.match(dd.title, /stale/);
  });
});

test("removeOverlayIn clears injected legality rows", () => {
  withFakeDocument((doc) => {
    const dl = makeLegalityDl(doc);
    renderLegalityRow(dl, { state: "legal_recent" }, { thresholdUsd: 1 });
    assert.ok(dl.querySelector("[data-dc-format-row=\"1\"]"), "row present before cleanup");
    removeOverlayIn(dl);
    assert.equal(dl.querySelector("[data-dc-format-row=\"1\"]"), null);
  });
});
