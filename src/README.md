# Dollar Commander extension architecture

The extension follows a two-world browser split:

- `content.js` runs in the extension's isolated world and owns page UI.
- `content-main.js` runs in the page's main world for future integrations with site internals.
- `background.js` is the Manifest V3 background entry point.
- `popup.html` and `popup.js` provide the browser action popup.
- `shared/` contains pure helpers that can be unit tested in Node.

`build.js` bundles JavaScript entry points with esbuild and writes per-browser output to `dist/chrome/` and `dist/firefox/`.
