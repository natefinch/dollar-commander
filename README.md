# Dollar Commander

Dollar Commander is a Chrome and Firefox browser extension skeleton for adding
historical USD 1.00 price-legality overlays to Magic: The Gathering deck and
search sites.

The initial targets are Moxfield, Archidekt, and Scryfall. The pricing and
format research lives in [dollar-commander-pricing.md](dollar-commander-pricing.md).

## Development

```bash
npm install
npm run build          # build both browsers -> dist/chrome/ and dist/firefox/
npm run build:chrome   # build Chrome only
npm run build:firefox  # build Firefox only
npm run watch          # rebuild on changes
npm test
```

## Loading the extension

### Chrome

1. Run `npm run build:chrome`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist/chrome/`

### Firefox

1. Run `npm run build:firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on...**
4. Select `dist/firefox/manifest.json`

## Layout

- `build.js` bundles extension entry points with esbuild.
- `manifests/` contains the shared manifest plus Chrome and Firefox overrides.
- `src/` contains extension source files.
- `tests/` contains Node tests for shared logic.
- `scripts/` contains release helper scripts.

## License

MIT - see [LICENSE](LICENSE).

