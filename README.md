<img src="https://raw.githubusercontent.com/shunyagatha/Vecline/main/extensions/figma/thumbnail.png" alt="Vecline">

# Vecline

**Measurable raster ⇄ SVG conversion — and a broad image + document toolkit.** Ten raster formats, every one convertible to every other, with the accuracy of every conversion actually measured rather than asserted; plus **PDF & Office** (docx/xlsx/pptx) rendering and conversion, **images → PDF**, **DXF at a real physical cut size** alongside EPS and G-code for makers, centerline tracing and content-aware crop — most of it in a **zero-dependency** core that is CI-proven to bundle for a browser.

On flat artwork — logos, icons, UI, screenshots, pixel art — the output is **bit-exact**: `SSIM 1.0000`, `PSNR ∞`, zero differing pixels, and on a real logo **smaller than imagetracerjs or vtracer manage while still only approximating** — 24 KB against their 60 and 64. That comes from recognising the image is cheaper to encode exactly than to approximate, not from a better curve fit; ask for real curves (`--preset logo`) and you lead all three on accuracy, still under vtracer on size but above imagetracerjs on alpha-heavy art. potrace is smaller than everyone and much less accurate, which is a real trade and not one this README will hide. On real photographs it leads all three on SSIM by 0.05–0.18 *at their default settings*; one documented vtracer flag closes part of that. It is not the fastest — imagetracerjs is quicker on every fixture measured. Every number in this README is reproducible: `node scripts/fetch-corpus.mjs && npm run compare`. (The corpus is fetched rather than committed — the photographs are not ours to redistribute.)

[![npm version](https://img.shields.io/npm/v/vecline.svg)](https://www.npmjs.com/package/vecline)
[![npm downloads](https://img.shields.io/npm/dm/vecline.svg)](https://www.npmjs.com/package/vecline)
[![CI](https://github.com/shunyagatha/Vecline/actions/workflows/ci.yml/badge.svg)](https://github.com/shunyagatha/Vecline/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/vecline.svg)](https://www.npmjs.com/package/vecline)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)

**▶ [Vecline Studio — vecline.xyz](https://vecline.xyz)** — the whole toolkit in your browser. Drop an image, a **PDF**, or a TGA/PNM/ICO no browser can read; tune it; watch live SSIM / PSNR / CIEDE2000; export SVG, DXF **at a real cut size**, EPS, PDF, G-code, React/Vue/Svelte/Solid components, colour separations, sprite sheets, favicons, BlurHash, or just re-encode between ten raster formats. Free, unlimited, no signup, works offline, and **nothing is uploaded** — every conversion runs in your tab, not on a server. ([How it compares](https://vecline.xyz/compare.html) · [dev playground](https://shunyagatha.github.io/Vecline/))

```bash
vecline vectorize logo.png --verify
```

```
✓ logo.svg  400×300  pixel mode  4 shapes  2.1 KB → 7.5 KB  228 ms
  · Auto-selected pixel mode: 4 distinct colours, 1.0% run density. Output is bit-exact.

Accuracy  bit-exact (lossless)
  PSNR        ∞
  SSIM        1.000000 (luma 1.000000)
  RMSE        0.0000
```

---

## The lossless guarantee

```bash
vecline vectorize anything.png --lossless
```

`--lossless` returns a **bit-exact** SVG or it **fails**. It never silently gives you a near-miss.

That is enforced by measurement, not by construction. Every candidate encoding is rendered back to pixels and compared against the source; anything that is not bit-identical is discarded, and if nothing survives, the command errors out. Candidates are tried in order of how useful the result is:

1. **Exact geometry** — real, editable, infinitely scalable paths. Rectangles or contours, whichever encodes smaller.
2. **Embed, original bytes preserved** — a **byte-identical** round trip of the source *file*, not just of its pixels.
3. **Embed, re-encoded as PNG** — always renders exactly, but no longer carries the original file.

Measured across every fixture in the test suite — flat artwork, pixel art, soft alpha, photographs, JPEG sources, a single pixel — all of them come back `PSNR ∞`, `maxChannelDiff 0`.

### Byte-identical, and provable

When the original file is preserved, the SVG records its SHA-256. `extract` hands the file back and checks the digest:

```bash
vecline vectorize logo.png -o keep.svg --mode embed --embed-strategy preserve
vecline extract keep.svg -o recovered.png --against logo.png
```

```
✓ recovered.png  image/png  2.1 KB
  sha256   1c4f95f66b28a40a75672614796de762f6ef8a6afec3191b460dbbd556f10366
  digest   matches the value recorded when the SVG was written
  payload  the original file, preserved byte for byte
  vs source byte-identical to logo.png
```

`extract` exits non-zero on any mismatch, so it works as a CI gate. Note the honest caveat: an *embedded JPEG* survives byte for byte but does **not** render bit-identically, because resvg's decoder rounds its inverse DCT differently. Strict `--lossless` detects that, discards the candidate, and says so.

### Which one you get

| Input | Result | Size | Exact? |
|---|---|--:|:--:|
| Flat artwork 400×300 | real geometry (contours) | 3.9 KB | ✅ |
| Pixel art 128×128 | real geometry (rectangles) | 0.6 KB | ✅ |
| `favicon.ico` 64×64 | real geometry (rectangles) | 0.5 KB | ✅ |
| BMP 400×300 | real geometry (contours) | 3.9 KB | ✅ |
| Photo 320×240 | embedded PNG | 230 KB | ✅ |

A photograph *can* be emitted as exact geometry, and `--prefer geometry` will do it — but it costs one rectangle per pixel, so that same photo becomes a 1.99 MB file of 42,933 shapes. It is vector in name only, so `auto` uses the bitmap and tells you the ratio it measured. Nothing is hidden.

## The honest version of "100% accuracy"

Most vectorizers claim perfect accuracy. Here is what is actually true, because it determines which tool you should use:

| Direction | Can it be exact? | Why |
|---|---|---|
| **SVG → raster** | **Yes**, at any resolution you name | Rendering is a well-defined computation. Ask for 4000px wide and you get exactly that, correct to the renderer's rasterisation rules. |
| **Raster → SVG, lossless** | **Yes** | Two different ways, both bit-exact. See `pixel` and `embed` below. |
| **Raster → SVG, traced into curves** | **No, and it never can be** | A photograph holds more independent information than any compact set of Bézier curves can encode. Tracing is approximation by definition. |

Anyone promising exact photo-to-curves vectorization is either embedding a bitmap and calling it vector, or is wrong. **Vecline does both exact conversions properly, does the approximate one well, and always tells you which one you got and how close it landed.**

## Three strategies, and when each is right

| Mode | Output | Exact? | Use it for |
|---|---|---|---|
| **`lossless`** | Real geometry, or an embedded bitmap | **Bit-exact, verified** | Anything, when exactness is non-negotiable |
| **`pixel`** | Real vector geometry (rectangles or contours) | **Bit-exact** | Logos, icons, pixel art, screenshots, diagrams, flat colour |
| **`trace`** | Real Bézier curves | Approximate, measured | Photos, complex art, anything you want to *scale* or *edit* |
| **`embed`** | Bitmap inside an SVG wrapper | **Bit-exact** | You need this exact image, in an SVG container |

`auto` (the default) inspects the image and picks between `pixel` and `trace`. `--lossless` overrides everything with the guarantee described above.

**`pixel` mode is the one people don't expect.** It produces genuine, editable, infinitely-scalable vector paths that rasterise back to your input with **zero** differing pixels — not "visually identical", literally identical. For flat artwork it is usually what you actually wanted.

## Install

```bash
npm install -g vecline        # the CLI
npm install vecline           # the library
```

Node.js 18.17+. The native dependencies ([sharp](https://sharp.pixelplumbing.com/), [resvg](https://github.com/yisibl/resvg-js)) ship prebuilt binaries for Linux, macOS and Windows.

### Any project architecture

| You want | Import | Native deps |
|---|---|:--:|
| The full Node toolkit | `import { vectorize } from 'vecline'` | yes |
| … from CommonJS | `const { vectorize } = require('vecline')` | yes |
| Just the vectoriser | `import { trace } from 'vecline/vectorize'` | **none** |
| Just the metrics | `import { compareImages } from 'vecline/metrics'` | **none** |
| Just the pure-TS codecs | `import { encodeBmp } from 'vecline/formats'` | **none** |
| Everything portable | `import { vectorizeExact } from 'vecline/core'` | **none** |
| Image editing (resize, rotate…) | `import { editImage } from 'vecline/ops'` | sharp only |
| Register a custom codec | `import { registerDecoder } from 'vecline/codecs'` | **none** |

Install only what you use. Every `none` subpath imports in isolation with the native codecs omitted (`npm install vecline --omit=optional`), and the package is `"sideEffects": false`, so a bundler drops everything you never import. `vecline/core` is the vectorisation and measurement engine with **zero dependencies and no Node built-ins**. It takes a plain `{ width, height, data }` — byte-for-byte the layout of the browser's `ImageData` — so canvas pixels go straight in:

```js
import { vectorizeExact } from 'vecline/core';

const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
const { svg } = vectorizeExact({ width, height, data });   // bit-exact, no codec needed
```

**The zero-dependency claim is CI-asserted, not stated.** Every commit bundles `vecline/core` for a browser with esbuild — no Node platform, no externals — and fails if a single `node:` specifier or Node global survives into the output. It comes to **96 KB minified**, with a size tripwire either side so nothing large can arrive unnoticed. Reading the import graph would only prove that the imports we can see are clean; bundling proves the thing users actually do works.

Install without the optional native packages (`npm install vecline --omit=optional`) and core still works, at **2 MB instead of ~100 MB**. Reading image files, rendering SVG back to pixels, and the verified lossless guarantee all need real codecs, so those live in the main entry point.

The BMP, ICO, PNM and TGA codecs are written from scratch in this package, so they work in core too — no libvips required to read or write any of them.

## Formats

| | Read | Write |
|---|:--:|:--:|
| **PNG** | ✅ | ✅ |
| **JPEG** | ✅ | ✅ |
| **WebP** | ✅ | ✅ lossy + lossless |
| **AVIF** | ✅ | ✅ lossy + lossless |
| **TIFF** | ✅ | ✅ |
| **GIF** | ✅ first frame | ✅ |
| **BMP** | ✅ all depths, RLE, BITFIELDS | ✅ 24/32-bit |
| **ICO / CUR** | ✅ largest entry | ✅ PNG or DIB payload |
| **PNM** (PBM/PGM/PPM) | ✅ P1–P6 | ✅ P4/P5/P6 |
| **TGA** | ✅ RLE, colour-mapped | ✅ RLE optional |
| **SVG** | ✅ | ✅ |

**The matrix is square: every format it reads, it writes.** That is 11 × 11 = **121 conversions**, and the test suite runs all of them on every commit — PNG→TGA, ICO→WebP, TGA→SVG, SVG→BMP, whatever you need. Every cell is reachable from one command:

```bash
vecline convert photo.png thumb.webp   # raster → raster
vecline convert logo.png logo.svg      # raster → vector
vecline convert logo.svg logo@2x.png   # vector → raster
```

`convert` decides from the input bytes *and* the output extension, not the extension alone — a file named `.txt` that contains `<svg>` is treated as an SVG, and a `.svg` that contains PNG bytes is not.

BMP, ICO, PNM and TGA are decoded in pure TypeScript — libvips is not built with them, and each is simple and stable enough to implement completely rather than adding another native dependency. All four are lossless formats, so the test suite asserts **bit-exact** decoding rather than approximate agreement.

**Not built in:** HEIC, JPEG XL, JPEG 2000, PSD, PDF and camera RAW. The prebuilt libvips that ships with `sharp` cannot read or write them — HEIC because HEVC is patent-encumbered, JXL and JP2 because they simply are not compiled in (verified: `heifsave: Unsupported compression`, `jxlsave_buffer not found`, `JP2 output requires OpenJPEG`). Bundling a WASM codec for each would add tens of megabytes to *every* install, for formats most users never touch.

**But you can plug one in.** Rather than ship the codecs, Vecline ships the socket. Install a WASM decoder yourself and register it, and that format then reads and writes everywhere any built-in format does:

```ts
import decodeJxl from '@jsquash/jxl/decode.js';
import { registerDecoder } from 'vecline/codecs';

registerDecoder({
  format: 'jxl',
  canDecode: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0x0a, // JXL signature
  decode: async (bytes) => {
    const { data, width, height } = await decodeJxl(bytes);
    return { width, height, data: new Uint8ClampedArray(data.buffer) };
  },
});
// vecline can now vectorize, convert, and edit .jxl files.
```

Everyone who does not need it pays nothing. For a one-off, converting via ImageMagick or `libheif` first is still the simplest path.

## Quick start

```bash
# Convert, letting vecline choose the strategy
vecline vectorize logo.png

# Prove the result is what it claims
vecline vectorize logo.png --verify

# Guarantee a bit-exact result whatever the input, or fail
vecline vectorize photo.jpg --lossless

# Trace to curves, escalating settings until it hits a quality target
vecline vectorize portrait.jpg --target-ssim 0.95

# SVG back to raster at any size
vecline rasterize logo.svg -o logo@4x.png --scale 4
vecline rasterize logo.svg -o hero.webp --width 2400 --lossless

# Ask what a file is and what to do with it
vecline info photo.jpg

# Measure any two images against each other — raster or SVG, in any combination
vecline verify original.png result.svg

# Whole directories
vecline batch 'assets/**/*.png' -o dist/ --to svg
```

## Transparent output

`--transparent` removes a solid background and leaves real transparency behind:

```bash
vecline vectorize logo.png --transparent             # detect the background colour
vecline vectorize logo.png --transparent '#ffffff'   # or name it
vecline rasterize icon.svg -o icon.png --transparent
```

Two details make this safe rather than destructive:

- **It flood-fills from the edges.** Removing "every white pixel" also punches holes through the whites *inside* a logo — the glint in an eye, the counter of an `o`. Only colour reachable from the border is background. `--bg-everywhere` opts into the blunt global version.
- **Tolerance is perceptual.** A JPEG's white is never exactly `#ffffff`, and an RGB threshold loose enough to catch it also eats pale yellows. `--bg-tolerance` is an Oklab distance, so "slightly off-white" and "a genuinely different colour" stay on opposite sides of the line. `--feather` softens the cut.

Available in core too, so it works in a browser: `removeBackground(image, { tolerance: 0.02 })`.

## Accuracy, measured

Every number below is produced by `--verify`: the generated SVG is rendered back to pixels and compared against the source. Reproduce them with `npm run bench`.

| Input | Mode | In | Out | Pixels exact | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|--:|--:|
| Flat artwork, 400×300 | `pixel` | 2.1 KB | 7.5 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Pixel art sprite, 128×128 | `pixel` | 0.5 KB | 0.6 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Flat artwork, 400×300 | `embed` | 2.1 KB | 3.2 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Photo, 320×240 | `embed` | 14.5 KB | 19.7 KB | 87.94% | 58.04 dB | 0.9982 | 0.060 |
| Photo, 320×240 | `trace` (`auto` and `--preset photo` alike) | 14.5 KB | 49.3 KB | 0.01% | 31.31 dB | 0.8476 | 2.931 |
| Flat artwork, 400×300 | `lossless` → `pixel` | 2.1 KB | 3.9 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Pixel art sprite, 128×128 | `lossless` → `pixel` | 0.5 KB | 0.6 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Photo, 320×240 | `lossless` → `embed` | 14.5 KB | 230.5 KB | **100.00%** | **∞** | **1.0000** | **0.000** |

> The traced photo row moved from 52.9 KB to 49.3 KB, and every accuracy figure on
> it is unchanged to the digit. Closed polygons were re-stating their closing edge
> before the `z` that already draws it — `z` returns to the subpath's initial point
> by definition, so the explicit return leg only gave it a zero-length gap to
> cover. Removing it dropped **16.9% of all path commands** across the corpus with
> **0 differing subpixel channels** out of ~40 million, at two magnifications, with
> and without strokes.

Two rows deserve comment, because glossing over them is how tools mislead you:

- **Photo + `embed` is not 100% exact**, even though the original JPEG bytes are preserved *verbatim* inside the SVG. The residual (max 3/255 per channel) is the SVG renderer's JPEG decoder rounding its inverse DCT differently from the reference decoder. No data was lost; two decoders simply disagree in the last bit. Vecline reports the measurement, not the claim.
- **Photo + `trace` is genuinely approximate.** 0.01% pixels exact is not a bug — it is what tracing a photograph means. If that number matters to you, you want `embed`.

## Compared with other vectorizers

> **On speed, and why this table has no Time column.** `scripts/compare.mjs` records a
> per-tool `ms` and prints it; these tables drop it, and that omission flattered us. Measured
> min-of-5 cold processes, PNG in to SVG on disk, vecline is **slower than imagetracerjs on
> every fixture** — 1.10× to 1.55× — and **4.08× slower than vtracer** on a small logo
> (280 ms against 69 ms), where ~83 ms of ours is Node loading the module graph before any
> work starts. On the two heavier photographs vecline is faster in wall clock than vtracer
> (portrait 1001 ms vs 1386, motorcycles 1160 vs 1970) while also scoring higher.
>
> The `ms` column is deliberately left out of the tables rather than published misleadingly:
> the harness times `produce()`, but the work inside differs per entrant — vecline pays a
> full PNG encode *and* decode inside the timed window, imagetracerjs is handed raw pixels
> and pays no codec at all, and vtracer pays a process spawn. Fixing that methodology is
> tracked; until then the numbers above are the honest summary and `npm run compare` will
> print the raw column for anyone who wants it.

Run it yourself with `npm run compare`. Every tool's SVG is rendered with the **same** renderer and scored with the **same** metrics, on the same white ground, so nothing here depends on Vecline's own view of quality. The field is potrace, imagetracerjs, and — the strongest modern open-source rival — **vtracer** (VisionCortex, Rust). Point `VECLINE_VTRACER` at [vtracer's released binary](https://github.com/visioncortex/vtracer/releases) to score the tool its authors actually ship; failing that the harness falls back to the `@neplex/vectorizer` binding, and if neither is present the row is simply absent rather than guessed at.

**Synthetic fixtures** — reproducible without licensing anyone's photographs:

| Fixture | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|
| **Bilevel** | potrace | 1.5 KB | 24.67 dB | 0.9511 | 0.702 |
| | imagetracerjs | 1.7 KB | 19.75 dB | 0.8607 | 1.667 |
| | **vecline (auto)** | **1.4 KB** | **∞** | **1.0000** | **0.000** |
| **Colour art** | potrace posterize | 1.9 KB | 14.61 dB | 0.8010 | 21.302 |
| | imagetracerjs | 1.6 KB | 26.56 dB | 0.9363 | 0.662 |
| | vtracer | **1.2 KB** | 27.88 dB | 0.9490 | 0.582 |
| | **vecline (auto)** | 1.8 KB | **∞** | **1.0000** | **0.000** |
| **Photo** (gradient + noise) | potrace posterize | 11.5 KB | 13.19 dB | 0.6024 | 23.911 |
| | imagetracerjs | 11.8 KB | 26.85 dB | 0.7143 | 5.623 |
| | vtracer | 42.7 KB | **32.53 dB** | **0.7979** | 3.049 |
| | **vecline (auto / photo)** | 19 KB | 31.12 dB | 0.7750 | **2.940** |
| | **vecline lossless** | 43.7 KB | **∞** | **1.0000** | **0.000** |

**Real photographs** — the Kodak set at 480px, the test that actually matters. `vecline (auto)` is the **zero-config default**: `vecline convert photo.png out.svg`, which scales the palette to the content on its own.

| Photo | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|
| **Portrait** (skin, soft) | imagetracerjs | 1621 KB | 25.47 dB | 0.7093 | 5.957 |
| | vtracer | **987 KB** | 25.88 dB | 0.7652 | 4.743 |
| | **vecline (auto)** | 1338 KB | **34.80 dB** | **0.9140** | **2.663** |
| **Lighthouse** (sky) | imagetracerjs | 2010 KB | 24.58 dB | 0.7465 | 4.900 |
| | vtracer | **1032 KB** | 24.25 dB | 0.7624 | 5.665 |
| | **vecline (auto)** | 1743 KB | **36.26 dB** | **0.9453** | **2.575** |
| **Parrots** (fine detail) | imagetracerjs | 301 KB | 25.81 dB | 0.7615 | 6.317 |
| | vtracer | 344 KB | 23.17 dB | 0.7949 | 7.728 |
| | **vecline (auto)** | **309 KB** | **31.18 dB** | **0.8460** | **3.686** |

**Bilevel** and **colour art** are bit-exact for vecline (SSIM 1.0000), against potrace's and imagetracerjs's approximations and, on colour art, vtracer's 0.9490 — in a smaller or comparable file.

> **Both of those fixtures are synthetic**, and for a long time this section rested on them alone. Real flat artwork is added below because the story is genuinely different there, and worse for us in one direction.

**Real flat artwork** — this project's own corpus images, now part of `npm run compare` so these rows are produced by the same harness, renderer and metrics as every other table here.

| Fixture | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|
| **logo-tux** (real logo) | potrace posterize | **7.7 KB** | 14.41 dB | 0.7649 | 6.146 |
| | imagetracerjs | 59.8 KB | 24.17 dB | 0.8861 | 1.975 |
| | vtracer (cli) | 64.0 KB | 23.51 dB | 0.8907 | 1.517 |
| | **vecline `--preset logo`** | 53.4 KB | **26.43 dB** | **0.9032** | **1.073** |
| | **vecline (auto)** | 25.8 KB | **∞** | **1.0000** | **0.000** |
| | **vecline lossless** | **24.0 KB** | **∞** | **1.0000** | **0.000** |
| **alpha-dice** (real, alpha) | potrace posterize | **11.1 KB** | 11.69 dB | 0.6857 | 14.690 |
| | imagetracerjs | 72.1 KB | 26.05 dB | 0.8685 | 2.108 |
| | vtracer (cli) | 167.8 KB | 20.90 dB | 0.8577 | 3.213 |
| | **vecline `--preset logo`** | 139.9 KB | 28.39 dB | 0.8823 | **1.682** |
| | **vecline (auto)** | 189.1 KB | **35.85 dB** | **0.9537** | 0.862 |
| | vecline lossless | 209.6 KB | **∞** | **1.0000** | **0.000** |

Three honest readings, and they do not all point the same way.

**On a real logo, bit-exact is also smallest.** `lossless` returns 24.0 KB at `SSIM 1.0000` — a third of what imagetracerjs and vtracer spend to be *approximate*. That is the flat-artwork headline, and it holds. But it holds because the image is cheaper to encode exactly than to approximate, and vecline recognises that and emits an exact copy — **not** because the curve fit is better. Ask for curves and you get the row above it.

**`--preset logo` leads on quality, and the margin is narrower than a synthetic fixture suggests.** +2.9 dB and +0.013 SSIM over vtracer on logo-tux with a third less colour error, in a *smaller* file (53.4 KB against 64.0). On alpha-dice it leads on all three quality axes at 17% less than vtracer. Good, but not the 15–19 dB gap the synthetic fixtures imply — `logo` quantises to 16 colours, and on real artwork that costs more than it does on a four-colour test pattern.

**potrace is far smaller than everyone, and that is a real trade.** 7.7 KB against our 24–53. It is bilevel by design and its colour numbers are poor (SSIM 0.7649, ΔE 6.1), but if a few kilobytes matter more than colour fidelity it wins on size and this table should say so.

**The synthetic photo** — a pure gradient plus noise — is vtracer's best case, and it takes the SSIM with fine colour-precision tracing. vecline reaches 0.7750 at **under half the file size** (19 KB vs 42.7 KB) and comfortably beats imagetracerjs (0.7143). More colours would close the last gap; it is not worth 2.2× the bytes on a synthetic worst case.

> This row moved in v1.33.1, and downwards, so it is worth saying why. The `photo` preset used to score 0.7923 here — but `npm run compare` showed the same preset scoring *below plain auto on every real photograph*, and taking up to 136 seconds to do it, because it forced a despeckle threshold that erases the fine detail photographs are made of. Fixing that cost ~0.017 SSIM on this one synthetic fixture and gained **+0.25 SSIM at ~75× the speed** on the Kodak set below. A gradient-plus-noise pattern is not a photograph, and where the two disagree the real photographs win. `photo` and `auto` now resolve to the same measured-best configuration, so they are reported as one row.

**On real photographs vecline is ahead on every quality axis — out of the box, against every rival's out of the box.** Auto mode scales the palette to the content, so the zero-config default **leads SSIM on every photo by 0.05–0.18**: 0.9140 / 0.9453 / 0.8460 against vtracer's 0.7652 / 0.7624 / 0.7949 and imagetracerjs's 0.7093 / 0.7465 / 0.7615 — with far better PSNR (34.8 / 36.3 / 31.2 dB against 25.9 / 24.3 / 23.2) and roughly half the colour error. The synthetic-worst-case story does not survive contact with actual photographs.

**The comparison above is defaults against defaults, and that flatters us.** vtracer takes flags, and one documented preset changes the verdict on part of the table — same binary, same harness, same renderer and metrics:

| Fixture | vtracer setting | Size | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|
| kodak-parrots | `--preset poster` | 534 KB | 29.86 dB | **0.8643** | 2.560 |
| | *vecline (auto)* | *309 KB* | *31.18 dB* | *0.8460* | *3.686* |
| synthetic photo | `--preset poster` | 58 KB | **36.57 dB** | **0.8620** | **1.935** |
| | *vecline (auto)* | *19 KB* | *31.12 dB* | *0.7750* | *2.940* |
| all four colour fixtures | `-p 8 -g 4 --filter-speckle 0` | 4–5× the bytes | — | — | **beats vecline on every one** |

So: `--preset poster` **beats us on kodak-parrots SSIM** (0.8643 vs 0.8460) and sweeps the synthetic photo on all three quality axes. And `--color-precision 8 --gradient-step 4 --filter-speckle 0` beats our colour error on all four colour fixtures — at 4–5× the bytes and ~2.4× the time, which is the counter-trade. Our SSIM lead survives on the portrait and lighthouse and only barely against that last configuration (0.9140 vs 0.9099; 0.9453 vs 0.9074).

None of that is tuning we could not also do; the point is that "leads every one of them" was measured against tools nobody had tuned, and a reader comparing honestly will tune them.

**And the honest counterpart: vtracer's files are smaller on two of the three.** 987 KB against vecline's 1338 on the portrait, 1032 against 1743 on the lighthouse; vecline is smaller only on parrots (309 vs 344). Those bytes buy the quality above — ~10 dB of PSNR is not a rounding error — but if size is what you are optimising for and 0.76 SSIM is enough, vtracer wins that trade and this table should not pretend otherwise.

> **These numbers moved, downwards for us, in v1.38.1.** The vtracer rows were previously measured through [`@neplex/vectorizer`](https://www.npmjs.com/package/@neplex/vectorizer), a third-party napi binding. They are now measured against **vtracer's own released binary** (1.0.0-alpha.3, defaults, no tuning), which produces *substantially smaller files at the same quality* — 987 KB where the binding produced 1661 KB. The earlier table therefore claimed vecline wrote "a smaller or comparable file every time", and against the tool vtracer actually ships, that was **false**. Run `VECLINE_VTRACER=/path/to/vtracer npm run compare` to reproduce.

**Gradient output** (`--gradients`, and on by default in auto mode for photos) reconstructs smooth colour ramps — skies, skin — as SVG gradients instead of flat bands. Both **`<linearGradient>`** (a directional ramp) and **`<radialGradient>`** (a vignette, a round highlight, a spotlight) are fit per region and the one that renders closer is kept — a radially-symmetric ramp has no linear direction at all, so it is fit from the region centroid outward by distance. On a synthetic vignette that is a **0.998 SSIM reconstruction in ~350 bytes** where the flat bands take 3–8 KB at 0.73–0.88. It **can only help**: a region becomes a gradient only when the gradient's *actual rendered output* (the renderer's sRGB stop interpolation, reproduced and scored per pixel in Oklab) beats the flat bands it would replace, so flat art stays byte-for-byte identical and hard edges are untouched — a concentrated de-banding win, never a regression.

**Geometric primitives** (`--primitives`) do the opposite kind of clean-up: when a region genuinely *is* a circle, ellipse, rectangle, **rounded rectangle** (the workhorse UI/icon shape — `<rect rx>`), or a **sector** (a pie slice or a donut segment — the shape every chart is made of), vecline emits the true primitive instead of a four-curve Bézier approximation. On a plain disc that is a **68% smaller file** (a 42-px circle is `<circle cx="60" cy="60" r="42">`, not a path); a four-slice pie chart goes from **2323 bytes of Bézier to 488 bytes of real arcs**. Unlike every other JS tracer, the shape stays *editable as a shape* in Illustrator/Inkscape and becomes a true arc for CAD/DXF export. The swap is residual-gated: a region is only replaced when its boundary lies within `--primitive-error` pixels (default 1.0) of the fitted shape, never an organic blob rounded into a circle. `detectPrimitive()` is pure and in `vecline/core`.

The `<rect>` is genuinely render-identical. The curved primitives — `<circle>`, `<ellipse>` and the sector — are a measured *trade*, not render-preserving: an ideal arc cannot follow a pixel staircase exactly, so it gives up ~0.02 SSIM against the source raster in return for geometry a fraction of the size that a CAD tool can read as an actual arc. Sectors are recognised per region rather than per colour, so a pie chart whose slices reuse their colours in a legend still traces as arcs; below a ~0.6-radian sweep or a ~15-px radius the fitter declines and falls back to a Bézier path, so it fails safe.

**The numbers** (`npm run bench:features` reproduces them — every figure is the SVG rendered back to pixels and scored, never asserted):

| Case | Baseline (SSIM / size) | vecline feature (SSIM / size) |
|---|---|---|
| radial gradient · vignette · 8 colours | 0.7887 / 4.5 KB | **0.9646 / 759 B** |
| radial gradient · vignette · 12 colours | 0.8745 / 7.9 KB | **0.9977 / 356 B** |
| radial gradient · vignette · 16 colours | 0.9193 / 10.2 KB | **0.9977 / 356 B** |
| primitive · disc → `<circle>` | 1.0000 / 681 B | 0.9897 / **182 B** |

The gradient rows are *both* far more accurate **and** an order of magnitude smaller than the flat bands they replace; the primitive row trades a sub-2% render difference for a 73%-smaller, editable-as-a-shape file.

> **How the photo result got here.** An earlier version trailed imagetracerjs on the synthetic photo and the cause was, honestly, unknown. `scripts/diagnose-photo.mjs` decomposed the pipeline and found it: the curve fitter, not quantisation, was the dominant loss (0.11–0.24 SSIM), and a 1px fitting tolerance was *strictly worse* than 0.4 on both accuracy and file size. Retuning the default closed most of the gap. The diagnosis script is kept so the next such claim is measured, not guessed.

Two caveats. potrace is *bilevel by design*; its colour rows use `posterize`, a bolt-on, and reporting them without saying so would be a rigged fight. And the strongest *commercial* tracers (Illustrator Image Trace) and AI vectorisers remain unmeasured — vecline is best-in-class here against the installable open-source field, not proven against everything.

**On tuning knobs, not just accuracy.** Beyond the numbers, vecline now carries the controls each of these tools is known for: potrace's `--threshold`/`--black-on-white` bilevel mode with Otsu auto-thresholding, its six `--turn-policy` modes for diagonal self-touches, and its `--fill-strategy` (`mean`/`dominant`/`median`); imagetracerjs's edge-preserving `--blur`, `--stroke-width` seam hiding, and `--right-angle` corner snapping (generalised here from an exact test to a tolerance, so it also rectifies corners quantisation left a degree or two off); `--gradients` output that neither potrace nor imagetracerjs offers at all; and sharp's editing pipeline behind `vecline edit` and the `vecline/ops` entry point. The one thing deliberately *not* copied is potrace's histogram `rangeDistribution` for greyscale posterising — vecline's Wu + Oklab-Lloyd quantiser is a strictly better default, and `--fill-strategy` already exposes the representative-colour choice for callers who want it.

## Metrics

`--verify` reports the standard full-reference measures, computed the way their literature defines them so the values are comparable against other tools:

- **PSNR** — peak signal-to-noise ratio in dB. `∞` exactly when the images are bit-identical.
- **SSIM** — [Wang et al. 2004](https://ece.uwaterloo.ca/~z70wang/publications/ssim.html), Gaussian-weighted 11×11 window, σ=1.5, `valid` convolution (border pixels excluded rather than padded, matching the reference implementation and scikit-image).
- **CIEDE2000** — mean, p95 and max colour difference. Validated against all 34 pairs of the [Sharma, Wu & Dalal](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/) test set, which exists specifically to catch the hue-angle discontinuities that most implementations get wrong.
- **Pixels exact** — the fraction matching on all four channels.

Comparisons default to **premultiplied** alpha, because colour stored beneath a fully transparent pixel is invisible: two images that render identically must measure identically. Use `--alpha-mode straight` to compare raw stored bytes instead.

### Measure any tracer, including someone else's

`verify` and `diff` are not vecline-only. They take **any** SVG from **any** producer and score it against a source raster — nothing in the path knows or cares which tool wrote the file:

```bash
# Score another tool's output. Most tracers emit a transparent ground, so give
# it the colour the artwork was meant to sit on, or every transparent pixel
# counts as a difference.
vecline verify source.png their-output.svg --render-background '#ffffff'

# As a CI gate: exit code 2 if it misses the bar.
vecline verify source.png their-output.svg --render-background '#ffffff' --fail-under 0.98
```

That flag is not a detail. On one 200×200 disc the *same artwork* scores **29.92 dB** with a white ground and **2.12 dB** without one, so a comparison run without it does not measure a rival tracer, it measures whether they happened to emit a background rect. Vecline warns when it detects the mismatch rather than letting the number stand.

`--json` emits a stable object — `psnr`, `ssim`, `ssimLuma`, `rmse`, `exactRatio`, `deltaE{mean,p95,max}`, `maxChannelDiff`, `lossless`, plus dimensions — so a script can gate on any of them. Exit codes are `0`, `1`, `2` as documented in `--help`.

For a full head-to-head against potrace, imagetracerjs and vtracer on a shared corpus, `npm run compare` in a clone of this repo runs the whole panel; `node scripts/fetch-corpus.mjs` fetches the images with their provenance and licences recorded.

**Enter your own tracer.** The scoring was always tool-agnostic; the entrant list was not. Pass a command and it joins every panel, measured exactly like the rest:

```bash
npm run compare -- --tool "mytracer=/path/to/bin --input {in} --output {out}"
```

`{in}` receives a PNG, `{out}` is where the SVG is expected, and the flag is repeatable. The exact command is printed above the table, because a comparison is a claim about someone else’s software and the reader should be able to check how it was invoked.

## How it works

### `pixel` — exact geometry from flat artwork

Greedy meshing decomposes each colour region into maximal rectangles: extend right while the colour holds, then extend down while the whole span still holds. All rectangles of one colour go into a **single** `<path>`.

Both details are load-bearing for the exactness guarantee:

- Every rectangle has **integer corners on the pixel grid**, so an antialiasing rasteriser computes coverage of exactly 1.0 inside and exactly 0.0 outside. There is no partial coverage to round.
- Coverage accumulates across a path *before* compositing, so abutting rectangles within one path cannot produce the hairline seams you get from separate elements.

### `trace` — curves from anything

```
quantise → segment → trace contours → fit curves
```

1. **Colour quantisation.** [Wu's algorithm](https://gist.github.com/bert/1192520) builds 3-D colour moments on a 32³ grid and splits the box whose split buys the largest variance reduction — deterministic, no random seeding. Then Lloyd relaxation in **Oklab** polishes the palette, because Wu minimises variance in sRGB where equal numeric distances are not equally visible. Alpha is clustered separately in 1-D, so a soft edge does not cost you colour slots.
2. **Segmentation.** Two-pass union-find connected components, 4-connectivity.
3. **Contour extraction** by **crack following** — walking the boundaries *between* pixels rather than pixel centres. Every vertex lands on an integer lattice point, so the unsimplified polygon rasterises back to the original mask bit for bit, with no half-pixel bias.
4. **Curve fitting.** Douglas–Peucker finds the structurally important vertices, corner detection separates genuine sharp features from gentle bends, and [Schneider's least-squares algorithm](https://dl.acm.org/doi/10.5555/90767.90941) fits cubic Béziers to the **original** lattice points between corners — the simplified outline decides only *where* to break, and is never used as the data.

Same-coloured regions share one `<path>` with `fill-rule="evenodd"`. Because each region's path carries the boundaries of whatever it encloses, a region never paints over its own holes and nesting resolves correctly regardless of draw order.

### Size budgets, with a receipt

"Traced SVGs are too big" is the loudest complaint every vectorizer gets, and the usual answer is an opaque simplify slider that never tells you what it cost. Vecline already renders its own output and scores it, so a budget can come with a **receipt**:

```bash
vecline vectorize logo.png --max-bytes 40KB
```

```
Budget  met  in 3 steps
  size        92.0 KB → 38.4 KB (-58%)  target 39.1 KB
  accuracy    0.9994 → 0.9971  −0.0023 SSIM paid
```

The search relaxes in *stages*, cheapest lever first: it coarsens the curve fit, then rounds coordinates, and only sacrifices whole features or palette entries once those continuous levers are exhausted. The order matters for more than accuracy — a structural lever is *discontinuous* (dropping a colour can halve the file in one jump), so leading with the smooth levers is what lets a plain bisection actually land on a target instead of overshooting past it into the next cliff. You get the **most accurate result that still fits**, not the first one that happens to. `--max-nodes` targets anchor-point count instead, which is what an illustrator feels when editing; the two are separate because they don't move together (rounding coordinates cuts bytes without removing a node). If a budget is below what the levers can reach, it says so and returns the closest real result rather than pretending to have hit it.

### `--extend-under` — one boundary instead of two

Regions are painted largest-first, so by the time a small shape is drawn the large one beneath it is already down. That means a region's fill does not have to stop at a shared edge — it can run on underneath, and **the render is unchanged, because the later region repaints those pixels**.

```bash
vecline vectorize chart.png --extend-under
```

Two things follow. A boundary shared by two regions is normally traced *twice*, once as each one's edge; here it is traced once. And the hairline seam antialiasing can leave between two abutting shapes cannot appear, because there is no longer a join for it to open at — this is what `--stroke-width` exists to paint over.

It is **off by default, and the reason is measured rather than assumed**:

| Fixture | Size change | Render |
|---|--:|---|
| Flat artwork | **−28.3%** | identical |
| Small logo | +100.6% | identical |
| Parrots (photo) | +125.8% | identical |
| Lighthouse (photo) | +128.9% | identical |

The render is bit-identical every time — `vecline verify a.svg b.svg` reports `PSNR ∞`, `SSIM 1.000000` — so this is purely a size and seam trade. It wins clearly on flat artwork with few, large colour fields, and loses badly when the later colours are scattered, because then the union it traces is more complex than the region it replaced. Measure it on your own images rather than switching it on globally.

### `--target-ssim` / `--target-psnr`

Trace, render, measure, and escalate until the target is met. Each step doubles the palette *and* tightens the geometric tolerances, because the failure modes are different — too few colours shows up as banding, too loose a tolerance as rounded-off detail. The best attempt is kept, so an unreachable target still returns the closest result along with a note saying it fell short.

## CLI

### `vecline vectorize <input>`

| Option | Description |
|---|---|
| `-o, --output <file>` | Output path (default `<input>.svg`) |
| `-l, --lossless` | guarantee a bit-exact result, or fail |
| `-t, --transparent [color]` | remove the background; detects the colour when omitted |
| `--bg-tolerance <n>` | how far a pixel may sit from the background colour (Oklab distance) |
| `--bg-everywhere` | remove matching pixels anywhere, not only from the edges inward |
| `--feather` | fade the cut instead of a hard edge |
| `--prefer <what>` | `auto` (default), `geometry`, `size` — what lossless optimises for |
| `--max-geometry-ratio <n>` | how much larger real geometry may be under `--prefer auto` (default 4) |
| `-m, --mode <mode>` | `auto`, `lossless`, `pixel`, `trace`, `embed` |
| `-p, --preset <preset>` | `logo`, `lineart`, `poster`, `photo`, `detailed`, `pixelart`, `exact` |
| `-c, --colors <n>` | Palette size, 1–256 |
| `--alpha-levels <n>` | Distinct alpha levels to preserve |
| `--min-area <px>` | Absorb regions smaller than this into their neighbours |
| `--tolerance <px>` | Outline simplification tolerance |
| `--fit-error <px>` | Maximum curve fitting error |
| `--corner-angle <deg>` | Turn angle treated as a sharp corner |
| `--polygon` | Emit polygons instead of curves |
| `--threshold <cutoff\|auto>` | Reduce to two colours by luminance before tracing (potrace-style bilevel; `auto` = Otsu) |
| `--black-on-white <bool>` | With `--threshold`: dark pixels are the shape (default true) |
| `--speckle-scope <all\|isolated>` | Which small regions `--min-area` may absorb. `all` (default) takes every one under the cutoff; `isolated` takes only specks surrounded by a single colour and spares antialiasing fringe. Measured on logo-tux: only 40.2% of sub-8px components are isolated, the rest are fringe — so `isolated` saves size at twice the fidelity efficiency (0.00041 SSIM/KB vs 0.00086), and on a JPEG-artifact photo it is 0.8657 SSIM against `all`'s 0.5488 |
| `--severity` | With `--verify`: also report *where* the error is. SSIM, PSNR and mean ΔE are global aggregates and cannot separate a harmless dusting of antialiasing along every edge from one solid wrong region — averaged over a megapixel they score alike. Differing pixels are opened to remove one-pixel filaments, clustered, and scored by summed squared area so a coherent blob outweighs scattered dust. Adds a `Composite`: a geometric mean over accuracy, structure and coherence, so no strong axis carries a collapsed one |
| `--adaptive` | Threshold against each pixel's own neighbourhood (Bradley–Roth) rather than one cutoff for the frame. For a photograph of paper, where one corner is in shadow and no global number serves both ends: on a page whose ink sits a constant 35% below its *local* paper, Otsu scores F1 26.4% (it floods the shadowed half) and this scores 100%. Also on `centerline` and `gcode`, where it matters most. Off by default — on evenly-lit art Otsu is the better estimator |
| `--adaptive-window <px>` | Neighbourhood side for `--adaptive`; 0 (default) is an eighth of the shorter side |
| `--adaptive-t <pct>` | How far below the local mean counts as ink (default 15) |
| `--blur <1-5>` | Selective, edge-preserving blur before quantising — removes grain without softening edges |
| `--blur-delta <n>` | Edge-preservation threshold for `--blur` (default 20) |
| `--stroke-width <n>` | Stroke each path in its own fill colour to hide seams between regions |
| `--turn-policy <p>` | Resolve diagonal self-touches: `left` (default), `right`, `black`, `white`, `minority`, `majority` (potrace's `turnPolicy`) |
| `--fill-strategy <how>` | How each palette colour is chosen from its cluster: `mean` (default), `dominant`, `median` (potrace's `fillStrategy`) |
| `--right-angle` | Snap near-axis right-angle corners to exact 90° — crisper UI, screenshots, pixel art (imagetracerjs's `rightangleenhance`) |
| `--right-angle-threshold <deg>` | Degrees of slack for `--right-angle` (default 12) |
| `--gradients` | Reconstruct smooth colour ramps (skies, skin, brand artwork) as SVG gradients. Accepted only where the ramp is a measurably accurate fit *and* replaces more bands than it costs — a fair comparison against the multi-band flat alternative, not a raw error contest the simpler model could never win |
| `--primitives` | Recognise circles, ellipses, rectangles, rounded rectangles and sectors (pie/donut) and emit the true shape — smaller, editable, a real arc for CAD |
| `--primitive-error <px>` | Per-vertex residual budget for `--primitives` (default 1.0) |
| `--layers` | Emit one named Inkscape/Illustrator **layer** per colour — editable, screen-print/vinyl separation-ready |
| `--palette <colors>` | Trace to exactly these comma-separated colours (brand/spot colours), e.g. `"#fff,#e4002b,#000"` |
| `--no-optimize` | Do not merge adjacent curves that a single curve fits |
| `--opt-tolerance <n>` | Error budget for a curve merge |
| `--refine-iterations <n>` | Lloyd relaxation passes during palette construction |
| `--precision <n>` | Decimals kept in path coordinates |
| `--no-background` | Do not collapse the dominant colour into one rectangle |
| `--target-ssim <v>` / `--target-psnr <db>` | Escalate until the target is reached |
| `--max-bytes <size>` | **Size budget** — relax until the SVG fits (`40KB`, `1.5MB`, or plain bytes), and report the accuracy it cost |
| `--max-nodes <n>` | **Complexity budget** — relax until the geometry has at most this many anchor points |
| `--verify` | Render the result and measure it against the input |
| `--embed-strategy <s>` | `auto`, `preserve`, `png`, `webp` |
| `--xlink` | Use `xlink:href` for SVG 1.1 consumers |
| `--json` | Machine-readable output on stdout |

### `vecline rasterize <input.svg>`

| Option | Description |
|---|---|
| `-o, --output <file>` | Output path (default `<input>.png`) |
| `-w, --width` / `-h, --height` / `-s, --scale` | Output size |
| `--dpi <n>` | Resolution for physical units (`mm`, `pt`, `in`) |
| `-b, --background <color>` | Paint under the artwork; `#rgb`, `#rrggbbaa`, `rgb()`, or a name |
| `-f, --format <fmt>` | `png`, `jpeg`, `webp`, `avif`, `tiff`, `gif` |
| `-q, --quality <n>` | Lossy encoder quality |
| `--lossless` | Lossless WebP/AVIF |
| `--shape-rendering <mode>` | `geometricPrecision` (default), `crispEdges`, `optimizeSpeed` |
| `--font-dir <dir...>` / `--default-font <family>` | Font resolution for `<text>` |
| `--verify` | Re-decode the encoded file and report what the encoder cost |

`--verify` on `rasterize` measures the **encoder**, which is the failure people actually hit — asking for a JPEG and silently losing the alpha channel, or a quality setting doing more damage than expected.

### Other commands

```bash
vecline edit photo.jpg -o small.png --resize 800x --grayscale  # resize, rotate, crop, tone
vecline crop photo.jpg -a 1:1 -o avatar.jpg    # content-aware crop — keeps the subject
vecline component logo.png -o Logo.tsx -f react --current-color # raster → typed component
vecline favicon logo.png -o public/    # full favicon/PWA set + manifest + <head> HTML
vecline responsive hero.jpg -o img/    # AVIF/WebP/fallback ladder + <picture> markup
vecline placeholder hero.jpg -f blurhash   # BlurHash string (or -f svg for a tiny LQIP-SVG)
vecline palette art.png --css          # perceptual palette as CSS custom properties
vecline extract keep.svg -o out.png --against original.png   # byte-identical recovery
vecline convert in.png out.svg      # direction inferred from input + extension
vecline convert photo.png thumb.webp   # …including plain raster → raster
vecline doc report.pdf -o pages/ --dpi 150   # PDF (or SVG) → one image per page
vecline office report.docx -o report.pdf     # Word/Excel/PPT ⇄ PDF (uses your LibreOffice)
vecline pdf page1.png page2.jpg -o album.pdf # combine images into one multi-page PDF
vecline centerline drawing.png -o strokes.svg  # single-stroke medial-axis paths
vecline gcode drawing.png --tool laser --feed 800   # ready-to-run laser/plotter G-code
vecline convert logo.png out.dxf --units mm --physical-width 80   # cuts at exactly 80 mm
vecline convert logo.png out.dxf    # CAD/CNC/laser vector export (also .eps, .pdf --cmyk)
vecline optimize icon.svg -o icon.min.svg   # render-preserving SVG minify
vecline sprite icons/*.svg -o sprite.svg    # pack many icons into one <symbol> sheet
vecline animate loading.gif -o loading.svg  # animated GIF/WebP → one CSS-animated SVG
vecline verify a.png b.svg          # measure any two images
vecline diff before.png after.png -o diff.png  # perceptual visual-regression heatmap
vecline batch 'src/**/*.png' -o out/ --to svg --summary "$GITHUB_STEP_SUMMARY"
vecline mcp                         # MCP server: expose vecline as tools to AI agents/IDEs
vecline serve                       # local bridge: let Vecline Studio use your LibreOffice
```

**`vecline serve` — Office conversion in the browser, without uploading anything.** A browser tab has no office engine, and there are only two usual ways to give it one: bundle a ~300 MB LibreOffice-in-WASM, or upload the document to somebody's server. The first destroys instant load; the second destroys the entire privacy claim. So neither. Run `vecline serve` and [Vecline Studio](https://vecline.xyz) hands the document to **your** machine and gets it back converted:

```bash
npm install -g vecline && vecline serve
```

The chain is local at every link — `.docx` → your LibreOffice → PDF → mupdf inside the tab → pixels → traced SVG, scored against those pixels.

**It was built to be attacked, then actually attacked.** The bridge binds **127.0.0.1 only**; accepts requests only from vecline.xyz or an origin you name with `--allow-origin`; answers Chrome's Private Network Access preflight only for those origins; refuses a rebound `Host`; caps one body at 64 MB and two conversions at once; and exposes exactly two endpoints that take *bytes and return bytes* — no request field anywhere names a file, so there is nothing to traverse. It runs only when you start it.

A four-agent adversarial review — each finding then independently re-tested against a live server — found no breached boundary and four hardening gaps, all fixed:

- A failed conversion used to return LibreOffice's raw error, which carries your temp paths, home directory and account name. Only messages written for a person are sent now; the detail stays on your console.
- Any loopback origin on any port used to be allowed, so *every* page served from localhost had full bridge access. Now only origins you name.
- Concurrency was unbounded — six concurrent 64 MB bodies took memory from 100 MB to 722 MB.
- `--token=` silently started with authentication off. It now refuses.

Prefer `--token-file <path>` or `VECLINE_TOKEN` over `--token`: an argument is readable from the process table by any local account, which is the one principal a token exists to fence out.

Running the Studio locally? Name your dev origin: `vecline serve --allow-origin http://localhost:5173`.

**Build-time.** A Vite/Rollup plugin vectorises assets in your build — import an image with a query suffix and get the vector back, no CLI step:

```ts
// vite.config.ts
import vecline from 'vecline/vite';
export default { plugins: [vecline()] };
```
```ts
import logo from './logo.png?svg';        // the traced SVG string
import Logo from './logo.png?component';  // a React/Vue/Svelte/Solid component
```

It returns the plain Vite/Rollup plugin object (no `unplugin` dependency), and the pure-TS core avoids the native-binary CI pain that sharp-based plugins carry.

**CI-native.** A **GitHub Action** vectorises/optimises your image assets on every push and writes a size-savings table straight to the job summary:

```yaml
- uses: shunyagatha/Vecline@v1
  with:
    files: 'assets/**/*.png'
    to: svg
```

It's a thin composite action over `vecline batch … --summary "$GITHUB_STEP_SUMMARY"`, so it inherits the pure-TS core's zero-native-binary install — no libvips to compile in CI. Run `vecline batch … --summary <file>` anywhere for the same Markdown report (per-file in/out sizes and signed savings).

**AI-native.** `vecline mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) so an AI agent or IDE — Claude, Codex, VS Code, Cursor, Continue — can call vecline directly: *"vectorise this logo"*, *"turn this drawing into laser G-code"*, *"how close is this SVG to the PNG?"*. Twelve tools (`vectorize`, `convert`, `centerline`, `measure`, `diff`, `crop`, `doc_to_images`, `office_convert`, `images_to_pdf`, `palette`, `placeholder`, `image_info`), a dependency-free JSON-RPC implementation that adds nothing to the install. Point your client's MCP config at `{ "command": "npx", "args": ["vecline", "mcp"] }`:

```jsonc
// Claude Desktop: claude_desktop_config.json — Cursor, Windsurf and Continue take the same shape
{
  "mcpServers": {
    "vecline": { "command": "npx", "args": ["-y", "vecline", "mcp"] }
  }
}
```

```jsonc
// VS Code: .vscode/mcp.json (workspace) — note the key is "servers", not "mcpServers"
{
  "servers": {
    "vecline": { "type": "stdio", "command": "npx", "args": ["-y", "vecline", "mcp"] }
  }
}
```

```toml
# Codex: ~/.codex/config.toml — or .codex/config.toml to scope it to one project
[mcp_servers.vecline]
command = "npx"
args = ["-y", "vecline", "mcp"]
```

Each of the three has a one-liner that writes the config for you:

```bash
claude mcp add vecline -- npx -y vecline mcp                              # Claude Code
codex mcp add vecline -- npx -y vecline mcp                               # Codex
code --add-mcp '{"name":"vecline","command":"npx","args":["-y","vecline","mcp"]}'  # VS Code
```

**Or install it in one click.** Download [`vecline.mcpb`](https://github.com/shunyagatha/Vecline/releases/latest/download/vecline.mcpb) from the latest release and open it with Claude Desktop — no config file to edit. The bundle is a *launcher*, not a vendored copy of the package: it prefers a `vecline` already on your `PATH` and otherwise runs `npx -y vecline@<pinned> mcp`. That matters because the image path uses native binaries chosen per platform, and baking them in would mean shipping a separate bundle per OS/arch — with the wrong one failing silently rather than loudly. Vecline is also listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as `io.github.shunyagatha/vecline` and on [Smithery](https://smithery.ai/servers/shunyagatha/vecline).

**Every tool is annotated**, so an agent knows what a call does before making it: `measure`, `palette`, `placeholder` and `image_info` are marked read-only; the eight that write a file are marked destructive, because they will overwrite whatever is at the output path. All twelve are `openWorldHint: false` — nothing in this server touches a network.

**Why an agent should reach for this rather than a cloud vectoriser.** Three of these tools have no equivalent in any hosted image service: `measure` and `diff` report *real* SSIM/PSNR/CIEDE2000 by rendering the result and comparing it, so a model can verify its own output instead of asserting it worked; `vectorize --mode lossless` returns geometry that is provably bit-exact; and the whole surface runs locally, so nothing an agent touches is uploaded. The honest converse is in the tool descriptions themselves: on *photographs* a neural cloud tracer will usually look better, and `vectorize` says so, because an agent choosing between tools should not have to discover that by shipping a bad result.

**It degrades honestly, too.** `office_convert` needs your local LibreOffice and PDF input needs the optional `mupdf`; rather than failing cold when they are absent, the server probes for them at `tools/list` and annotates the affected tools (`UNAVAILABLE … install from libreoffice.org`). An agent then picks a different tool or tells you what to install, instead of retrying something that cannot work.

`vecline component` turns a raster (or an existing SVG) into a typed, prop-forwarding **React/Vue/Svelte/Solid** component in one pass (`-f`, `--current-color`, `--js`) — raster → traced SVG → component, where SVGR-style tools start from the SVG. For designers, `--layers` emits editable per-colour Inkscape/Illustrator layers and the `traceSeparations()` API returns one standalone SVG per colour (screen-print/vinyl/DTF separations); `--palette "#fff,#e4002b,#000"` locks output to exact brand/spot colours. `vecline sprite icons/*` packs a folder of icons (rasters get traced on the way in) into a single `<symbol>` sheet you reference with `<use href="#name">` — the standard on-trend replacement for icon fonts, and `svgSprite()` is pure `vecline/core`.

**Centerline (single-stroke) tracing** — `vecline centerline drawing.png` — is the most-requested tracer feature neither potrace nor vtracer ships. Instead of outlining *both* edges of every stroke (which doubles the geometry and makes a pen/laser run each line twice), it extracts the **medial axis**: one open `<path fill="none">` down the middle of each stroke, via Zhang–Suen thinning → skeleton-graph walking → Douglas–Peucker. Exactly what a plotter, laser engraver, CNC router, vinyl cutter, or signature-vectorisation needs. `centerlineTrace()` is pure and in `vecline/core`. And `vecline gcode drawing.png --tool laser|pen` takes it the last mile — **ready-to-run GRBL-style G-code toolpaths** (feed/power/units/scale, Y-flipped to bed space), a rare end-to-end image→machine pipeline in JS where other tools stop at SVG and leave you hunting for a separate svg2gcode.

**Vector export beyond SVG** is the maker/CAD lane no other JS tracer serves: `vecline convert in.png out.dxf` writes a **DXF** (closed `LWPOLYLINE`s with true colour, Y-up) that LightBurn, LibreCAD, Fusion, and every laser/router/vinyl cutter imports; `out.eps` writes **EPS/PostScript**;  `out.pdf` writes a print-ready **PDF**, with `--cmyk` for prepress (free/JS tools all collapse to sRGB — vecline doesn't). **A part, not a drawing.** `--units mm --physical-width 80` writes a DXF that declares its own scale (`$INSUNITS`, plus `$MEASUREMENT` for importers that read that instead) and emits coordinates at real physical size. Without it a DXF says *nothing* about units — and LightBurn, LibreCAD and Fusion each apply a different default, so the same file cuts at three different sizes depending on what opened it. That is discovered after the cut, in material. The test suite parses the emitted coordinates back and asserts the geometry actually spans the promised distance, because a header claiming millimetres over pixel coordinates would pass every other check.

And the DXF is **arc-aware**: a round hole or a circular boss is written as a real `CIRCLE`/`ELLIPSE` entity — one arc the machine cuts in a single smooth move — not a ring of short chords a polyline would force. (Primitive recognition runs by default for the exporters; pass `primitives: false` for raw polylines.) The `traceGeometry()`/`toDxf`/`toEps`/`toPdf` API (all pure, in `vecline/core`) exposes the same structured Bézier geometry — now with a `primitives` annotation per sub-path — for custom pipelines.

The **asset pipelines** close the loop to what web devs deploy: `vecline favicon` writes a complete favicon/PWA icon set (multi-size `.ico`, Apple touch icon, 192/512 + maskable PNGs), a `manifest.webmanifest`, and the `<head>` markup from one source; `vecline responsive` writes an AVIF/WebP/fallback width-ladder with ready `<picture>`/`srcset` markup; `vecline placeholder` emits a **BlurHash** string or a tiny **LQIP-SVG** (a zero-binary SQIP successor) for blur-up loading; and `vecline palette` extracts a perceptual dominant-colour palette as JSON or CSS custom properties. All are pure-TS where they can be (`blurHash`, `lqipSvg`, `extractPalette` live in `vecline/core`).

**Animated raster → animated SVG** — `vecline animate loading.gif` traces every frame and stacks them into **one self-contained CSS-animated SVG** (a negative-`animation-delay` flipbook — no JavaScript). All frames share a single palette, so colours never flicker frame to frame, and the result scales without the blur or banding a GIF shows when enlarged. Frame 0 is the static poster a non-animating renderer or `prefers-reduced-motion` falls back to. `framesToAnimatedSvg()` is pure (`vecline/core`); `traceAnimation()` reads the frames (Node). Few JS tools go raster-animation → animated vector at all.

**Animated GIF and animated WebP are the verified inputs.** Frames come from whatever libvips opens with `animated: true`, and the prebuilt `sharp` binary **does not expose APNG frames** — an APNG loads as a single still, so you get a one-frame SVG rather than an error. (Measured, not assumed: this build raises `vips_image_get: field "n-pages" not found` on the APNG path.) Earlier versions of this README listed APNG without that qualifier; if your libvips is built with APNG page support it will work, but do not count on the default install.

**Documents to images** — `vecline doc report.pdf -o pages/ --dpi 150` renders a **PDF**, an **SVG**, or an **Office document** (`.docx`/`.xlsx`/`.pptx`/ODF — via your LibreOffice) to one raster per page, at any DPI or scale, in any output format (`--format png|jpeg|webp|avif`, `--pages "1,3-5"`). Pass `--format svg` to **vectorise each page** — turning a scanned or raster page into real, scalable SVG in one step. So `vecline doc slides.pptx -o thumbs/ -f webp` gives you a WebP thumbnail per slide. SVG rendering uses the bundled resvg; **PDF** rendering follows vecline's bring-your-own-codec rule — it dynamically loads the optional, pure-WASM [`mupdf`](https://www.npmjs.com/package/mupdf) package (no native binary to compile) and prints a one-line install hint if it is not present, so the base install stays lean. `renderPdfPages()` / `isPdf()` are exported for programmatic use.

**Images → one PDF** — `vecline pdf scan1.png scan2.jpg -o album.pdf` stitches a stack of photos or scans into a single multi-page PDF, one image per page, sized at any `--dpi`. The PDF is assembled from raw bytes with a correct cross-reference table (each page embedded as a `DCTDecode` JPEG), so it stays small and opens everywhere — the natural complement to `vecline doc` (PDF → images). `imagesToPdf()` / `assembleImagePdf()` are exported.

**Office documents ⇄ PDF** — `vecline office report.docx -o report.pdf` (and the reverse, `scan.pdf -o out.docx`, plus Excel, PowerPoint, ODF, RTF, HTML, CSV — any pair LibreOffice bridges). Faithfully rendering Word/Excel/PowerPoint needs a full office engine, so — exactly as with PDFs — vecline **bundles nothing** and drives your **local LibreOffice** through a plain child process: **zero added dependencies, the install stays tiny, and your documents never leave the machine** (no cloud upload, unlike most converters). The target format is inferred from the output extension; if LibreOffice isn't found the error tells you how to install it or points `VECLINE_SOFFICE` at the binary. Convert a whole folder at once with a glob and `--to`: `vecline office "docs/**/*.docx" --to pdf -o out/` writes one PDF per document (same-named files from different folders are disambiguated, never overwritten). `convertOffice()` / `convertOfficeBatch()` are exported for programmatic use.

**Content-aware crop** — `vecline crop photo.jpg -a 1:1` (or `16:9`, `4:5`, `-w 512 --height 512`) — reframes to a target aspect by **keeping the interesting subject, not the centre**. It scores every candidate window by the edge energy and colour saturation it captures (a Sobel importance map summed into an integral image, so every window scores in O(1)), the way the popular smartcrop.js does — but in pure, dependency-free TypeScript, so `smartCrop()` and `cropImage()` run in `vecline/core` in the browser too. On a wide shot with the subject off to one side, a naïve centre crop drops it; this follows it.

`vecline edit` wraps sharp's pipeline behind one command, in a fixed, sensible order (geometry → tone → colour → morphology → compositing → finish): `--resize`/`--fit`, `--rotate`, `--flip`/`--flop`, `--crop`, `--trim`; `--blur`, `--sharpen`, `--median`, `--clahe <WxH>`, `--gamma`, `--normalize`; `--grayscale`, `--negate`, `--sepia`, `--tint <color>`, `--threshold <0-255>`, `--brightness`/`--saturation`/`--hue`/`--lightness`; `--dilate`/`--erode`; `--unflatten`; `-b, --background` to flatten. Arbitrary affine warps, edge padding (`extend`), per-channel `linear` levels, custom `convolve` kernels, 3×3 `recomb`, and multi-image `composite` are available on the `vecline/ops` library entry point. It is Node-only (needs sharp) and ships as its own subpath so browser and edge bundles never pull it in.

`vecline verify --fail-under 0.98` exits non-zero when SSIM drops below the threshold, which makes it usable as a CI gate on asset pipelines. Where `verify` gives you the number, **`vecline diff before.png after.png`** shows you *where*: a pixelmatch-style heatmap with the base faded to a pale backdrop and every pixel that moved beyond a **CIEDE2000** threshold flagged in red — perceptual, so a one-bit rounding wobble doesn't light up the frame while a real hue shift is caught. `--fail-over 0.01` gates CI on the changed-pixel fraction, and `diffImages()` is pure (`vecline/core`), so the same heatmap renders client-side in the playground or a browser test runner.

## Library

```ts
import { loadRaster, vectorize, rasterize, compareImages } from 'vecline';
import { readFile, writeFile } from 'node:fs/promises';

const source = await loadRaster(await readFile('logo.png'));

const result = await vectorize(source, {
  mode: 'auto',
  verify: true,
  targetSsim: 0.98,
});

console.log(result.mode);              // 'pixel'
console.log(result.lossless);          // true — measured, not asserted
console.log(result.quality?.psnr);     // Infinity
await writeFile('logo.svg', result.svg);
```

```ts
// SVG → raster
const png = await rasterize(await readFile('logo.svg'), {
  width: 2400,
  encode: { format: 'png' },
});
await writeFile('logo@2400.png', png.buffer);
```

Every conversion function is pure with respect to the filesystem — only `loadRaster` reads, and nothing writes — so the library composes into whatever pipeline you already have. The lower-level pieces (`quantize`, `connectedComponents`, `traceComponents`, `fitLoop`, `PathBuilder`, `ssimPlane`, `deltaE2000`) are exported too.

## Limitations

Stated plainly, because you should know before you invest:

- **Tracing a photograph will not look like the photograph.** That is inherent, not a tuning problem. Use `embed` when fidelity matters, or `trace` when scalability and editability matter more.
- **`pixel` mode on photographic input** would need roughly one rectangle per pixel. Vecline refuses and tells you to use `embed` or `trace` instead.
- **WebP payloads in `embed` mode are browser-only.** resvg and librsvg builds without WebP render a WebP `<image>` as *blank*, with no warning. `auto` therefore never selects WebP; `--embed-strategy webp` opts in and prints a warning.
- **16-bit sources are reduced to 8 bit** for `pixel` and `trace`, because SVG paint servers cannot express more. `embed` with `--embed-strategy preserve` keeps the original bit depth intact.
- **Animation is not supported.** Multi-frame inputs use the first frame.
- **`trace` memory** scales with image area; very large photographs are better downscaled first.
- **HEIC, JPEG XL, JPEG 2000, PSD, PDF and camera RAW are not built in** — the prebuilt libvips lacks the codecs. You can register your own via `vecline/codecs`; see [Formats](#formats).
- **`vecline/core` cannot read or write compressed image files.** PNG, JPEG, WebP and friends need real codecs; core handles BMP, ICO, PNM and TGA because this package implements those itself. In a browser, use `createImageBitmap` / canvas to decode and `canvas.toBlob` to encode.
- **Tight-tolerance tracing favours accuracy over few smooth curves.** The retuned default (0.4px) makes a large smooth arc come out as a fine, pixel-accurate polygon rather than a handful of Béziers. That is the right call for photos and for pixel fidelity, but if you want a logo as a few editable curves, use `--preset logo` (tolerance 0.6) or raise `--tolerance` yourself. The two goals genuinely trade off; the default picks accuracy.
- **Not compared against commercial tracers.** The [comparison](#compared-with-other-vectorizers) covers potrace, imagetracerjs and vtracer — what is installable and scriptable. Illustrator, Vector Magic and Vectorizer.AI remain unmeasured, so no claim is made about them.

## Changelog

Every release is tagged and documented in [CHANGELOG.md](CHANGELOG.md), which indexes the [full notes on GitHub](https://github.com/shunyagatha/Vecline/releases) — including the releases that corrected an earlier claim.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/shunyagatha/Vecline.git
cd Vecline
npm install
npm run build
npm test
```

Test fixtures are **generated from code**, not committed as binaries: an image blob nobody can review in a diff is a liability, and a resampling change in an image library silently invalidates every expectation built on it.

## Acknowledgements

Standing on the shoulders of: [Xiaolin Wu](https://www.ece.mcmaster.ca/~xwu/) (colour quantisation), [Philip J. Schneider](https://dl.acm.org/doi/10.5555/90767.90941) (curve fitting), [Peter Selinger](https://potrace.sourceforge.net/) (potrace, whose approach to boundary tracing informed this one), [Björn Ottosson](https://bottosson.github.io/posts/oklab/) (Oklab), [Wang, Bovik, Sheikh & Simoncelli](https://ece.uwaterloo.ca/~z70wang/publications/ssim.html) (SSIM), and [Sharma, Wu & Dalal](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/) (CIEDE2000). Built on [libvips](https://www.libvips.org/) via [sharp](https://sharp.pixelplumbing.com/), and [resvg](https://github.com/linebender/resvg).


## Privacy Policy

**Vecline collects nothing.** There is no server to send anything to: every
conversion — tracing, measuring, cropping, PDF and Office rendering — happens on
your own machine, and your images and documents are never uploaded.

- **Collected:** nothing. No files, no accounts, no analytics, no telemetry, no cookies.
- **Storage:** files are processed in memory and written only where you ask.
- **Third parties:** nothing is shared, because nothing is collected. The MCP
  desktop extension may fetch the `vecline` package from npm on first run, and
  Office conversion invokes a LibreOffice already installed on your machine —
  neither transmits your documents.
- **Retention:** none; there is no stored data to request or delete.
- **Verify it:** watch your browser's Network tab while converting, or
  disconnect from the internet and keep working.

Full policy: **https://vecline.xyz/privacy.html** ·
Contact: [open an issue](https://github.com/shunyagatha/Vecline/issues)


## Supporting Vecline

Vecline is free and stays that way. The library, the CLI and the MCP server are
**MIT**. [Studio](https://vecline.xyz) is free to use, unlimited and signup-free —
permanently, not as a trial of something else — and its source is published so
anyone can verify it never uploads their images, but it is **source-available, not
open source**: read it, build it and audit it freely, and check
[its licence](https://github.com/shunyagatha/Vecline-Studio/blob/main/LICENSE)
before redistributing or hosting it. Nothing here is withheld from anyone who does
not pay, and there is no paid tier to be nudged towards.

If it saved you an afternoon and you want to say so:

<a href="https://tiptopjar.com/vecline"><img src="https://raw.githubusercontent.com/shunyagatha/Vecline/main/assets/tip-qr.png" width="150" align="right" alt="QR code linking to tiptopjar.com/vecline"></a>

**[tiptopjar.com/vecline](https://tiptopjar.com/vecline)** — one-off, no account
needed. The QR is the same link, for a phone.

Things that help at least as much and cost nothing: a bug report with the image
that broke it, a measurement showing Vecline losing to something else, or a
[star](https://github.com/shunyagatha/Vecline). The first two are worth more
than the tips — this project's whole claim is that its output is measured, and
that only holds while people keep checking it.

<br clear="right">

## License

[MIT](LICENSE)
