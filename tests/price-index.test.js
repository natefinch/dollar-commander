import test from "node:test";
import assert from "node:assert/strict";

import { sha256Hex, validateManifest } from "../src/lib/price-index.js";

test("validateManifest accepts a well-formed manifest", () => {
  const manifest = {
    schema_version: { major: 1, minor: 0 },
    assets: {
      price_index: { filename: "price-index-2026-05-24.json", sha256: "a".repeat(64), size: 5000 },
      card_index:  { filename: "card-index-2026-05-24.json",  sha256: "b".repeat(64), size: 2000 },
    },
  };
  assert.equal(validateManifest(manifest), true);
});

test("validateManifest tolerates a higher minor version", () => {
  const manifest = {
    schema_version: { major: 1, minor: 99 },
    assets: {
      price_index: { filename: "p.json", sha256: "a", size: 1 },
      card_index:  { filename: "c.json", sha256: "b", size: 2 },
    },
  };
  assert.equal(validateManifest(manifest), true);
});

test("validateManifest rejects a higher major version", () => {
  const manifest = {
    schema_version: { major: 2, minor: 0 },
    assets: {
      price_index: { filename: "p.json", sha256: "a", size: 1 },
      card_index:  { filename: "c.json", sha256: "b", size: 2 },
    },
  };
  assert.throws(() => validateManifest(manifest), /Unsupported schema_version major/);
});

test("validateManifest rejects missing schema_version", () => {
  assert.throws(() => validateManifest({ assets: {} }), /schema_version/);
});

test("validateManifest rejects incomplete asset descriptors", () => {
  assert.throws(
    () => validateManifest({
      schema_version: { major: 1, minor: 0 },
      assets: { price_index: { filename: "x", sha256: "y" } },
    }),
    /assets\.price_index/,
  );
});

test("validateManifest rejects oversize asset descriptors", () => {
  assert.throws(
    () => validateManifest({
      schema_version: { major: 1, minor: 0 },
      assets: {
        price_index: { filename: "x", sha256: "y", size: 100 * 1024 * 1024 },
        card_index:  { filename: "c", sha256: "d", size: 1 },
      },
    }),
    /exceeds size guard/,
  );
});

test("sha256Hex matches the well-known hash for an empty buffer", async () => {
  const empty = new Uint8Array(0).buffer;
  const hash = await sha256Hex(empty);
  assert.equal(
    hash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("sha256Hex matches the well-known hash for 'abc'", async () => {
  const buf = new TextEncoder().encode("abc").buffer;
  const hash = await sha256Hex(buf);
  assert.equal(
    hash,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
