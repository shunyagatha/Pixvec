# Vecline for Figma

Select a layer, click **Vectorize**, and get editable vector paths back — with the
SSIM and PSNR of the conversion.

```
Vecline → 4.1 KB · SSIM 0.9825 · PSNR 33.8 dB · 428 ms
```

The result is placed **beside** your layer, never over it, so the comparison is
immediate.

## Why the numbers

Every other way of getting vectors out of a raster in Figma asks you to eyeball
the result. This one renders the SVG it produced back to pixels inside the plugin
and scores it against the image it came from. If it could not measure — a render
that fails, say — it reports "not measured" rather than inventing a figure.

## Privacy

`networkAccess` is `none` and that is enforced by Figma, not promised by us. The
tracer runs inside the plugin iframe; the artwork never leaves the document.

## Building

```bash
npm install
npm run build
```

Then in the Figma **desktop app**: `Plugins → Development → Import plugin from
manifest…` and pick `manifest.json`. The browser build of Figma can only run
published plugins, so local development needs the desktop app.

## How it is split

Figma runs a plugin in two halves, and they can do different things:

- **`src/code.ts`** — the sandbox. Reads and writes the document, but has no DOM,
  so it cannot decode a PNG or rasterise an SVG. It exports the selection at 2x
  and inserts what comes back.
- **`src/ui.ts`** — the iframe. Has a canvas, so this is where `vecline/core`
  runs: decode, trace, render back, score.

`vecline/core` is dependency-free and free of Node built-ins, which is what makes
it survive a sandboxed iframe; `test/portability.test.ts` in the main repo asserts
that on every build.

## Verified

- **SVG fidelity** — a Vecline-emitted SVG pasted into Figma returns real
  `Vector path` nodes with the gradient intact as an editable Linear fill, not a
  flattened raster. Our gradients use `gradientUnits="userSpaceOnUse"` with
  absolute coordinates and no `gradientTransform`, which avoids both documented
  `createNodeFromSvg` importer failures.
- **The engine in a browser sandbox** — the built `ui.html` was loaded in a
  browser and driven through the full path with a synthetic selection: 200x200 in,
  4,227 bytes out, SSIM 0.9825, PSNR 33.8 dB, 428 ms.

What is **not** yet verified is the Figma plugin shell itself — manifest loading
and the `figma.*` calls — which needs the desktop app to exercise.

## Licence

MIT, same as Vecline.

## Testing the sandbox half without Figma

`test/harness.html` stands in for Figma's plugin sandbox — it shims `figma.showUI`,
`ui.postMessage`, `createNodeFromSvg`, `notify` and the rest, then drives
`dist/code.js` through every message it can receive. Serve the plugin directory
and open it:

```bash
npm run build
npx http-server . -p 5200     # or any static server
# then open http://localhost:5200/test/harness.html
```

It asserts that a `ready` message exports the selection, a `traced` message
inserts exactly one node and reports the measurement, a `failed` message surfaces
as an error, and a malformed SVG is reported rather than silently swallowed.

This covers the plugin's logic. What it cannot cover is Figma's own runtime
loading `manifest.json` — that needs the desktop app, because Figma's browser
build has no `Plugins → Development` menu (verified: it offers only installed
plugins, "Run last plugin" and "Manage plugins…").
