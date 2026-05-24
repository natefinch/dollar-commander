# Dollar Commander

Dollar Commander is a browser extension for a Magic: The Gathering sub-format
where a card is legal if any qualifying paper printing has been available for
USD 1.00 or less during the relevant lookback window.

## Domain language

**Dollar Commander**: The working format name for Commander with an added
historical price-legality layer.

**Price legality**: Whether a card qualifies under the USD 1.00 historical
price rule. This is separate from Commander legality.

**Legality index**: A derived data file keyed by Scryfall Oracle ID that records
whether a card is legal, its last qualifying price date, and warning status.

**Oracle ID**: The preferred card identity for legality decisions because it
groups reprints of the same game object.

**Supported site**: A third-party deck or search site where the extension can
overlay Dollar Commander information. Initial targets are Moxfield, Archidekt,
and Scryfall.

## Current architecture

The extension uses Manifest V3 with Chrome and Firefox builds generated from a
shared source tree. Content scripts currently provide a placeholder overlay on
supported sites; future work should replace this with deck validation and search
result annotations backed by the legality index.

