# Changelog

Every release is tagged and carries [full notes on GitHub](https://github.com/shunyagatha/Vecline/releases) — what changed, why, and what was measured. This file is the index.

Two things hold throughout. Versions follow semver. And nothing listed here is a plan or an intention: each line shipped to npm, and every number quoted in the linked notes was produced by running the code rather than by estimating it — including the ones that were unflattering.

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
