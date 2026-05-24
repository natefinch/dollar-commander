// Mocked-fetch tests for price-index's manifest+asset retrieval, single-flight
// dedupe, hash/size verification, and chrome.storage.local persistence.

import test from "node:test";
import assert from "node:assert/strict";

import {
  _internal,
  getIndex,
  invalidateCache,
  lookupByOracle,
  lookupByScryfallId,
  sha256Hex,
} from "../src/lib/price-index.js";

function chromeStorageStub() {
  const store = new Map();
  return {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") {
            const value = store.get(key);
            return value === undefined ? {} : { [key]: value };
          }
          throw new Error("test stub only supports string key");
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async clear() { store.clear(); },
      },
    },
    _peek: store,
  };
}

function makeManifestAndAssets(priceIndex, cardIndex) {
  const priceBytes = new TextEncoder().encode(JSON.stringify(priceIndex)).buffer;
  const cardBytes  = new TextEncoder().encode(JSON.stringify(cardIndex)).buffer;
  return { priceBytes, cardBytes };
}

async function makeFetchResponses({ priceIndex, cardIndex }) {
  const { priceBytes, cardBytes } = makeManifestAndAssets(priceIndex, cardIndex);
  const priceHash = await sha256Hex(priceBytes);
  const cardHash  = await sha256Hex(cardBytes);
  const manifest = {
    schema_version: { major: 1, minor: 0 },
    as_of_date: "2026-05-24",
    assets: {
      price_index: { filename: "price-index-2026-05-24.json", sha256: priceHash, size: priceBytes.byteLength },
      card_index:  { filename: "card-index-2026-05-24.json",  sha256: cardHash,  size: cardBytes.byteLength },
    },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).buffer;
  return { manifest, manifestBytes, priceBytes, cardBytes };
}

function makeFetch(routes) {
  return async (url) => {
    if (!(url in routes)) throw new Error(`unmocked fetch: ${url}`);
    const entry = routes[url];
    if (entry instanceof Error) throw entry;
    return {
      ok: entry.ok !== false,
      status: entry.status ?? 200,
      arrayBuffer: async () => entry.body,
    };
  };
}

function resetEnv() {
  _internal.reset();
  globalThis.chrome = chromeStorageStub();
}

test("getIndex fetches manifest + assets and serves lookups", async () => {
  resetEnv();
  const priceIndex = { cards: { "oracle-A": { today: 0.50, floor: [[0.50, "2026-05-24"]] } } };
  const cardIndex  = { scryfall_id_to_oracle: { "sid-1": "oracle-A" }, oracle_names: { "oracle-A": "Card A" } };
  const { manifestBytes, priceBytes, cardBytes } = await makeFetchResponses({ priceIndex, cardIndex });

  globalThis.fetch = makeFetch({
    [_internal.MANIFEST_URL]:               { body: manifestBytes },
    [_internal.ASSET_BASE + "price-index-2026-05-24.json"]: { body: priceBytes },
    [_internal.ASSET_BASE + "card-index-2026-05-24.json"]:  { body: cardBytes },
  });

  const idx = await getIndex({ force: true });
  assert.equal(idx.manifest.as_of_date, "2026-05-24");
  assert.deepEqual(await lookupByOracle("oracle-A"), priceIndex.cards["oracle-A"]);
  assert.deepEqual(await lookupByScryfallId("sid-1"), {
    oracleId: "oracle-A", record: priceIndex.cards["oracle-A"],
  });
  assert.equal(await lookupByScryfallId("not-there"), null);
});

test("getIndex single-flight dedupes concurrent callers", async () => {
  resetEnv();
  const priceIndex = { cards: {} };
  const cardIndex  = { scryfall_id_to_oracle: {}, oracle_names: {} };
  const { manifestBytes, priceBytes, cardBytes } = await makeFetchResponses({ priceIndex, cardIndex });

  let manifestFetches = 0, priceFetches = 0, cardFetches = 0;
  globalThis.fetch = async (url) => {
    if (url === _internal.MANIFEST_URL) {
      manifestFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => manifestBytes };
    }
    if (url.endsWith("/price-index-2026-05-24.json")) {
      priceFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => priceBytes };
    }
    if (url.endsWith("/card-index-2026-05-24.json")) {
      cardFetches += 1;
      return { ok: true, status: 200, arrayBuffer: async () => cardBytes };
    }
    throw new Error(`unmocked: ${url}`);
  };

  invalidateCache();
  await Promise.all([
    getIndex(),
    getIndex(),
    getIndex(),
    getIndex(),
    getIndex(),
  ]);

  // Despite five concurrent callers, exactly one fetch sequence ran.
  assert.equal(manifestFetches, 1);
  assert.equal(priceFetches, 1);
  assert.equal(cardFetches, 1);
});

test("getIndex rejects asset whose hash doesn't match the manifest", async () => {
  resetEnv();
  const priceIndex = { cards: {} };
  const cardIndex  = { scryfall_id_to_oracle: {}, oracle_names: {} };
  const { manifest, manifestBytes, priceBytes, cardBytes } =
    await makeFetchResponses({ priceIndex, cardIndex });

  // Corrupt the price-index bytes: served body differs from manifest hash.
  const tamperedBody = new TextEncoder().encode(JSON.stringify({ cards: { evil: 1 } })).buffer;

  globalThis.fetch = makeFetch({
    [_internal.MANIFEST_URL]: { body: manifestBytes },
    [_internal.ASSET_BASE + manifest.assets.price_index.filename]: { body: tamperedBody },
    [_internal.ASSET_BASE + manifest.assets.card_index.filename]:  { body: cardBytes },
  });

  invalidateCache();
  await assert.rejects(
    async () => { await getIndex({ force: true }); },
    /size mismatch|hash mismatch/,
  );
});

test("getIndex on fetch error returns last-good from chrome.storage.local", async () => {
  resetEnv();
  // Pre-populate storage as if a previous run succeeded.
  await chrome.storage.local.set({
    [_internal.STORAGE_KEY]: {
      manifest: {
        schema_version: { major: 1, minor: 0 },
        as_of_date: "2026-05-20",
        assets: {
          price_index: { filename: "p.json", sha256: "a".repeat(64), size: 1 },
          card_index:  { filename: "c.json", sha256: "b".repeat(64), size: 1 },
        },
      },
      priceIndex: { cards: { "oracle-Z": { today: 0.10, floor: [[0.10, "2026-05-20"]] } } },
      cardIndex:  { scryfall_id_to_oracle: { "sid-Z": "oracle-Z" }, oracle_names: {} },
      persistedAt: Date.now(),
    },
  });
  globalThis.fetch = async () => { throw new Error("network down"); };

  const idx = await getIndex({ force: true });
  assert.equal(idx.manifest.as_of_date, "2026-05-20");
  assert.deepEqual(await lookupByOracle("oracle-Z"), { today: 0.10, floor: [[0.10, "2026-05-20"]] });
});

test("getIndex propagates error when neither in-memory nor storage cache exists", async () => {
  resetEnv();
  globalThis.fetch = async () => { throw new Error("offline and empty"); };

  await assert.rejects(async () => { await getIndex({ force: true }); }, /offline and empty/);
});
