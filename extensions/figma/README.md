# Vecline for Figma

Select a layer, click **Vectorize**, and get editable vector paths back — with the
SSIM and PSNR of the conversion.

```
Vecline → 4.1 KB · SSIM 0.9825 · PSNR 33.8 dB · 428 ms
```

The result is placed **beside** your layer, never over it, so the comparison is
immediate. Your original is never modified.

## Two modes

**Trace** turns colour regions into filled contours — the mode for logos, icons
and flat artwork. **Centreline** is a different operation, not a flag on the same
one: it binarises, thins the ink to a one-pixel skeleton and emits open stroked
polylines, which is what you want for a line drawing, a signature or a scanned
sketch. Adaptive thresholding is on for it, because the images people centreline
usually are photographs of paper, where one cutoff for the whole frame loses the
shadowed corner.

The colours and gradients controls belong to Trace and are dimmed under
Centreline, which binarises and has no palette to speak of.

## Why the numbers

Every other way of getting vectors out of a raster in Figma asks you to eyeball
the result. This one renders the SVG it produced back to pixels inside the plugin
and scores it against the image it came from. If it could not measure — a render
that fails, say — it reports "not measured" rather than inventing a figure.

## Defaults

The selection is traced at **its own size**, not upscaled. Exporting at 2x sounded
like it would give the tracer more to work with; measured, it did the opposite —
SSIM 0.9033 against 0.9301, 5,108 path commands against 2,804, 14 KB against 8 KB.
The tracer emits an axis-aligned staircase rather than curves at its default
tolerance, so doubling the input doubles the steps, and shrinking the result back
puts every step on a half-pixel. That is what ragged edges in the canvas were.


Gradients are **on**. Measured on a logo with a gradient: with them off the trace
scored SSIM 0.9119 at 24 KB; with them on, 0.9301 at 8 KB — better fidelity and a
third of the size, so off was simply the wrong default. Raising the palette above
16 does not help (0.9290 at 48 colours), so the slider starts there.

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
  so it cannot decode a PNG or rasterise an SVG. It exports the selection at its
  own size and inserts what comes back.
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

- **The plugin itself, in the Figma desktop app.** Imported from manifest, launched
  from Plugins > Development, and run against a real frame: it picked up the
  selection automatically (405x384), traced it, and inserted a new
  `Frame (vecline)` at X=445 — beside the original, not over it — containing 14
  editable `Vector` layers with the gradient intact as a Linear fill. Running it
  again on the result worked too, and the panel tracked each selection change.

## Licence

MIT, same as Vecline.

## Testing the sandbox half without Figma

The sandbox half touches no DOM by design — only the `figma` global — so it runs
under Node with that global stubbed, against the **built** `dist/code.js`:

```bash
npm run build                 # in extensions/figma
npm test -- figma             # from the repo root
```

`test/figma-sandbox.test.ts` drives the bundle through every message it can
receive and asserts where the result actually lands: beside a top-level layer,
beside a layer nested in a frame without stacking the two coordinate spaces, on
the page in absolute coordinates when the parent is auto-layout, and bound to the
layer it was traced from even if the selection moves during the run.
`test/figma-placement.test.ts` covers the placement arithmetic on its own,
including a sweep of container origins for the "never over it" claim.

This used to be a browser page you opened by hand, whose only assertion was that
one node had been inserted. It passed for weeks while the plugin dropped the copy
on top of the original for every layer inside a frame — it never read the
resulting coordinates, and its fake node had no parent, so it could not have
represented a nested layer even if it had. Asking "did it run" is not the same as
asking "did it go where we promise", and only the second question catches
anything.

This covers the plugin's logic. What it cannot cover is Figma's own runtime
loading `manifest.json` — that needs the desktop app, because Figma's browser
build has no `Plugins → Development` menu (verified: it offers only installed
plugins, "Run last plugin" and "Manage plugins…").
