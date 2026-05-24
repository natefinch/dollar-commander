# Dollar Commander — Copilot Instructions

## Project overview

Dollar Commander is a Chrome and Firefox browser extension for overlaying Magic:
The Gathering historical USD 1.00 price-legality information on deck and search
sites.

## Architecture

- `src/content.js` runs in the isolated extension world and owns injected UI.
- `src/content-main.js` runs in the page's main world for future site-specific
  integrations.
- `src/background.js` is the browser background entry point.
- `src/popup.html` and `src/popup.js` power the extension action popup.
- `src/shared/` contains pure helpers used by extension entry points and tests.

## Build and test

```bash
npm run build
npm test
```

Build output goes to `dist/chrome/` and `dist/firefox/`.

