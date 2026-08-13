# Pixvec

**Measurable raster ⇄ SVG conversion.** Eleven formats, every one convertible to every other, with the accuracy of every conversion actually measured rather than asserted.

[![CI](https://github.com/shunyagatha/Pixvec/actions/workflows/ci.yml/badge.svg)](https://github.com/shunyagatha/Pixvec/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)

```bash
pixvec vectorize logo.png --verify
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
pixvec vectorize anything.png --lossless
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
pixvec vectorize logo.png -o keep.svg --mode embed --embed-strategy preserve
pixvec extract keep.svg -o recovered.png --against logo.png
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

Anyone promising exact photo-to-curves vectorization is either embedding a bitmap and calling it vector, or is wrong. **Pixvec does both exact conversions properly, does the approximate one well, and always tells you which one you got and how close it landed.**

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
npm install -g pixvec        # the CLI
npm install pixvec           # the library
```

Node.js 18.17+. The native dependencies ([sharp](https://sharp.pixelplumbing.com/), [resvg](https://github.com/yisibl/resvg-js)) ship prebuilt binaries for Linux, macOS and Windows.

### Any project architecture

| You are using | Import | Native deps |
|---|---|:--:|
| Node, ESM | `import { vectorize } from 'pixvec'` | yes |
| Node, CommonJS | `const { vectorize } = require('pixvec')` | yes |
| Browser / Deno / Bun / edge | `import { vectorizeExact } from 'pixvec/core'` | **none** |

`pixvec/core` is the vectorisation and measurement engine with **zero dependencies and no Node built-ins**. It takes a plain `{ width, height, data }` — byte-for-byte the layout of the browser's `ImageData` — so canvas pixels go straight in:

```js
import { vectorizeExact } from 'pixvec/core';

const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
const { svg } = vectorizeExact({ width, height, data });   // bit-exact, no codec needed
```

Install without the optional native packages (`npm install pixvec --omit=optional`) and core still works, at **2 MB instead of ~100 MB**. Reading image files, rendering SVG back to pixels, and the verified lossless guarantee all need real codecs, so those live in the main entry point.

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

**The matrix is square: every format it reads, it writes.** That is 11 × 11 = **121 conversions**, and the test suite runs all of them on every commit — PNG→TGA, ICO→WebP, TGA→SVG, SVG→BMP, whatever you need.

BMP, ICO, PNM and TGA are decoded in pure TypeScript — libvips is not built with them, and each is simple and stable enough to implement completely rather than adding another native dependency. All four are lossless formats, so the test suite asserts **bit-exact** decoding rather than approximate agreement.

**Not supported:** HEIC, JPEG XL, JPEG 2000, PSD, PDF and camera RAW. Each needs a patent-encumbered or heavyweight native codec, and shipping one would cost every user a large binary for a format most of them never touch. Convert those with ImageMagick or `libheif` first.

## Quick start

```bash
# Convert, letting pixvec choose the strategy
pixvec vectorize logo.png

# Prove the result is what it claims
pixvec vectorize logo.png --verify

# Guarantee a bit-exact result whatever the input, or fail
pixvec vectorize photo.jpg --lossless

# Trace to curves, escalating settings until it hits a quality target
pixvec vectorize portrait.jpg --target-ssim 0.95

# SVG back to raster at any size
pixvec rasterize logo.svg -o logo@4x.png --scale 4
pixvec rasterize logo.svg -o hero.webp --width 2400 --lossless

# Ask what a file is and what to do with it
pixvec info photo.jpg

# Measure any two images against each other — raster or SVG, in any combination
pixvec verify original.png result.svg

# Whole directories
pixvec batch 'assets/**/*.png' -o dist/ --to svg
```

## Transparent output

`--transparent` removes a solid background and leaves real transparency behind:

```bash
pixvec vectorize logo.png --transparent             # detect the background colour
pixvec vectorize logo.png --transparent '#ffffff'   # or name it
pixvec rasterize icon.svg -o icon.png --transparent
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
| Flat artwork | `embed` | 2.1 KB | 3.1 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Photo, 320×240 | `embed` | 14.5 KB | 19.6 KB | 87.94% | 58.04 dB | 0.9982 | 0.060 |
| Photo, 320×240 | `trace` auto | 14.5 KB | 37.0 KB | 0.01% | 26.70 dB | 0.8312 | 4.874 |
| Photo, 320×240 | `trace --preset photo` | 14.5 KB | 53.4 KB | 0.01% | 29.73 dB | 0.7770 | 3.173 |
| Flat artwork, 400×300 | `lossless` → `pixel` | 2.1 KB | 3.9 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Pixel art sprite, 128×128 | `lossless` → `pixel` | 0.5 KB | 0.6 KB | **100.00%** | **∞** | **1.0000** | **0.000** |
| Photo, 320×240 | `lossless` → `embed` | 14.5 KB | 230.5 KB | **100.00%** | **∞** | **1.0000** | **0.000** |

Two rows deserve comment, because glossing over them is how tools mislead you:

- **Photo + `embed` is not 100% exact**, even though the original JPEG bytes are preserved *verbatim* inside the SVG. The residual (max 3/255 per channel) is the SVG renderer's JPEG decoder rounding its inverse DCT differently from the reference decoder. No data was lost; two decoders simply disagree in the last bit. Pixvec reports the measurement, not the claim.
- **Photo + `trace` is genuinely approximate.** 0.01% pixels exact is not a bug — it is what tracing a photograph means. If that number matters to you, you want `embed`.

## Compared with other vectorizers

Run it yourself with `npm run compare`. Every tool's SVG is rendered with the **same** renderer and scored with the **same** metrics, on the same white ground, so nothing here depends on Pixvec's own view of quality.

| Fixture | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ |
|---|---|--:|--:|--:|--:|
| **Bilevel** | potrace | 1.5 KB | 24.67 dB | 0.9511 | 0.702 |
| | imagetracerjs | 1.7 KB | 19.75 dB | 0.8607 | 1.667 |
| | **pixvec trace** | **1.0 KB** | **25.36 dB** | **0.9587** | **0.612** |
| | **pixvec lossless** | 1.4 KB | **∞** | **1.0000** | **0.000** |
| **Colour art** | potrace posterize | 1.9 KB | 14.61 dB | 0.8010 | 21.302 |
| | imagetracerjs | 1.6 KB | 26.56 dB | 0.9363 | 0.662 |
| | **pixvec trace** | 1.8 KB | **30.16 dB** | **0.9610** | **0.428** |
| | **pixvec lossless** | 1.8 KB | **∞** | **1.0000** | **0.000** |
| **Photo** | potrace posterize | 11.5 KB | 13.19 dB | 0.6024 | 23.911 |
| | imagetracerjs | 11.8 KB | 26.85 dB | **0.7143** | 5.623 |
| | pixvec trace | 13.6 KB | 26.16 dB | 0.6675 | **5.145** |
| | **pixvec lossless** | 43.7 KB | **∞** | **1.0000** | **0.000** |

**Bilevel** is potrace's home ground — the case it was designed for. Pixvec is smaller *and* more accurate there, and can be **exact** for less than potrace's approximate output.

**Colour art** is where the gap is widest: 30.16 dB against 26.56 and 14.61. And `lossless` is bit-exact at the same file size as the approximate result, which makes the trade-off moot.

**Photo** is an honest split. imagetracerjs edges ahead on SSIM (0.7143 vs 0.6675) while Pixvec is better on colour error (ΔE 5.15 vs 5.62). Photographic tracing is the weakest part of this library and the place most worth improving — see [Limitations](#limitations).

Two caveats, so the table is not read as more than it is. potrace is *bilevel by design*; its colour rows use `posterize`, which is a bolt-on, and reporting them without saying so would be a rigged fight. And these are synthetic fixtures, chosen so anyone can reproduce them without licensing someone's photographs — no substitute for trying your own images.

## Metrics

`--verify` reports the standard full-reference measures, computed the way their literature defines them so the values are comparable against other tools:

- **PSNR** — peak signal-to-noise ratio in dB. `∞` exactly when the images are bit-identical.
- **SSIM** — [Wang et al. 2004](https://ece.uwaterloo.ca/~z70wang/publications/ssim.html), Gaussian-weighted 11×11 window, σ=1.5, `valid` convolution (border pixels excluded rather than padded, matching the reference implementation and scikit-image).
- **CIEDE2000** — mean, p95 and max colour difference. Validated against all 34 pairs of the [Sharma, Wu & Dalal](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/) test set, which exists specifically to catch the hue-angle discontinuities that most implementations get wrong.
- **Pixels exact** — the fraction matching on all four channels.

Comparisons default to **premultiplied** alpha, because colour stored beneath a fully transparent pixel is invisible: two images that render identically must measure identically. Use `--alpha-mode straight` to compare raw stored bytes instead.

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

### `--target-ssim` / `--target-psnr`

Trace, render, measure, and escalate until the target is met. Each step doubles the palette *and* tightens the geometric tolerances, because the failure modes are different — too few colours shows up as banding, too loose a tolerance as rounded-off detail. The best attempt is kept, so an unreachable target still returns the closest result along with a note saying it fell short.

## CLI

### `pixvec vectorize <input>`

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
| `--precision <n>` | Decimals kept in path coordinates |
| `--no-background` | Do not collapse the dominant colour into one rectangle |
| `--target-ssim <v>` / `--target-psnr <db>` | Escalate until the target is reached |
| `--verify` | Render the result and measure it against the input |
| `--embed-strategy <s>` | `auto`, `preserve`, `png`, `webp` |
| `--xlink` | Use `xlink:href` for SVG 1.1 consumers |
| `--json` | Machine-readable output on stdout |

### `pixvec rasterize <input.svg>`

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
pixvec extract keep.svg -o out.png --against original.png   # byte-identical recovery
pixvec convert in.png out.svg      # direction inferred from extensions
pixvec verify a.png b.svg          # measure any two images
pixvec info file.png               # inspect and recommend a strategy
pixvec batch 'src/**/*.png' -o out/ --to svg
```

`pixvec verify --fail-under 0.98` exits non-zero when SSIM drops below the threshold, which makes it usable as a CI gate on asset pipelines.

## Library

```ts
import { loadRaster, vectorize, rasterize, compareImages } from 'pixvec';
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
- **`pixel` mode on photographic input** would need roughly one rectangle per pixel. Pixvec refuses and tells you to use `embed` or `trace` instead.
- **WebP payloads in `embed` mode are browser-only.** resvg and librsvg builds without WebP render a WebP `<image>` as *blank*, with no warning. `auto` therefore never selects WebP; `--embed-strategy webp` opts in and prints a warning.
- **16-bit sources are reduced to 8 bit** for `pixel` and `trace`, because SVG paint servers cannot express more. `embed` with `--embed-strategy preserve` keeps the original bit depth intact.
- **Animation is not supported.** Multi-frame inputs use the first frame.
- **`trace` memory** scales with image area; very large photographs are better downscaled first.
- **HEIC, JPEG XL, JPEG 2000, PSD, PDF and camera RAW do not decode.** See [Formats](#formats).
- **`pixvec/core` cannot read or write compressed image files.** PNG, JPEG, WebP and friends need real codecs; core handles BMP, ICO, PNM and TGA because this package implements those itself. In a browser, use `createImageBitmap` / canvas to decode and `canvas.toBlob` to encode.
- **Photographic tracing trails imagetracerjs on SSIM** — 0.6675 against 0.7143 on the benchmark fixture (reproducible at two fixture sizes), though Pixvec leads on colour error. I guessed the cause was potrace's curve-optimisation pass, implemented it, and measured: it merges 0–13% of segments and changes the photographic score not at all. The reason is structural — Schneider subdivision only splits when one curve *provably* fails, so re-fitting the merged span fails the same test. **The real cause is still unknown**, and finding it is the most valuable open problem in this library.
- **Not compared against Illustrator or vtracer.** The [comparison](#compared-with-other-vectorizers) covers potrace and imagetracerjs, which are what is installable and scriptable. Commercial tracers remain unmeasured.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/shunyagatha/Pixvec.git
cd Pixvec
npm install
npm run build
npm test
```

Test fixtures are **generated from code**, not committed as binaries: an image blob nobody can review in a diff is a liability, and a resampling change in an image library silently invalidates every expectation built on it.

## Acknowledgements

Standing on the shoulders of: [Xiaolin Wu](https://www.ece.mcmaster.ca/~xwu/) (colour quantisation), [Philip J. Schneider](https://dl.acm.org/doi/10.5555/90767.90941) (curve fitting), [Peter Selinger](https://potrace.sourceforge.net/) (potrace, whose approach to boundary tracing informed this one), [Björn Ottosson](https://bottosson.github.io/posts/oklab/) (Oklab), [Wang, Bovik, Sheikh & Simoncelli](https://ece.uwaterloo.ca/~z70wang/publications/ssim.html) (SSIM), and [Sharma, Wu & Dalal](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/) (CIEDE2000). Built on [libvips](https://www.libvips.org/) via [sharp](https://sharp.pixelplumbing.com/), and [resvg](https://github.com/linebender/resvg).

## License

[MIT](LICENSE)
