# Dollar Commander

A Chrome and Firefox browser extension that overlays Magic: The Gathering
historical price-legality information on Scryfall card and search pages.

A card is **legal** if any printing was available at-or-below your
configured threshold (default **$1.00**) sometime in the last **365 days**.
The threshold is user-configurable in the popup; the rolling 549-day data
window covers the 365-day lookback plus a 184-day Jan/Jul rotation grace
period.

> Dollar Commander format pricing research and the implementation plan live
> in [`docs/`](docs/).

## Status

MVP. Scryfall is integrated. Moxfield and Archidekt are planned follow-ups.

## How it works

* A daily GitHub Actions pipeline downloads TCGCSV's PPMd-compressed 7z
  archive of TCGplayer market prices, joins to Scryfall's `default_cards`
  bulk file, and computes per-`oracle_id` `MIN(marketPrice)` across **every
  version** of each card (Normal + Foil, all printings).
* The pipeline publishes a small JSON manifest plus dated price-index and
  card-index assets to a single GitHub Release tagged `data-latest`.
* The extension's background service worker fetches the manifest every 12h,
  SHA-256-verifies the linked assets, and serves lookups to the Scryfall
  content script. Pure-function legality math means the same data answers
  legality for any threshold the user picks.

See [`docs/tcgcsv-research.md`](docs/tcgcsv-research.md) for the underlying
data investigation and [`docs/implementation-plan.md`](docs/implementation-plan.md)
for the design.

## Repo layout

| Path | Purpose |
|---|---|
| `manifests/` | MV3 manifest base + Chrome/Firefox overlays. |
| `src/background.js` | Service worker: alarm-driven index refresh + message router. |
| `src/lib/` | Pure modules (`price-index`, `legality`, `floor-curve`, `settings`). All unit-tested. |
| `src/content/scryfall.js` | Scryfall isolated-world content script. |
| `src/content/common/overlay.js` | Shared badge rendering. |
| `src/popup.html` / `src/popup.js` | Settings UI + freshness display. |
| `scripts/pipeline/` | Python daily pipeline (oracle map, ingest, backfill, publish). |
| `.github/workflows/` | `daily-index.yml`, `backfill.yml`, `keep-alive.yml`, `notify-pipeline-failure.yml`. |
| `tests/` | `node --test` unit tests for the JS modules. |
| `docs/` | Research, plan, and data-format docs. |

## Development

### JavaScript / extension

```bash
npm install
npm test            # node:test unit tests (no extension runtime needed)
npm run build       # esbuild bundle into dist/{chrome,firefox}/
npm run build:chrome
npm run build:firefox
npm run watch       # rebuild on changes
```

### Python / pipeline

All pipeline commands run from the repo root so the `scripts.pipeline.*`
module imports resolve correctly:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r scripts/pipeline/requirements.txt
pytest scripts/pipeline/tests

# One-off local invocations (require network).
python -m scripts.pipeline.oracle_map --out data/scryfall-oracle-map.json
python -m scripts.pipeline.ingest_day \
  --fetch-products-only --out data/products.json
python -m scripts.pipeline.ingest_day \
  --date 2026-05-24 \
  --db data/history.sqlite \
  --map data/scryfall-oracle-map.json \
  --products data/products.json
```

### CI workflows

* `daily-index.yml` — scheduled at 21:30 UTC. Ingests today, recomputes
  floor curves, and publishes `manifest.json` + dated assets to the
  `data-latest` release. Fails only on catastrophic regressions (unmapped-
  product ratio >= 50%).
* `backfill.yml` — `workflow_dispatch`. Seeds 549 days of history into
  `data-latest/history.sqlite`. Estimated runtime ~30 minutes.
* `keep-alive.yml` — monthly comment on a tracking issue so GitHub's
  60-day scheduled-workflow auto-disable never engages.
* `notify-pipeline-failure.yml` — opens/comments on a single
  `pipeline-failure`-labeled issue when the daily run fails.

## Loading the extension

### Chrome

1. `npm run build:chrome`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist/chrome/`

### Firefox

1. `npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…**
4. Select `dist/firefox/manifest.json`

## Privacy

Dollar Commander does not transmit page contents, deck contents, oracle IDs,
or browsing data anywhere. The only network requests it makes are public
GETs to GitHub release-asset hosts (`github.com` and
`objects.githubusercontent.com`) for the daily price-index assets.

## Data attribution

* Price data: [TCGCSV](https://tcgcsv.com), which caches public TCGplayer
  market prices.
* Card identity: [Scryfall](https://scryfall.com/docs/api/bulk-data) bulk
  data.

Both sources are credited in the published manifest's `data_sources` array
and surfaced in the extension's popup.

## License

MIT — see [LICENSE](LICENSE).

