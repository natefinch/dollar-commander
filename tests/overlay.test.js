// Overlay rendering tests — DOM-based via a minimal jsdom-like polyfill.
//
// Node's `node --test` does not ship with a DOM by default, but the overlay
// module only uses common DOM APIs (createElement, querySelector, style,
// textContent, setAttribute). We can use a tiny synthetic DOM stub.

import test from "node:test";
import assert from "node:assert/strict";

import { mountBadge, removeBadgesIn } from "../src/content/common/overlay.js";

function makeFakeElement(tagName = "div") {
  const el = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    textContent: "",
    classList: new Set(),
    className: "",
    title: "",
    parentElement: null,
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector(selector) {
      const found = this._findFirst(selector);
      return found;
    },
    querySelectorAll(selector) {
      const out = [];
      this._findAll(selector, out);
      return out;
    },
    _matches(selector) {
      if (selector.startsWith(".")) {
        return this.className === selector.slice(1)
          || this.className.split(" ").includes(selector.slice(1));
      }
      return false;
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

// Inject the minimal `document.createElement` shim used by overlay.js.
function withFakeDocument(fn) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag) => makeFakeElement(tag),
  };
  try { fn(); } finally { globalThis.document = previousDocument; }
}

test("mountBadge attaches a single badge with the right label", () => {
  withFakeDocument(() => {
    const host = makeFakeElement("a");
    mountBadge(host, { state: "legal_recent", record: { today: 0.50, min_549: 0.50 } },
                 { thresholdUsd: 1 });
    assert.equal(host.children.length, 1);
    const badge = host.children[0];
    assert.equal(badge.tagName, "SPAN");
    assert.equal(badge.className, "dollar-commander-badge");
    assert.ok(badge.textContent.includes("Legal"));
    assert.match(badge.title, /Today: \$0\.50/);
    assert.match(badge.title, /Threshold: \$1\.00/);
  });
});

test("mountBadge updates an existing badge in-place rather than stacking", () => {
  withFakeDocument(() => {
    const host = makeFakeElement("a");
    mountBadge(host, { state: "legal_recent" }, { thresholdUsd: 1 });
    mountBadge(host, { state: "illegal" }, { thresholdUsd: 1 });
    assert.equal(host.children.length, 1);
    assert.ok(host.children[0].textContent.includes("Illegal"));
  });
});

test("mountBadge surfaces stale flag in the label and tooltip", () => {
  withFakeDocument(() => {
    const host = makeFakeElement("a");
    mountBadge(host, { state: "legal_recent" }, { thresholdUsd: 1, stale: true });
    const badge = host.children[0];
    assert.ok(badge.textContent.includes("(stale)"));
    assert.match(badge.title, /stale/);
  });
});

test("mountBadge does not interpret data as HTML", () => {
  withFakeDocument(() => {
    const host = makeFakeElement("a");
    // Hostile-looking values; the badge should treat them as plain text.
    mountBadge(
      host,
      { state: "illegal", record: { today: 0.5, min_549: 0.5 }, lastUnder: "<script>x</script>" },
      { thresholdUsd: 1 },
    );
    const badge = host.children[0];
    assert.equal(badge.textContent.includes("<script>"), false);
    assert.ok(badge.title.includes("<script>"));
    // The title is rendered by the browser as plain text; we just ensure
    // it's not assigned via innerHTML (the overlay module never does that).
  });
});

test("removeBadgesIn clears badges anywhere under root", () => {
  withFakeDocument(() => {
    const root = makeFakeElement("section");
    const a = makeFakeElement("a");
    const b = makeFakeElement("a");
    root.appendChild(a);
    root.appendChild(b);
    mountBadge(a, { state: "legal_recent" });
    mountBadge(b, { state: "illegal" });
    assert.equal(a.children.length, 1);
    assert.equal(b.children.length, 1);
    removeBadgesIn(root);
    assert.equal(a.children.length, 0);
    assert.equal(b.children.length, 0);
  });
});
