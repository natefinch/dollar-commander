# Dollar Commander data format

This document describes the JSON shape of the data files published by the
daily pipeline and consumed by the browser extension. All files are served
from a single GitHub Release tagged `data-latest` at
`https://github.com/natefinch/dollar-commander/releases/download/data-latest/`.

## Asset ordering and atomicity

Clients first fetch `manifest.json`, then resolve the linked dated assets by
the filenames it provides. The daily workflow uploads all dated assets
first, then overwrites `manifest.json` last, so a manifest fetched mid-run
never refers to assets that haven't yet been uploaded.

## Schema versioning

Every published JSON document carries a `schema_version` block of the form

```json
"schema_version": { "major": 1, "minor": 0 }
```

Producers may add fields without bumping `major`. Consumers should:

* reject `major != known_major` (no forward compatibility)
* tolerate `minor > known_minor` (forward-compatible additions allowed)

Breaking changes will be announced via a parallel `data-latest-v2` release
so the extension can roll over without downtime.

## `manifest.json`

The entry point. Tiny (~1–2 KB). The extension's background service worker
fetches this every ~6 hours (and on demand from the popup's "Refresh now").

```json
{
  "data_version": "2026-05-24",
  "schema_version": { "major": 1, "minor": 0 },
  "generated_at": "2026-05-24T00:00:00Z",
  "as_of_date": "2026-05-24",
  "history_coverage_start_date": "2024-11-21",
  "window_start_date": "2024-11-21",
  "metric": "marketPrice",
  "lookback_days": 365,
  "rotation_grace_days": 184,
  "card_count": 24987,
  "assets": {
    "price_index": {
      "filename": "price-index-2026-05-24.json",
      "sha256": "<64-hex>",
      "size": 5012345
    },
    "card_index": {
      "filename": "card-index-2026-05-24.json",
      "sha256": "<64-hex>",
      "size": 1820000
    }
  },
  "data_sources": ["TCGCSV (tcgcsv.com)", "Scryfall (scryfall.com)"]
}
```

### Field reference

| Field | Type | Meaning |
|---|---|---|
| `data_version` | string | Stable identity for this snapshot (same value as `as_of_date`). |
| `as_of_date` | string (YYYY-MM-DD) | Date the data was computed for. |
| `generated_at` | string (ISO) | Pinned to `as_of_date`T00:00:00Z so reruns of the same date produce byte-identical outputs and matching SHA-256 hashes. |
| `window_start_date` | string (YYYY-MM-DD) | `as_of_date - (lookback_days + rotation_grace_days)`. Earliest date a card observation can come from in this snapshot. |
| `history_coverage_start_date` | string (YYYY-MM-DD) | Earliest date the rolling DB actually has rows for. Equal to or later than `window_start_date` for fresh deployments. |
| `metric` | string | Always `"marketPrice"`. Reserved for future expansions. |
| `lookback_days` | integer | 365. |
| `rotation_grace_days` | integer | 184. The extra retention beyond the 365-day lookback that covers Jan/Jul rotation grace. |
| `card_count` | integer | Number of `oracle_id` entries in `price_index.cards`. |
| `assets.{price_index,card_index}.sha256` | hex string | SHA-256 of the byte-exact JSON file. The extension verifies this before using the asset. |
| `assets.{...}.size` | integer | Byte size; the extension rejects size mismatches before SHA verification. |
| `data_sources` | array of string | Attribution; surfaced in the popup's About section. |

## `price-index-YYYY-MM-DD.json`

The primary lookup table — one record per Scryfall `oracle_id`.

```json
{
  "data_version": "2026-05-24",
  "schema_version": { "major": 1, "minor": 0 },
  "generated_at": "2026-05-24T00:00:00Z",
  "as_of_date": "2026-05-24",
  "history_coverage_start_date": "2024-11-21",
  "window_start_date": "2024-11-21",
  "metric": "marketPrice",
  "lookback_days": 365,
  "rotation_grace_days": 184,
  "card_count": 24987,
  "cards": {
    "a7e97fa9-4b72-4548-b854-5be5f18a6f1a": {
      "today": 0.18,
      "min_549": 0.18,
      "first_seen": "2024-11-21",
      "floor": [
        [0.18, "2026-03-14"],
        [0.55, "2026-04-30"],
        [1.30, "2026-05-22"]
      ]
    }
  },
  "data_sources": ["TCGCSV (tcgcsv.com)", "Scryfall (scryfall.com)"]
}
```

### Per-card record

| Field | Type | Meaning |
|---|---|---|
| `today` | number \| null | `MIN(marketPrice)` for that oracle on `as_of_date`, in USD. `null` if no observation for today (e.g., TCGCSV missed). |
| `today_stale` | boolean (optional) | Present and `true` iff `today` is null. |
| `min_549` | number \| null | The lowest price on the floor curve (i.e., the lowest observation in the rolling window). |
| `first_seen` | string (YYYY-MM-DD, optional) | Earliest date this oracle was observed in the window. Cards released within the lookback have `first_seen` after `window_start_date`. |
| `floor` | array of `[price, date]` pairs | The **Pareto frontier** of (price, date) observations in the window, sorted ascending by price (see below). |

### Floor-curve semantics

A point `(p, d)` is on the floor iff *no strictly later date* has a price
at-or-below `p`. Equivalent definition: walking observations from today
backwards, a row is on the floor iff its price is strictly less than the
running minimum of strictly later rows (the most-recent row is always on
the floor).

This lets the extension answer **"most recent date the card was at-or-below
threshold T"** in O(log n) for any user-chosen `T`:

```
function lastAtOrBelow(floor, T) {
  // Walk ascending until we'd exceed T; the previous entry's date wins.
  let bestDate = null;
  for (const [price, date] of floor) {
    if (price > T) break;
    bestDate = date;
  }
  return bestDate;
}
```

For the same card, different thresholds yield different rotation dates,
which is the whole point of the configurable-threshold feature.

### Aggregation rule

For every oracle, `today` and the floor curve are computed from

> `MIN(marketPrice)` over **every** TCGCSV price row whose `productId` maps
> via Scryfall's `tcgplayer_id` or `tcgplayer_etched_id` to that oracle,
> across **both** Normal and Foil `subTypeName` rows.

In other words: the cheapest market price you could have paid for *any
physical copy* of the card that day, regardless of finish or printing.
Excluded printings (serialized 1/N collector cards, art series, tokens,
oversized, memorabilia, digital-only) never contribute to the minimum.

## `card-index-YYYY-MM-DD.json`

Side-channel mapping needed by content scripts that only see Scryfall
printing IDs (such as Scryfall search results, Moxfield deck rows, etc.).

```json
{
  "data_version": "2026-05-24",
  "schema_version": { "major": 1, "minor": 0 },
  "generated_at": "2026-05-24T00:00:00Z",
  "as_of_date": "2026-05-24",
  "scryfall_id_to_oracle": {
    "658c5caa-d739-4d30-a512-43ac4de900cb": "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"
  },
  "oracle_names": {
    "a7e97fa9-4b72-4548-b854-5be5f18a6f1a": "Disenchant"
  }
}
```

### Field reference

| Field | Type | Meaning |
|---|---|---|
| `scryfall_id_to_oracle` | object | Map from every paper printing's Scryfall UUID to its oracle_id. Includes printings excluded from the price index (e.g., memorabilia) so the extension can label them gracefully. |
| `oracle_names` | object | Map from oracle_id to the human-readable card name. Used by the popup and badge tooltips. |

## Data freshness

The pipeline runs at 21:30 UTC daily (~90 min after TCGCSV's daily refresh).
A successful run produces a new manifest within minutes.

When `as_of_date` is more than 7 days old the extension surfaces a "stale
data" banner in the popup and tags badge tooltips with "(stale)". The
underlying legality computation continues to use the last-good index so
the extension remains useful while the operator investigates.

## Source attribution

Price data is derived from [TCGCSV](https://tcgcsv.com), which itself
caches public [TCGplayer](https://www.tcgplayer.com) market prices. Card
identity, the printing-to-oracle map, and `oracle_names` come from
[Scryfall](https://scryfall.com/docs/api/bulk-data) bulk data. Both are
credited in the published `data_sources` array.

## Privacy

The published data files contain no user data. They distribute only derived
per-oracle daily minimum aggregates — facts derived from market prices, not
the raw TCGplayer/TCGCSV feed itself. Both upstream sources are credited in
the `data_sources` field and in the extension's About text.
