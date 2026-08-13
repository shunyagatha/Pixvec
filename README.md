# vexel

**Measurable raster ⇄ SVG conversion.** PNG, JPEG, WebP, AVIF, TIFF and GIF to SVG — and back — with the accuracy of every conversion actually measured rather than asserted.

[![CI](https://github.com/shunyagatha/vexel/actions/workflows/ci.yml/badge.svg)](https://github.com/shunyagatha/vexel/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)

```bash
vexel vectorize logo.png --verify
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

## The honest version of "100% accuracy"

Most vectorizers claim perfect accuracy. Here is what is actually true, because it determines which tool you should use:

| Direction | Can it be exact? | Why |
|---|---|---|
| **SVG → raster** | **Yes**, at any resolution you name | Rendering is a well-defined computation. Ask for 4000px wide and you get exactly that, correct to the renderer's rasterisation rules. |
| **Raster → SVG, lossless** | **Yes** | Two different ways, both bit-exact. See `pixel` and `embed` below. |
| **Raster → SVG, traced into curves** | **No, and it never can be** | A photograph holds more independent information than any compact set of Bézier curves can encode. Tracing is approximation by definition. |

Anyone promising exact photo-to-curves vectorization is either embedding a bitmap and calling it vector, or is wrong. **vexel does both exact conversions properly, does the approximate one well, and always tells you which one you got and how close it landed.**

## Three strategies, and when each is right

| Mode | Output | Exact? | Use it for |
|---|---|---|---|
| **`pixel`** | Real vector geometry (`<path>` rectangles) | **Bit-exact** | Logos, icons, pixel art, screenshots, diagrams, flat colour |
| **`trace`** | Real Bézier curves | Approximate, measured | Photos, complex art, anything you want to *scale* or *edit* |
| **`embed`** | Bitmap inside an SVG wrapper | **Bit-exact** | You need this exact image, in an SVG container |

`auto` (the default) inspects the image and picks between `pixel` and `trace`. `--mode lossless` guarantees exactness, preferring real geometry and falling back to `embed` only when the image is too photographic.

**`pixel` mode is the one people don't expect.** It produces genuine, editable, infinitely-scalable vector paths that rasterise back to your input with **zero** differing pixels — not "visually identical", literally identical. For flat artwork it is usually what you actually wanted.

## Install

Not on npm yet. Install from source:

```bash
git clone https://github.com/shunyagatha/vexel.git
cd vexel
npm install
npm run build
npm link          # puts `vexel` on your PATH
```

Or install straight from GitHub:

```bash
npm install -g github:shunyagatha/vexel
```

Requires Node.js 18.17+. Native dependencies ([sharp](https://sharp.pixelplumbing.com/), [resvg](https://github.com/yisibl/resvg-js)) ship prebuilt binaries for Linux, macOS and Windows, so no compiler toolchain is needed.

> The package will publish as `@shunyagatha/vexel` — the bare name `vexel` on npm belongs to an unrelated project.

## Quick start

```bash
# Convert, letting vexel choose the strategy
vexel vectorize logo.png

# Prove the result is what it claims
vexel vectorize logo.png --verify

# Guarantee a bit-exact result whatever the input
vexel vectorize photo.jpg --mode lossless

# Trace to curves, escalating settings until it hits a quality target
vexel vectorize portrait.jpg --target-ssim 0.95

# SVG back to raster at any size
vexel rasterize logo.svg -o logo@4x.png --scale 4
vexel rasterize logo.svg -o hero.webp --width 2400 --lossless

# Ask what a file is and what to do with it
vexel info photo.jpg

# Measure any two images against each other — raster or SVG, in any combination
vexel verify original.png result.svg

# Whole directories
vexel batch 'assets/**/*.png' -o dist/ --to svg
```

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

Two rows deserve comment, because glossing over them is how tools mislead you:

- **Photo + `embed` is not 100% exact**, even though the original JPEG bytes are preserved *verbatim* inside the SVG. The residual (max 3/255 per channel) is the SVG renderer's JPEG decoder rounding its inverse DCT differently from the reference decoder. No data was lost; two decoders simply disagree in the last bit. vexel reports the measurement, not the claim.
- **Photo + `trace` is genuinely approximate.** 0.01% pixels exact is not a bug — it is what tracing a photograph means. If that number matters to you, you want `embed`.

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

### `vexel vectorize <input>`

| Option | Description |
|---|---|
| `-o, --output <file>` | Output path (default `<input>.svg`) |
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

### `vexel rasterize <input.svg>`

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
vexel convert in.png out.svg      # direction inferred from extensions
vexel verify a.png b.svg          # measure any two images
vexel info file.png               # inspect and recommend a strategy
vexel batch 'src/**/*.png' -o out/ --to svg
```

`vexel verify --fail-under 0.98` exits non-zero when SSIM drops below the threshold, which makes it usable as a CI gate on asset pipelines.

## Library

```ts
import { loadRaster, vectorize, rasterize, compareImages } from '@shunyagatha/vexel';
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
- **`pixel` mode on photographic input** would need roughly one rectangle per pixel. vexel refuses and tells you to use `embed` or `trace` instead.
- **WebP payloads in `embed` mode are browser-only.** resvg and librsvg builds without WebP render a WebP `<image>` as *blank*, with no warning. `auto` therefore never selects WebP; `--embed-strategy webp` opts in and prints a warning.
- **16-bit sources are reduced to 8 bit** for `pixel` and `trace`, because SVG paint servers cannot express more. `embed` with `--embed-strategy preserve` keeps the original bit depth intact.
- **Animation is not supported.** Multi-frame inputs use the first frame.
- **`trace` memory** scales with image area; very large photographs are better downscaled first.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/shunyagatha/vexel.git
cd vexel
npm install
npm run build
npm test
```

Test fixtures are **generated from code**, not committed as binaries: an image blob nobody can review in a diff is a liability, and a resampling change in an image library silently invalidates every expectation built on it.

## Acknowledgements

Standing on the shoulders of: [Xiaolin Wu](https://www.ece.mcmaster.ca/~xwu/) (colour quantisation), [Philip J. Schneider](https://dl.acm.org/doi/10.5555/90767.90941) (curve fitting), [Peter Selinger](https://potrace.sourceforge.net/) (potrace, whose approach to boundary tracing informed this one), [Björn Ottosson](https://bottosson.github.io/posts/oklab/) (Oklab), [Wang, Bovik, Sheikh & Simoncelli](https://ece.uwaterloo.ca/~z70wang/publications/ssim.html) (SSIM), and [Sharma, Wu & Dalal](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/) (CIEDE2000). Built on [libvips](https://www.libvips.org/) via [sharp](https://sharp.pixelplumbing.com/), and [resvg](https://github.com/linebender/resvg).

## License

[MIT](LICENSE)
