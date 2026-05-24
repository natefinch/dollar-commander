# Dollar Commander — Copilot Instructions

## Project overview

Dollar Commander is a Chrome and Firefox MV3 browser extension that
overlays Magic: The Gathering historical price-legality information on
Scryfall card and search pages. A card is legal if any printing was at-or-
below the user's configured USD threshold sometime in the last 365 days,
using TCGplayer `marketPrice` aggregated across all versions.

## Read first

* [`docs/implementation-plan.md`](../docs/implementation-plan.md) — the
  authoritative design after a rubber-duck-driven revision.
* [`docs/tcgcsv-research.md`](../docs/tcgcsv-research.md) — TCGCSV /
  TCGplayer / Scryfall data shape research.
* [`docs/data-format.md`](../docs/data-format.md) — the published JSON
  schema the extension consumes.

## Code organization

| Layer | Where |
|---|---|
| Pipeline (daily TCGCSV ingestion) | `scripts/pipeline/*.py` |
| Pipeline tests | `scripts/pipeline/tests/*.py` (pytest) |
| Extension background SW | `src/background.js` |
| Extension lib modules | `src/lib/{price-index,legality,floor-curve,settings}.js` |
| Site content scripts | `src/content/<site>.js` (currently scryfall) |
| Shared badge rendering | `src/content/common/overlay.js` |
| Popup UI | `src/popup.html` + `src/popup.js` |
| Extension tests | `tests/*.test.js` (`node --test`) |
| GitHub Actions | `.github/workflows/*.yml` |

## Architectural ground rules

* **Threshold math lives in pure JS modules.** No DOM, no chrome API, no
  network. They're easy to unit test.
* **Background SW owns all `fetch()`.** Content scripts message the SW;
  they never fetch the data themselves (CORS and dedupe both motivate this).
* **Schema version** is `{major: 1, minor: 0}`. Add fields by bumping
  `minor`; never break major without a parallel `data-latest-v2` rollout.
* **Aggregation rule**: per-oracle daily price is `MIN(marketPrice)`
  across **all** Normal+Foil printings (etched joins via
  `tcgplayer_etched_id`), after excluding serialized, art series,
  memorabilia, oversized, token, digital, and emblem printings.
* **Output determinism**: `publish.py` pins `generated_at` to the
  `as_of_date` so reruns of the same DB state produce byte-identical
  outputs. Don't introduce wall-clock timestamps in the published JSON.

## Build / test

```bash
npm test                       # extension unit tests
npm run build                  # bundle dist/{chrome,firefox}/
cd scripts/pipeline && pytest  # pipeline tests
```

## Rubber-duck loop

This project was implemented phase-by-phase with a GPT-5.5 rubber-duck
critique after each phase. When making non-trivial changes, prefer the
same pattern: plan → critique → implement → critique → commit.

