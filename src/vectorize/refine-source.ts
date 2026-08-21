import type { RasterImage } from '../types.js';
import { MAX_PLATEAU_REACH } from './subpixel.js';

/**
 * A denoised MEASUREMENT copy of the source, for antialiasing-coverage
 * sampling only — computed for a narrow band around traced region boundaries,
 * not the whole raster.
 *
 * **The defect this targets.** `findPlateau` and the coverage projection in
 * `refineLoop`/`refineOpenArc` (subpixel.ts) read raw source bytes to recover
 * where a boundary really falls between two pixels. On a clean synthetic edge
 * that raw byte IS the measurement — a monotonic antialiasing ramp from one
 * pure colour to the other. But a resized/compressed photograph's edge is not
 * always that: sharpening ringing, JPEG blocking and dithering put pixel-level
 * noise on top of the ramp, and every one of those noisy bytes is read as if
 * it were a trustworthy sample. On `yoyokd14-calm-7149117_1920.png`'s cyclist
 * silhouette this was measured directly (per-point displacement probe on the
 * real pipeline): stdev 0.568 against a possible range of about 1, and ~13% of
 * consecutive densified points flip the SIGN of their displacement — one point
 * wants to move out, its immediate neighbour wants to move in. That is not a
 * geometric correction being clipped by a budget; it is per-pixel noise being
 * measured as if it were signal, and no downstream tolerance can recover
 * information that was never captured cleanly at this step.
 *
 * **The fix.** Run a mild edge-preserving (bilateral) filter over the source,
 * and hand refinement that filtered copy to read from — never the original.
 * Classification (`quantize`, `connectedComponents`, every class and
 * component boundary) still runs against the untouched source, so which
 * pixels belong to which region — and therefore where the LATTICE boundary
 * itself falls — is completely unaffected. Only the sub-pixel measurement
 * taken once a boundary step is already decided gets the cleaner signal.
 *
 * **Band-limited, not whole-raster.** An earlier version of this pass ran the
 * filter over every pixel in the image, which cost real time in proportion to
 * image AREA (measured: +48.7% average trace time on the 9-subject corpus,
 * +156% on this exact image, worst case +55% on a 24MP photo) even though
 * `findPlateau`/the coverage projection only ever read pixels within
 * {@link MAX_PLATEAU_REACH} steps of a traced boundary — a cost in
 * proportion to PERIMETER, not area. Worse, filtering far-field pixels no
 * measurement will ever read is not free of side effects either: it measurably
 * moved a synthetic many-junction fixture's structure (`petals`,
 * `structure:check`) even though nothing there needed denoising. Both are
 * fixed the same way: {@link boundaryBand} marks exactly the pixels a plateau
 * walk from any region boundary in `labels` could reach, dilated by
 * `MAX_PLATEAU_REACH` so the walk's full axis-aligned reach is covered, and
 * {@link bilateralForMeasurement} only pays the O(radius²) filter cost inside
 * that band — everywhere else is a direct copy of the untouched source, byte
 * for byte, so a shape far from any boundary this pass could act on is
 * provably unaffected by it.
 *
 * **Why bilateral, not a box/Gaussian blur.** A spatial-only blur averages
 * across whatever is nearby regardless of how different it is, so it softens
 * genuine edges exactly as much as it softens noise — that is Perona-Malik
 * diffusion's whole objection to a plain blur (see `smooth.ts`). A bilateral
 * filter adds a RANGE term: two pixels only average together if they are both
 * close in space AND similar in colour. A true region boundary (black against
 * a yellow fill, here) is hundreds of levels apart per channel, so its range
 * weight collapses to effectively zero and the filter leaves it alone; a
 * ringing/dithering pixel a few levels off its true plateau sits well inside
 * the range window and gets pulled back toward its neighbours.
 *
 * **What this is not.** It does not change which pixel gets sampled, only
 * what value is read there — `findPlateau`'s region-membership stop condition
 * and every `inBounds`/`classes[...]===cls` test upstream of it are computed
 * from the untouched image, so this cannot move a lattice boundary or merge
 * two regions. It also does not touch alpha's role as the hard silhouette
 * gate anywhere else in the pipeline — this array is never passed to
 * `quantize`, `connectedComponents`, or emitted as a fill colour; its only
 * consumer is the coverage projection inside `refineLoop`/`refineOpenArc`.
 */

/**
 * Radius of the bilateral window: 9x9. Measured directly against the target
 * defect — `yoyokd14-calm-7149117_1920.png`'s cyclist silhouette carries a
 * ringing overshoot pixel that reads BRIGHTER than either true plateau
 * (`rgba(255,237,33)` sitting between a `rgba(232,215,30)` fill and black,
 * one raw sample away from the crossing) — and a radius has to be large
 * enough that the window reaches genuinely clean plateau pixels on the far
 * side of that overshoot, not just more of the same ramp. Swept on that exact
 * pixel: radius 2 pulls it to 251 (barely moved), radius 3 to 241, radius 4
 * to 235 — visibly converging on the true 232 plateau. Stopped at 4 rather
 * than pushed further because this is a measurement smoother, not a content
 * blur — see `SIGMA_SPATIAL`.
 */
const RADIUS = 4;

/** Spatial falloff. Still modest at this radius: a same-coloured pixel 4px
 * away counts for real but meaningfully less than an adjacent one, so the
 * window's reach comes from `RADIUS` finding clean plateau pixels to draw
 * on, not from flattening everything inside it equally. */
const SIGMA_SPATIAL = 1.8;

/**
 * Range falloff, in the same "sum of squared channel deltas" units as
 * `MIN_CONTRAST_SQ`/`PLATEAU_EPS_SQ` in subpixel.ts, and swept alongside
 * `RADIUS` against the same overshoot pixel. A real silhouette edge in this
 * corpus (black against any real fill colour) measures in the TENS OF
 * THOUSANDS in these units — `contrastSq` for black-vs-this-image's-yellow is
 * ~100,900 — while the ringing overshoot itself is ~1,000 (`(255,237,33)` vs
 * its own plateau `(232,215,30)`). sigma=60 (denom 7,200) keeps a real edge's
 * weight at `exp(-100900/7200)` ≈ 8e-7 — indistinguishable from zero — while
 * giving the ~1,000-unit ringing pair `exp(-1000/7200)` ≈ 0.87, most of a
 * full vote. There is roughly two orders of magnitude of headroom between
 * "real edge" and "ringing noise" on this corpus, which is what makes a
 * single fixed sigma workable here without a per-image fit.
 */
const SIGMA_RANGE = 60;

/** Precomputed once: `exp(-r^2 / (2*sigmaSpatial^2))` for each offset in the window. */
function spatialWeights(radius: number, sigma: number): Float64Array {
  const side = radius * 2 + 1;
  const w = new Float64Array(side * side);
  const denom = 2 * sigma * sigma;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const r2 = dx * dx + dy * dy;
      w[(dy + radius) * side + (dx + radius)] = Math.exp(-r2 / denom);
    }
  }
  return w;
}

/**
 * Boolean OR of `mask` over a sliding window of half-width `radius`, applied
 * along one axis (rows when `horizontal`, columns otherwise) — the separable
 * building block {@link boundaryBand} uses twice to get a full 2D (Chebyshev/
 * square) dilation in O(width*height) total rather than O(width*height*radius²).
 *
 * Implemented as a nearest-`true` distance sweep (forward then backward along
 * each line) rather than a literal window scan: `dist[i]` after both sweeps is
 * the distance to the closest `true` cell on the same line, and `dist[i] <=
 * radius` is exactly the windowed OR. Each line costs two linear passes
 * regardless of `radius`.
 */
function dilate1D(mask: Uint8Array, width: number, height: number, radius: number, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(mask.length);
  const lines = horizontal ? height : width;
  const lineLen = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  const base = horizontal ? (l: number) => l * width : (l: number) => l;

  const dist = new Int32Array(lineLen);
  for (let l = 0; l < lines; l++) {
    const off = base(l);
    let d = lineLen; // sentinel: "no true seen yet on this sweep"
    for (let p = 0; p < lineLen; p++) {
      const i = off + p * stride;
      d = mask[i] ? 0 : d + 1;
      dist[p] = d;
    }
    d = lineLen;
    for (let p = lineLen - 1; p >= 0; p--) {
      const i = off + p * stride;
      d = mask[i] ? 0 : d + 1;
      if (d < dist[p]!) dist[p] = d;
    }
    for (let p = 0; p < lineLen; p++) {
      out[off + p * stride] = dist[p]! <= radius ? 1 : 0;
    }
  }
  return out;
}

/**
 * Which pixels a plateau walk from ANY region boundary in `labels` could ever
 * read: a pixel adjacent (4-connected) to a label change — exactly the `(ix,
 * iy)`/`(ox, oy)` pair `refineLoop`/`refineOpenArc` compute for every measured
 * crack step — dilated by `radius` (default {@link MAX_PLATEAU_REACH}, the
 * real cap on `findPlateau`'s walk in subpixel.ts) so the walk's full
 * axial reach is covered too.
 *
 * Square (Chebyshev) dilation is a deliberate over-approximation of the
 * axis-only reach `findPlateau` actually uses — it walks in one of 4 cardinal
 * directions per boundary step, never diagonally — but a square is cheap to
 * get provably right with two separable passes, and the extra corner pixels
 * it marks are filtered "for free" rather than being a source of missed ones.
 *
 * `labels` may be either `classes` (as `refineLoop` reads) or component ids
 * (as `refineOpenArc` reads via `arcs.ts`); either way an adjacent differing
 * value is exactly the condition `in1 === in2` in subpixel.ts tests to find a
 * boundary step, so the band this returns matches what both call sites can
 * ever touch.
 */
export function boundaryBand(labels: Int32Array, width: number, height: number, radius = MAX_PLATEAU_REACH): Uint8Array {
  const n = width * height;
  const seed = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = labels[i]!;
      if (
        (x > 0 && labels[i - 1] !== v) ||
        (x < width - 1 && labels[i + 1] !== v) ||
        (y > 0 && labels[i - width] !== v) ||
        (y < height - 1 && labels[i + width] !== v)
      ) {
        seed[i] = 1;
      }
    }
  }
  if (radius <= 0) return seed;
  const rows = dilate1D(seed, width, height, radius, true);
  return dilate1D(rows, width, height, radius, false);
}

/**
 * Bilateral-filter `img`, but only inside `band` — see the module doc.
 * Pixels outside the band are a direct copy of the source: zero filter cost,
 * and byte-identical to the input, so anything this pass cannot possibly
 * affect (per {@link boundaryBand}) provably is not affected by it. The input
 * is never mutated and its alpha-as-silhouette semantics are preserved: alpha
 * is filtered by the same rule as colour (a hard alpha edge has the same huge
 * range weight as a hard colour edge, so it survives untouched; a soft alpha
 * ramp gets the same ringing cleanup a colour ramp does), never used to gate
 * anything outside this module.
 */
export function bilateralForMeasurement(
  img: RasterImage,
  band: Uint8Array,
  opts: { radius?: number; sigmaSpatial?: number; sigmaRange?: number } = {},
): RasterImage {
  const { width, height, data } = img;
  const radius = opts.radius ?? RADIUS;
  const sigmaRange = opts.sigmaRange ?? SIGMA_RANGE;
  const sw = spatialWeights(radius, opts.sigmaSpatial ?? SIGMA_SPATIAL);
  const side = radius * 2 + 1;
  const rangeDenom = 2 * sigmaRange * sigmaRange;

  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!band[p]) continue;
      const co = p * 4;
      const cr = data[co], cg = data[co + 1], cb = data[co + 2], ca = data[co + 3];

      let sr = 0, sg = 0, sb = 0, sa = 0, sw_ = 0;
      const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
      for (let ny = y0; ny <= y1; ny++) {
        const wy = ny - y + radius;
        for (let nx = x0; nx <= x1; nx++) {
          const wx = nx - x + radius;
          const no = (ny * width + nx) * 4;
          const dr = data[no] - cr, dg = data[no + 1] - cg, db = data[no + 2] - cb, da = data[no + 3] - ca;
          const rangeSq = dr * dr + dg * dg + db * db + da * da;
          const weight = sw[wy * side + wx]! * Math.exp(-rangeSq / rangeDenom);
          sr += weight * data[no]!; sg += weight * data[no + 1]!;
          sb += weight * data[no + 2]!; sa += weight * data[no + 3]!;
          sw_ += weight;
        }
      }
      out[co] = sr / sw_; out[co + 1] = sg / sw_;
      out[co + 2] = sb / sw_; out[co + 3] = sa / sw_;
    }
  }
  return { width, height, data: out };
}

/**
 * Convenience entry point for `trace.ts`: build the boundary band from a
 * region-label map and hand back the band-limited denoised copy in one call.
 */
export function refineSourceFor(
  img: RasterImage,
  labels: Int32Array,
  opts: { radius?: number; sigmaSpatial?: number; sigmaRange?: number } = {},
): RasterImage {
  const band = boundaryBand(labels, img.width, img.height);
  return bilateralForMeasurement(img, band, opts);
}
