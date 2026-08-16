# Changelog

Every release is tagged and carries [full notes on GitHub](https://github.com/shunyagatha/Vecline/releases) — what changed, why, and what was measured. This file is the index.

Two things hold throughout. Versions follow semver. And nothing listed here is a plan or an intention: each line shipped to npm, and every number quoted in the linked notes was produced by running the code rather than by estimating it — including the ones that were unflattering.

## [v1.46.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.46.0)

Nine defects that all produced output which looked healthy and was wrong, found by an audit sweep and each reproduced before being touched. The minifier rounded every decimal with a context-free regex, which is unsafe in path data: `l12.004.513` is *two* numbers because a second decimal point ends the first, so rounding `12.004` to `12` destroyed the separator and left `120.51` — one coordinate where there were two, in a still well-formed document, with optimisation on by default. Separators are now decided after rounding from the emitted text, and negatives stay tight (`l-1-2.5 0.75`) so compactness does not regress. Centreline treated low contrast as no contrast: the binariser called the whole frame ink whenever Otsu's class means sat within 24 luma, so a cross at paper 128 / ink 110 gave `inkPixels=2304` of a 2304px frame and **0 paths**, while the same drawing at ink 60 gave 368 and 4. That branch returned 0 paths in every case it was written for, so it went; Otsu separability was measured as a replacement and rejected, because noisy line art scores 0.66 against a smooth gradient's 0.75 and no threshold separates them. The seam stroke carried the fill's colour but not its alpha, and `fill-opacity` does not apply to strokes, so a translucent region got a fully opaque ring at the exact edge the stroke exists to hide.

CommonJS TypeScript projects could not import the package at all — every `exports` entry pointed `types` into `dist/esm`, which is marked `type: module`, so `tsc` rejected it with TS1479 while `require('vecline')` worked perfectly at runtime. Each condition now carries its own declarations. `sharp` moves to ^0.35.3, off the 0.34 line carrying four unfixed libvips advisories on the path every user-supplied image travels; `npm audit --omit=dev` goes from 2 high to 0. And `trace()`, `centerlineTrace()` and `vectorizeExact()` now reject anything that is not a decoded `RasterImage`: passing file bytes used to flow through as `undefined` and emerge as `<svg width="undefined" viewBox="0 0 undefined undefined">` from a call that reported success.

The VS Code extension was dead everywhere except Linux x64. Packaged as one universal `.vsix` on Ubuntu, it carried `sharp-linux-x64` and nothing else — 11 MB, 694 files, installs cleanly, then `Could not load the "sharp" module using the win32-x64 runtime` on first use. It ships as eight platform-specific packages now, each cross-installed from the same lockfile, behind a gate that reads the archive and rejects any package carrying the wrong platform's binaries. Version drift is guarded in four more places, including the extension's own version, which had read 0.1.0 since it was created and would have had every release after the first rejected as a duplicate. `vecline.mcpb` is built and attached by CI, so the README's one-click install link resolves again after 404ing since v1.40.1. Documentation was corrected against what the code does rather than what it once did — including the benchmark table, whose trace rows were off by 2.3x on a table that invites the reader to reproduce it.

## [v1.45.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.45.0)

Centreline, corrected at the root. Zhang–Suen thinning erased a two-pixel-wide diagonal from both ends, so a filled diagonal shape thinned to a 2px stub the length filter then dropped — an empty result for any rotated stroke; Guo–Hall, whose connectivity test is over neighbour pairs, keeps it. Binarisation now takes alpha as the shape when the image carries transparency or its opaque pixels are one luminance population — a design-tool export is ink on nothing, and a luminance split there traced to nothing. And it compares `round(luma)` against the Otsu cutoff it was binned from, not the raw float, which had silently dropped about half of all flat fill colours (e.g. `#334155` at 63.47 against a cutoff of 63). `CenterlineOutput` gains `length` and `inkPixels` so a caller can tell a stroke from a filled blob.

## [v1.44.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.44.1)

MCP setup for Codex and VS Code, and a correction: the old text said Cursor, Windsurf and Continue share the Claude Desktop config shape — true — but VS Code does not. Its `.vscode/mcp.json` keys the map as `servers`, not `mcpServers`, so following that line in VS Code produced a file the editor ignores. Codex takes TOML and was not mentioned at all. Three blocks now, one per shape that exists, plus the CLI one-liners. The registry listing carries the Vecline mark.

## [v1.44.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.44.0)

`--speckle-scope isolated`: despeckling that can tell noise from an edge. The size cutoff alone cannot — measured on logo-tux at 16 colours, only 40.2% of the components under 8px are specks floating inside a uniform field; the other 59.8% sit between two regions and are antialiasing fringe carrying the sub-pixel position of an edge. On a JPEG-artifact photo it is 13.0% against 87.0%. Removing by size spends most of its deletions on signal, which is why despeckling cost 0.05-0.20 SSIM across the corpus. Scoping to isolated specks is twice the size saving per unit of fidelity (0.00041 SSIM/KB against 0.00086), and on photo-jpeg-artifacts it is the difference between 0.8657 and 0.5488. Not free — recolouring a speck is a real change — but it never moves an edge. Default is unchanged.

## [v1.43.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.43.0)

`--severity`: where the error is, not just how much. SSIM, PSNR and mean ΔE are global aggregates, and an aggregate cannot separate a harmless dusting of antialiasing along every edge from one solid wrong-coloured region — averaged over a megapixel they can score alike. Differing pixels are opened morphologically to delete one-pixel filaments, clustered 4-connected, and scored by summed squared area so a coherent blob outweighs scattered dust. Plus a composite: a geometric mean over accuracy, structure and coherence, so no strong axis can carry a collapsed one. On `photo-parrots` this reports SSIM 0.834 against coherence 0.321 — a 266,960px coherent wrong region the aggregates hide.

## [v1.42.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.42.0)

Adaptive thresholding (Bradley–Roth): `--adaptive` on `vectorize`, `centerline` and `gcode`. A global cutoff assumes the page is lit evenly; a photograph of paper is not, and no single number serves both a lit corner and a shadowed one. On a page with a lighting gradient where the ink is a constant 35% below its *local* paper, Otsu turns the shadowed half solid black — precision 15.2%, F1 26.4%. Comparing each pixel with its own neighbourhood scores 100%.

## [v1.41.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.41.1)

Component bounding boxes were `(-1, -1)` at every min corner, because an `Int32Array` cannot hold `Number.MAX_SAFE_INTEGER`. Despeckling a one-megapixel photograph took 103 seconds; it now takes under one.

## [v1.41.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.41.0)

A ramp is judged against the bands it replaces, not against raw error it could never win.

## [v1.40.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.40.1)

The size-budget solver overshot its target, sometimes by 6x.

## [v1.40.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.40.0)

Sector primitive — pie slices and donut segments as real arcs — and a despeckle threshold read from the image.

## [v1.39.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.39.1)

Docs catch up with what shipped.

## [v1.39.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.39.0)

Extend-under: one boundary instead of two.

## [v1.38.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.38.1)

Package metadata catches up.

## [v1.38.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.38.0)

Cut-ready DXF units, and a core that proves it bundles.

## [v1.37.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.37.0)

Vecline serve: Office conversion without uploading.

## [v1.36.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.36.0)

Convert gains raster→raster; component handles real-world SVGs.

## [v1.35.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.35.0)

Tool annotations, privacy policy, and a one-click desktop bundle.

## [v1.34.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.34.1)

Registry metadata for MCP discovery.

## [v1.34.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.34.0)

MCP server degrades honestly and describes itself accurately.

## [v1.33.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.33.1)

The photo preset was worse than auto on photographs.

## [v1.33.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.33.0)

Size/complexity budget with a measured cost receipt.

## [v1.32.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.32.0)

The project is now Vecline.

## [v1.31.2](https://github.com/shunyagatha/Vecline/releases/tag/v1.31.2)

Repositioning & npm discoverability.

## [v1.31.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.31.1)

Core-pipeline hardening.

## [v1.31.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.31.0)

Audit fixes (office/pdf/mcp glue).

## [v1.30.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.30.0)

Office batch conversion.

## [v1.29.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.29.0)

MCP tools for documents.

## [v1.28.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.28.0)

Pixvec doc renders Office documents.

## [v1.27.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.27.0)

Images → PDF + audit fixes.

## [v1.26.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.26.0)

Office documents ⇄ PDF.

## [v1.25.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.25.0)

PDF → SVG (doc -f svg).

## [v1.24.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.24.0)

Documents → images (pixvec doc).

## [v1.23.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.23.0)

GitHub Action + CI size report.

## [v1.22.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.22.0)

Radial gradient reconstruction.

## [v1.21.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.21.0)

MCP diff/crop tools + diff fix.

## [v1.20.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.20.0)

Rounded-rectangle primitive.

## [v1.19.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.19.0)

Perceptual visual-regression diff.

## [v1.18.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.18.1)

Animation playback fix.

## [v1.18.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.18.0)

Animated GIF/APNG → animated SVG.

## [v1.17.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.17.1)

Audit fixes.

## [v1.17.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.17.0)

Content-aware smart crop.

## [v1.16.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.16.0)

Arc-aware DXF.

## [v1.15.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.15.0)

Geometric primitives.

## [v1.14.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.14.0)

SVG sprite sheets.

## [v1.13.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.13.0)

Vite/Rollup build plugin.

## [v1.12.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.12.0)

SVG optimizer.

## [v1.11.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.11.1)

Adversarial-audit fixes.

## [v1.11.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.11.0)

MCP server for AI agents.

## [v1.10.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.10.0)

G-code / toolpath output.

## [v1.9.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.9.0)

Centerline / single-stroke tracing.

## [v1.8.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.8.0)

DXF / EPS / PDF vector export.

## [v1.7.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.7.0)

Web-dev asset pipelines.

## [v1.6.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.6.0)

Layered SVG, locked palette, component codegen.

## [v1.5.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.5.0)

Gradient output, vtracer benchmark, and photos that beat the field by default.

## [v1.4.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.4.0)

Competitor tuning-knob parity + full ops surface.

## [v1.3.3](https://github.com/shunyagatha/Vecline/releases/tag/v1.3.3)

Pixvec v1.3.3.

## [v1.3.2](https://github.com/shunyagatha/Vecline/releases/tag/v1.3.2)

Pixvec v1.3.2.

## [v1.3.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.3.0)

Pixvec v1.3.0.

## [v1.2.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.2.0)

Pixvec v1.2.0.

## [v1.1.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.1.0)

Pixvec v1.1.0.

## [v1.0.0](https://github.com/shunyagatha/Vecline/releases/tag/v1.0.0)

Pixvec v1.0.0.

## [v1.3.1](https://github.com/shunyagatha/Vecline/releases/tag/v1.3.1)

Pixvec v1.3.1.
