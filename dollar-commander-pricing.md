# Dollar Commander pricing research

## Goal

Define and support a Magic: The Gathering sub-format where a card is legal if any paper printing of that card has been available for USD 1.00 or less during the relevant lookback window.

The motivating use case is Commander, but the same pricing legality layer could be applied to other formats.

## Proposed legality rule

A card is legal if any qualifying paper version of the card was priced at USD 1.00 or less at least once in the last year.

Legality changes should minimize disruption:

- A card becomes legal immediately when any qualifying version falls to USD 1.00 or less.
- A card only becomes illegal on January 1 or July 1.
- A card becomes illegal on one of those dates only if it has been above USD 1.00 for the entire preceding year.
- Deck tools should warn players as a card approaches the one-year cutoff, so Jan/Jul removals are predictable.

This creates a rolling "last affordable date" model instead of a strict current-price model.

## Core problem

Scryfall, Moxfield, Archidekt, and similar deckbuilding tools can search current prices, for example `usd<=1`. That does not find cards that are currently above USD 1.00 but are still legal because they were USD 1.00 or less within the last year.

Scryfall appears to expose current price snapshots only. Its bulk data includes card price fields, but the bulk data documentation says those prices should be considered stale after 24 hours and does not provide historical price-series search operators.

Because of that, this format needs its own derived legality database. Existing deckbuilding sites can still be used, but historical-price legality has to be computed outside their native search systems.

## Best data source found: TCGCSV

TCGCSV is the only source found that appears suitable for this use case without negotiating paid commercial access.

TCGCSV provides:

- TCGplayer-derived category, group, product, and price data.
- Daily current-price exports.
- A historical daily price archive from 2024-02-08 onward.
- Magic: The Gathering as TCGplayer category `1`.
- JSON endpoints for current category/group/product/price data.
- Downloadable compressed daily archives for historical prices.

Historical archive URL pattern:

```text
https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z
```

Example:

```bash
curl -O https://tcgcsv.com/archive/tcgplayer/prices-2024-02-08.ppmd.7z
7z x prices-2024-02-08.ppmd.7z
```

After extraction, price files are organized by date, category, and group:

```text
YYYY-MM-DD/1/<groupId>/prices
```

The Magic category can be discovered at:

```text
https://tcgcsv.com/tcgplayer/categories
```

Current Magic groups:

```text
https://tcgcsv.com/tcgplayer/1/groups
```

Current group prices:

```text
https://tcgcsv.com/tcgplayer/1/<groupId>/prices
```

Current group products:

```text
https://tcgcsv.com/tcgplayer/1/<groupId>/products
```

### TCGCSV price shape

TCGCSV price records include:

- `productId`
- `lowPrice`
- `midPrice`
- `highPrice`
- `marketPrice`
- `directLowPrice`
- `subTypeName`

For Magic, `subTypeName` examples include `Normal` and `Foil`.

The prices are product-level TCGplayer market price objects, not SKU-level inventory or condition-specific listings. The docs note that `productId` plus `subTypeName` should be treated as the composite key for prices.

### TCGCSV limitations

TCGCSV is strong enough for this format, but the format should be explicit about what data it uses:

- It is not official TCGplayer historical API access.
- It does not expose condition-specific SKU prices.
- It uses product-level price objects such as market, low, mid, high, and direct low.
- Historical data starts on 2024-02-08; older price history is unavailable there.
- Daily archives must be downloaded one date at a time.
- The site asks users to be good neighbors: use a custom User-Agent, avoid excessive polling, limit full syncs, and do not poll more than once per day.

For this format, `marketPrice` is probably the best primary metric, with `lowPrice` as an alternate rule option if the format wants to be more permissive. The chosen metric should be part of the format definition.

## Other sources considered

### MTGJSON

MTGJSON is excellent for card metadata and has price data, but its `AllPrices` file is documented as containing prices for the past 90 days. That is not enough for a 12-month lookback.

Useful role:

- Join and normalize card identifiers.
- Potentially provide recent price backup data.
- Not sufficient as the primary source for annual price legality.

### Scryfall

Scryfall is the best card metadata and card search API, but it does not appear to support historical price queries or historical price search syntax.

Useful role:

- Oracle IDs.
- Card names.
- Print metadata.
- Commander/color/legalities data.
- Bulk card data for building a search index.

Not sufficient for:

- "Was this card ever USD 1.00 or less in the last year?"
- Native historical-price search.

### TCGplayer official API

TCGplayer exposes current pricing endpoints, but public historical bulk access appears limited or unavailable. API access also requires application/partner access.

Useful role:

- Potential future direct source if access is granted.

Not ideal for:

- Open, reproducible, low-friction format support.

### Cardmarket

Cardmarket has a Price Guide endpoint and website downloads, but the API endpoint is restricted/deprecated and the guide provides current daily guide data plus short averages such as 1/7/30 days, not a ready 12-month historical archive.

Useful role:

- Possible Europe-focused parallel format if someone self-archives daily Cardmarket data.

Not sufficient for:

- Immediate 12-month historical legality without prior archiving.

### Scrydex

Scrydex has a real price-history API endpoint with date range parameters. It may be useful, but the documentation checked did not make retention depth or data provenance clear enough to rely on it as the core open source of truth.

Useful role:

- Possible paid/API-backed alternative.

Risk:

- Need to confirm retention, cost, data licensing, and identifier matching.

### TCGAPIs

TCGAPIs advertises historic prices, sales history, SKU pricing, CSV exports, and multiple marketplace sources. It is commercial, with pricing tiers.

Useful role:

- Potential paid/commercial backend.

Risk:

- Need to confirm retention depth, terms, export rights, and cost.

## Recommended architecture

Use TCGCSV as the source of truth for price history, then publish a derived legality index.

### Ingestion

Run a daily job that:

1. Checks whether TCGCSV has new data.
2. Downloads the new daily price archive.
3. Extracts Magic category `1` price files.
4. Joins prices to TCGCSV products and groups.
5. Maps TCGplayer `productId`s to Scryfall IDs and then Scryfall Oracle IDs.
6. Records daily price facts for each card printing and finish.

### Normalization

The format should probably define card identity by Scryfall `oracle_id`, not by name.

Reasons:

- Oracle ID handles reprints cleanly.
- It avoids weirdness with name collisions, variant names, and double-faced cards.
- It lets the rule mean "any printing of this game object was affordable."

For deck validation, the extension should resolve deck entries to Oracle IDs and check those Oracle IDs against the legality index.

### Storage model

At minimum, store:

- `oracle_id`
- `scryfall_id`
- `tcgplayer_product_id`
- `group_id`
- `sub_type_name`
- `date`
- `market_price`
- `low_price`
- `mid_price`
- `direct_low_price`

Derived per-Oracle fields:

- `legal`
- `last_seen_at_or_below_1`
- `first_seen_above_1_after_last_legal_date`
- `next_review_date`
- `warning_state`
- `qualifying_printing_scryfall_id`
- `qualifying_product_id`
- `qualifying_price`
- `qualifying_price_date`
- `qualifying_price_metric`

### Legality index

Publish a compact static file for browser extensions and tools:

```json
{
  "oracle-id-here": {
    "legal": true,
    "last_under_1": "2026-03-14",
    "warning": null,
    "source": {
      "metric": "marketPrice",
      "price": 0.93,
      "date": "2026-03-14",
      "productId": 123456,
      "subTypeName": "Normal"
    }
  }
}
```

A separate expanded index can power search:

- Oracle ID
- card name
- color identity
- type line
- mana value
- Commander legality
- format legality
- price legality fields
- warning fields

## Browser extension strategy

The browser extension should not try to force Scryfall or deckbuilder sites to understand the new format natively. It should treat Dollar Commander legality as an overlay.

### Deck validation

On Moxfield, Archidekt, and similar deck pages:

1. Extract the decklist or intercept/consume the site's card data.
2. Resolve each card to Scryfall Oracle ID.
3. Check each Oracle ID against the legality index.
4. Add badges:
   - legal
   - legal because of historical price
   - warning: may rotate out on Jan/Jul
   - illegal
5. Summarize the deck status.

This is the easiest and highest-value extension feature.

### Search result filtering

The extension can post-filter search results from Scryfall, Moxfield, Archidekt, and similar sites:

- Hide illegal cards.
- Mark legal cards.
- Mark warning cards.
- Add a "Dollar Commander legal only" toggle.

However, post-filtering only works on cards that the site already returned. If a user searches `usd<=1`, currently expensive-but-historically-legal cards will not appear in the site's results, so the extension cannot reveal them unless it has its own search index.

### Dedicated search

For complete discovery, build a companion search page or extension search UI backed by the derived legality index plus Scryfall bulk card data.

Options:

- Static search page hosted on GitHub Pages or Cloudflare Pages.
- Extension popup/search tab with a local compressed search index.
- Small API service for richer Scryfall-like querying.

The search does not need to fully clone Scryfall at first. Useful first filters:

- name text
- color identity
- card type
- Commander legal
- mana value
- rarity
- set
- legal / warning / illegal
- last date under USD 1.00

## Warning logic

The format can provide useful warnings before Jan/Jul cutoffs.

Suggested states:

- `legal_recent`: card has been USD 1.00 or less recently.
- `legal_aging`: card is legal, but has not been USD 1.00 or less for several months.
- `warning`: card will become illegal at the next Jan/Jul cutoff unless it drops to USD 1.00 or less again.
- `scheduled_illegal`: card has crossed the one-year threshold and will become illegal on the next cutoff.
- `illegal`: card was not USD 1.00 or less during the relevant lookback window as of the last cutoff.
- `newly_legal`: card became legal immediately because it dropped to USD 1.00 or less.

The exact warning threshold is a product decision. Reasonable choices:

- warn after 9 months above USD 1.00
- stronger warning after 11 months above USD 1.00
- scheduled-illegal once the full 12-month lookback has elapsed, pending the Jan/Jul cutoff

## Open rule decisions

These should be decided before implementation:

1. Which price field defines affordability: `marketPrice`, `lowPrice`, `midPrice`, or some fallback chain?
2. Does a foil price qualify a nonfoil card, and vice versa?
3. Are digital-only, oversized, art cards, tokens, acorn/silver-border, and other unusual objects excluded before price checks?
4. Is legality by Oracle ID, exact printing, or card name? Oracle ID is recommended.
5. Are only English printings considered, or any language?
6. How should missing/null prices be handled?
7. What happens when TCGCSV has no price for a card?
8. Should Commander legality also be enforced, or should price legality be format-agnostic and layered on top of Commander separately?
9. Should "any version" include special treatments, showcase, borderless, promo pack versions, etc.?
10. What should the official name of the format be?

## Recommended path

1. Use TCGCSV as the price-history source.
2. Use Scryfall bulk data for card identity, metadata, and Commander legality.
3. Normalize price legality by Oracle ID.
4. Publish a static legality JSON file.
5. Build the browser extension around deck validation first.
6. Add post-filtering for existing search pages second.
7. Build a dedicated legality-aware search page third, because existing sites cannot natively search historical price legality.

## References

- TCGCSV homepage: https://tcgcsv.com/
- TCGCSV FAQ and historical archive notes: https://tcgcsv.com/faq
- TCGCSV docs: https://tcgcsv.com/docs
- TCGCSV categories endpoint: https://tcgcsv.com/tcgplayer/categories
- TCGCSV Magic groups endpoint: https://tcgcsv.com/tcgplayer/1/groups
- Scryfall API docs: https://scryfall.com/docs/api
- Scryfall bulk data docs: https://scryfall.com/docs/api/bulk-data
- MTGJSON all files docs: https://mtgjson.com/downloads/all-files/
- MTGJSON AllPrices file: https://mtgjson.com/api/v5/AllPrices.json
- Cardmarket Price Guide API docs: https://api.cardmarket.com/ws/documentation/API_2.0:PriceGuide
- Scrydex MTG price history docs: https://scrydex.com/docs/magicthegathering/price-history
- TCGAPIs MTG API: https://tcgapis.com/mtg-api
- TCGAPIs pricing: https://tcgapis.com/pricing
