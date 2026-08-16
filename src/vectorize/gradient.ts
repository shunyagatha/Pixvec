/**
 * Gradient reconstruction — turning a fan of flat colour bands back into the
 * smooth ramp they came from.
 *
 * Quantisation is what makes a tracer tractable, but it is also what shreds a
 * sky or a cheek into a dozen flat bands. This module detects when a run of
 * adjacent bands is really one linear colour ramp and rewrites them, *before*
 * segmentation, into a single synthetic class. The unchanged pipeline downstream
 * then traces that class as one region and the emitter paints it with a
 * `<linearGradient>` instead of a flat fill — so holes (a bird in the sky),
 * winding, and hairline seams are all handled by machinery that already works.
 *
 * Two properties make this safe to ship:
 *
 * 1. **It cannot touch flat art.** A genuinely flat area is a single class and
 *    is never proposed; large-step palette edges never coalesce; and the gate
 *    below cannot beat a near-zero flat error. Off by default, and byte-for-byte
 *    identical to the flat tracer whenever no region is accepted.
 * 2. **It is measured, and the comparison is fair.** For every candidate the gate
 *    reconstructs the *actual* sRGB piecewise-linear interpolation the renderer
 *    will produce from the stops that will be written to the file, and compares
 *    that, per pixel, in Oklab against both the source and the flat bands it
 *    would replace — never an idealised fit the renderer would not reproduce.
 *
 *    That comparison weighs error against model size. Asking one ramp to beat a
 *    forty-band staircase on raw error is a contest the simpler model cannot win,
 *    however obviously the region is a ramp; measured on a logo whose ramp is
 *    unmistakably linear, the bands scored 3.3e-5 against the gradient's 1.4e-4
 *    and the ramp shipped as forty-eight slivers. So a gradient may be committed
 *    at a slightly higher error than the bands when it replaces enough of them.
 *    What guarantees quality is `gradientMaxError`, an absolute ceiling: a region
 *    no single ramp can model — a whole photograph coalesced by the flood above —
 *    lands far above it and is still refused.
 *
 * Ramps are fit in Oklab (perceptually uniform); the stops are sampled along
 * that Oklab ramp and emitted as sRGB, so SVG's sRGB stop interpolation tracks
 * the perceptual line.
 */

import type { RasterImage } from '../types.js';
import { srgbToOklab, oklabToSrgb, shortHex } from '../color.js';

/**
 * Synthetic class ids for accepted gradient regions start here, far above any
 * real `colorIndex * levelCount + alphaIndex` (which is well under ~2560 for a
 * 256-colour, 64-level palette), so the two never collide.
 */
export const GRAD_BASE = 1 << 20;

export interface GradientTuning {
  /** Master switch. Off means this module never runs. */
  gradients: boolean;
  /** Smallest region worth de-banding, in pixels. 0 auto-scales to the image. */
  gradientMinArea: number;
  /** Largest Oklab step between neighbouring bands that may still coalesce. */
  gradientStepMax: number;
  /** Fractional error reduction a gradient must clear to beat the flat bands. */
  gradientMargin: number;
  /**
   * Absolute RMS-Oklab ceiling. This is the real quality guarantee: since the
   * accept test weighs error against the number of bands replaced, the ceiling is
   * what separates a ramp the model genuinely fits from a region that merely got
   * coalesced.
   */
  gradientMaxError: number;
  /** Maximum colour stops per gradient. Stops are placed adaptively up to this. */
  gradientStops: number;
}

export const GRADIENT_DEFAULTS: GradientTuning = {
  gradients: false,
  gradientMinArea: 0,
  gradientStepMax: 0.08,
  gradientMargin: 0.1,
  gradientMaxError: 0.015,
  gradientStops: 16,
};

/** A ready-to-emit gradient paint, keyed in the result by its synthetic class. */
export interface GradientPaint {
  /** `<linearGradient>` markup for the document `<defs>`. */
  def: string;
  /** The `url(#id)` reference for a path's `fill`. */
  ref: string;
  /** Region alpha, 0–1; carried on the path as `fill-opacity` when below 1. */
  alpha: number;
}

export interface GradientResult {
  /** A rewritten class map; identical to the input where nothing was accepted. */
  classes: Int32Array;
  /** Accepted gradients, keyed by synthetic class id. Empty when none qualified. */
  paints: Map<number, GradientPaint>;
}

interface Palette {
  rgb: Uint8Array;
  lab: Float64Array;
  count: number;
}

/**
 * Detect linear gradient regions in a quantised class map and rewrite them.
 *
 * Operates on the same per-pixel `classes` the segmenter is about to consume and
 * the palette already built, so it re-quantises nothing.
 */
export function detectGradients(
  img: RasterImage,
  classes: Int32Array,
  palette: Palette,
  alphaLevels: Uint8Array,
  levelCount: number,
  width: number,
  height: number,
  opts: GradientTuning,
): GradientResult {
  const n = width * height;
  const paints = new Map<number, GradientPaint>();
  if (!opts.gradients) return { classes, paints };

  const minArea = opts.gradientMinArea > 0
    ? opts.gradientMinArea
    : Math.max(64, Math.round(n / 2000));
  const stepMaxSq = opts.gradientStepMax * opts.gradientStepMax;

  // --- 1. Relaxed union-find flood: coalesce bands within one small Oklab step
  //        and one alpha level. Distinct object edges (large steps) stay apart. ---
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] = parent[parent[r]];
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };

  const colorIdx = (cls: number): number => Math.floor(cls / levelCount);
  const alphaIdx = (cls: number): number => cls % levelCount;
  const bandClose = (ca: number, cb: number): boolean => {
    if (ca === cb) return true;
    const dl = palette.lab[ca * 3] - palette.lab[cb * 3];
    const da = palette.lab[ca * 3 + 1] - palette.lab[cb * 3 + 1];
    const db = palette.lab[ca * 3 + 2] - palette.lab[cb * 3 + 2];
    return dl * dl + da * da + db * db <= stepMaxSq;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const cls = classes[i];
      if (cls < 0) continue;
      const ci = colorIdx(cls), ai = alphaIdx(cls);
      if (x + 1 < width) {
        const j = i + 1;
        const cj = classes[j];
        if (cj >= 0 && alphaIdx(cj) === ai && bandClose(ci, colorIdx(cj))) union(i, j);
      }
      if (y + 1 < height) {
        const j = i + width;
        const cj = classes[j];
        if (cj >= 0 && alphaIdx(cj) === ai && bandClose(ci, colorIdx(cj))) union(i, j);
      }
    }
  }

  // --- 2. Per-root stats: area, whether it spans more than one colour (a flat
  //        area is a single colour and is never a gradient candidate). ---
  const area = new Int32Array(n);
  const firstColor = new Int32Array(n).fill(-1);
  const multiColor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (classes[i] < 0) continue;
    const r = find(i);
    area[r]++;
    const ci = colorIdx(classes[i]);
    if (firstColor[r] === -1) firstColor[r] = ci;
    else if (firstColor[r] !== ci) multiColor[r] = 1;
  }

  // Candidate roots → compact indices.
  const rootToK = new Int32Array(n).fill(-1);
  const kRoot: number[] = [];
  for (let i = 0; i < n; i++) {
    if (parent[i] === i && classes[i] >= 0 && area[i] >= minArea && multiColor[i]) {
      rootToK[i] = kRoot.length;
      kRoot.push(i);
    }
  }
  const K = kRoot.length;
  if (K === 0) return { classes, paints };

  const kOf = (i: number): number => rootToK[find(i)];

  // --- 3. Accumulate colour-vs-position moments per candidate (Oklab). ---
  // Normal system per channel: [n Sx Sy; Sx Sxx Sxy; Sy Sxy Syy] · coeff = rhs.
  const M = new Float64Array(K * 6);  // n, Sx, Sy, Sxx, Sxy, Syy
  const RL = new Float64Array(K * 3); // ΣL, ΣxL, ΣyL
  const RA = new Float64Array(K * 3);
  const RB = new Float64Array(K * 3);
  const lab = new Float64Array(3);
  /**
   * Every candidate pixel's source colour in Oklab, converted once.
   *
   * Four later passes read the same pixel's colour again — the extent/flat-error
   * scan, the fine sample, and the acceptance gate — and each was re-running
   * `srgbToOklab` on bytes that had not changed. Measured 5.84 conversions per
   * pixel on a 768×512 photograph, of which four were the same value computed
   * four times.
   *
   * Float64Array is not a detail. It stores exactly the double `srgbToOklab`
   * writes, so every accumulator downstream receives bit-identical inputs in
   * bit-identical order — which is what makes this a speed change and not a
   * geometry change. Float32 would round, and the gate's error sums would move.
   *
   * The rendered colours the gate compares against are deliberately not cached:
   * they depend on the continuous ramp position, not on the pixel.
   */
  const labCache = new Float64Array(n * 3);
  // How many distinct colour bands each candidate spans. This is the size of the
  // piecewise-constant model the gradient is competing against, and stage 6 needs
  // it to compare the two fairly. Counted here because this loop already visits
  // every pixel with its candidate index.
  const paletteColors = Math.max(1, Math.floor(palette.rgb.length / 3));
  const bandSeen = new Uint8Array(K * paletteColors);
  const bandCount = new Int32Array(K);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0) continue;
      const ci = colorIdx(classes[i]);
      if (ci < paletteColors) {
        const seenAt = k * paletteColors + ci;
        if (!bandSeen[seenAt]) { bandSeen[seenAt] = 1; bandCount[k]++; }
      }
      const o = i * 4;
      srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], lab);
      labCache[i * 3] = lab[0];
      labCache[i * 3 + 1] = lab[1];
      labCache[i * 3 + 2] = lab[2];
      const m = k * 6;
      M[m] += 1; M[m + 1] += x; M[m + 2] += y;
      M[m + 3] += x * x; M[m + 4] += x * y; M[m + 5] += y * y;
      const rl = k * 3;
      RL[rl] += lab[0]; RL[rl + 1] += x * lab[0]; RL[rl + 2] += y * lab[0];
      RA[rl] += lab[1]; RA[rl + 1] += x * lab[1]; RA[rl + 2] += y * lab[1];
      RB[rl] += lab[2]; RB[rl + 1] += x * lab[2]; RB[rl + 2] += y * lab[2];
    }
  }

  // Solve each candidate's three affine fits and derive its ramp axis.
  const models: (LinearModel | null)[] = new Array(K).fill(null);
  for (let k = 0; k < K; k++) {
    const m = k * 6;
    const nrm: Mat3 = [M[m], M[m + 1], M[m + 2], M[m + 1], M[m + 3], M[m + 4], M[m + 2], M[m + 4], M[m + 5]];
    const cl = solve3(nrm, RL[k * 3], RL[k * 3 + 1], RL[k * 3 + 2]);
    const ca = solve3(nrm, RA[k * 3], RA[k * 3 + 1], RA[k * 3 + 2]);
    const cb = solve3(nrm, RB[k * 3], RB[k * 3 + 1], RB[k * 3 + 2]);
    if (!cl || !ca || !cb) continue;

    // Jacobian rows are (∂channel/∂x, ∂channel/∂y). The ramp axis is the spatial
    // direction of greatest colour change: the top eigenvector of JᵀJ.
    const jxx = cl[1], jxy = cl[2], jax = ca[1], jay = ca[2], jbx = cb[1], jby = cb[2];
    const a = jxx * jxx + jax * jax + jbx * jbx;
    const b = jxx * jxy + jax * jay + jbx * jby;
    const c = jxy * jxy + jay * jay + jby * jby;
    const axis = topEigenvector2(a, b, c);
    if (!axis) continue;

    const count = M[m];
    models[k] = {
      dx: axis[0], dy: axis[1],
      meanX: M[m + 1] / count, meanY: M[m + 2] / count,
    };
  }

  // Region centroid, computed for *every* candidate — the radial centre. This is
  // independent of the linear fit, which matters because a radially-symmetric
  // gradient has ~zero net linear slope (the +x and −x sides cancel) and so has
  // no linear model at all: exactly the case the radial model must still handle.
  const cxArr = new Float64Array(K);
  const cyArr = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const count = M[k * 6] || 1;
    cxArr[k] = M[k * 6 + 1] / count;
    cyArr[k] = M[k * 6 + 2] / count;
  }

  // --- 4. Projection extent + flat-fill error, per candidate (one pass). Also
  //        the radial extent: max distance from the region centroid, which is
  //        the natural centre of a vignette / round highlight / spotlight. ---
  const tMin = new Float64Array(K).fill(Infinity);
  const tMax = new Float64Array(K).fill(-Infinity);
  const radRMax = new Float64Array(K); // max radius from centroid; 0 stays unused
  const flatSum = new Float64Array(K);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0) continue;
      const mdl = models[k];
      if (mdl) {
        const t = mdl.dx * x + mdl.dy * y;
        if (t < tMin[k]) tMin[k] = t;
        if (t > tMax[k]) tMax[k] = t;
      }
      const r = Math.hypot(x - cxArr[k], y - cyArr[k]);
      if (r > radRMax[k]) radRMax[k] = r;
      lab[0] = labCache[i * 3]; lab[1] = labCache[i * 3 + 1]; lab[2] = labCache[i * 3 + 2];
      const ci = colorIdx(classes[i]) * 3;
      flatSum[k] += sq(lab[0] - palette.lab[ci]) + sq(lab[1] - palette.lab[ci + 1]) + sq(lab[2] - palette.lab[ci + 2]);
    }
  }

  // --- 5. Fine-sample the SOURCE colour along the ramp, then adaptively choose
  //        the fewest stops whose piecewise-linear sRGB render beats the flat
  //        bands. Sampling the real ramp (not the idealised straight Oklab line)
  //        follows its true curvature; placing stops only where the curve bends,
  //        and only as many as needed, keeps the win without wasting bytes. ---
  const FINE = 32;
  const fineL = new Float64Array(K * FINE);
  const fineA = new Float64Array(K * FINE);
  const fineB = new Float64Array(K * FINE);
  const fineN = new Float64Array(K * FINE);
  // Parallel bins for the radial model, indexed by (radius / rMax) — which is
  // exactly the offset an SVG <radialGradient> uses, so no re-mapping later.
  const fineLR = new Float64Array(K * FINE);
  const fineAR = new Float64Array(K * FINE);
  const fineBR = new Float64Array(K * FINE);
  const fineNR = new Float64Array(K * FINE);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0) continue;
      const mdl = models[k];
      lab[0] = labCache[i * 3]; lab[1] = labCache[i * 3 + 1]; lab[2] = labCache[i * 3 + 2];
      if (mdl && tMax[k] > tMin[k]) {
        const u = clamp01((mdl.dx * x + mdl.dy * y - tMin[k]) / (tMax[k] - tMin[k]));
        const b = k * FINE + Math.min(FINE - 1, Math.floor(u * FINE));
        fineL[b] += lab[0]; fineA[b] += lab[1]; fineB[b] += lab[2]; fineN[b] += 1;
      }
      if (radRMax[k] > 0) {
        const uR = clamp01(Math.hypot(x - cxArr[k], y - cyArr[k]) / radRMax[k]);
        const jR = k * FINE + Math.min(FINE - 1, Math.floor(uR * FINE));
        fineLR[jR] += lab[0]; fineAR[jR] += lab[1]; fineBR[jR] += lab[2]; fineNR[jR] += 1;
      }
    }
  }

  const maxStops = Math.max(2, opts.gradientStops);
  const stopList: (number[][] | null)[] = new Array(K).fill(null);    // linear [offset, r, g, b][]
  const stopListRad: (number[][] | null)[] = new Array(K).fill(null); // radial
  for (let k = 0; k < K; k++) {
    const count = M[k * 6];
    if (count <= 0) continue;
    const target = (flatSum[k] / count) * (1 - opts.gradientMargin);
    if (models[k] && tMax[k] > tMin[k]) {
      const lin = buildCurve(fineL, fineA, fineB, fineN, k, FINE);
      stopList[k] = selectStops(lin.curve, lin.w, FINE, maxStops, target);
    } else {
      models[k] = null; // no usable linear model (e.g. a symmetric radial ramp)
    }
    if (radRMax[k] > 0) {
      const rad = buildCurve(fineLR, fineAR, fineBR, fineNR, k, FINE);
      stopListRad[k] = selectStops(rad.curve, rad.w, FINE, maxStops, target);
    }
  }

  // --- 6. The gate: rendered-gradient error vs flat error, over real pixels.
  //        Both models are rendered exactly as the SVG would (linear along its
  //        axis, radial by distance/rMax from the centroid) and scored per
  //        pixel; the better of the two competes against the flat bands. ---
  const gradSum = new Float64Array(K);
  const gradSumRad = new Float64Array(K);
  const renderLab = new Float64Array(3);
  const rgbTmp: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0) continue;
      lab[0] = labCache[i * 3]; lab[1] = labCache[i * 3 + 1]; lab[2] = labCache[i * 3 + 2];
      const mdl = models[k];
      if (mdl && stopList[k]) {
        const u = clamp01((mdl.dx * x + mdl.dy * y - tMin[k]) / (tMax[k] - tMin[k]));
        renderStops(stopList[k]!, u, rgbTmp); // reproduce resvg's sRGB stop interpolation
        srgbToOklab(Math.round(rgbTmp[0]), Math.round(rgbTmp[1]), Math.round(rgbTmp[2]), renderLab);
        gradSum[k] += sq(lab[0] - renderLab[0]) + sq(lab[1] - renderLab[1]) + sq(lab[2] - renderLab[2]);
      }
      if (stopListRad[k] && radRMax[k] > 0) {
        const uR = clamp01(Math.hypot(x - cxArr[k], y - cyArr[k]) / radRMax[k]);
        renderStops(stopListRad[k]!, uR, rgbTmp);
        srgbToOklab(Math.round(rgbTmp[0]), Math.round(rgbTmp[1]), Math.round(rgbTmp[2]), renderLab);
        gradSumRad[k] += sq(lab[0] - renderLab[0]) + sq(lab[1] - renderLab[1]) + sq(lab[2] - renderLab[2]);
      }
    }
  }

  // --- 6. Accept the winners and rewrite their pixels to a synthetic class. ---
  const out = classes.slice();
  const accepted = new Uint8Array(K);
  const floorSq = opts.gradientMaxError * opts.gradientMaxError;
  for (let k = 0; k < K; k++) {
    if (!stopList[k] && !stopListRad[k]) continue;
    const count = M[k * 6];
    // Rate–distortion, not raw error.
    //
    // The flat alternative spends `bands` pieces to reach its error; the gradient
    // spends one. Comparing the two errors directly asks a ~3-stop ramp to also be
    // strictly more accurate than a `bands`-piece staircase — a demand it can
    // almost never meet, because piecewise-constant with dozens of pieces is by far
    // the richer model. Measured on a logo whose teal ramp is unmistakably linear:
    // flat (48 bands) scored 3.3e-5 against the gradient's 1.4e-4, so the obvious
    // gradient lost by 4.3x and the ramp shipped as 48 banded slivers.
    //
    // Comparing error x model size restores the like-for-like comparison, and costs
    // no new tuning knob. The absolute floor below is what actually protects
    // quality: a whole-photograph region that no single ramp can model scores far
    // above it (2.4e-2 vs a 1e-2 floor) and is still rejected, exactly as before.
    const bands = Math.max(1, bandCount[k]);
    const target = (flatSum[k] / count) * bands * (1 - opts.gradientMargin);
    const linErr = (models[k] && stopList[k]) ? gradSum[k] / count : Infinity;
    const radErr = (stopListRad[k] && radRMax[k] > 0) ? gradSumRad[k] / count : Infinity;
    const radialWins = radErr < linErr;
    const bestErr = radialWins ? radErr : linErr;
    if (bestErr < target && bestErr < floorSq) {
      accepted[k] = 1;
      paints.set(GRAD_BASE + k, radialWins
        ? buildRadialPaint(kRoot[k], classes, alphaLevels, levelCount, cxArr[k], cyArr[k], radRMax[k], stopListRad[k]!, k)
        : buildPaint(kRoot[k], classes, alphaLevels, levelCount, models[k]!, tMin[k], tMax[k], stopList[k]!, k));
    }
  }
  if (paints.size === 0) return { classes, paints };

  for (let i = 0; i < n; i++) {
    if (classes[i] < 0) continue;
    const k = kOf(i);
    if (k >= 0 && accepted[k]) out[i] = GRAD_BASE + k;
  }
  return { classes: out, paints };
}

interface LinearModel {
  dx: number; dy: number;
  meanX: number; meanY: number;
}

function buildPaint(
  root: number, classes: Int32Array, alphaLevels: Uint8Array, levelCount: number,
  mdl: LinearModel, tMin: number, tMax: number, stops: number[][], k: number,
): GradientPaint {
  const meanT = mdl.dx * mdl.meanX + mdl.dy * mdl.meanY;
  const x1 = mdl.meanX + mdl.dx * (tMin - meanT);
  const y1 = mdl.meanY + mdl.dy * (tMin - meanT);
  const x2 = mdl.meanX + mdl.dx * (tMax - meanT);
  const y2 = mdl.meanY + mdl.dy * (tMax - meanT);

  const body = emitStops(stops);

  const id = `pv-g${k}`;
  const def =
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
    `x1="${round(x1, 2)}" y1="${round(y1, 2)}" x2="${round(x2, 2)}" y2="${round(y2, 2)}">${body}</linearGradient>`;
  const alpha = alphaLevels[classes[root] % levelCount] / 255;
  return { def, ref: `url(#${id})`, alpha };
}

/**
 * A `<radialGradient>` centred on the region's centroid with radius `rMax`. Stop
 * offsets are already `distance / rMax`, which is exactly how SVG parameterises a
 * radial gradient, so they drop straight in.
 */
function buildRadialPaint(
  root: number, classes: Int32Array, alphaLevels: Uint8Array, levelCount: number,
  cx: number, cy: number, rMax: number, stops: number[][], k: number,
): GradientPaint {
  const id = `pv-g${k}`;
  const def =
    `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
    `cx="${round(cx, 2)}" cy="${round(cy, 2)}" r="${round(rMax, 2)}">${emitStops(stops)}</radialGradient>`;
  const alpha = alphaLevels[classes[root] % levelCount] / 255;
  return { def, ref: `url(#${id})`, alpha };
}

/** Serialise stops, dropping a stop whose colour repeats its predecessor. */
function emitStops(stops: number[][]): string {
  let body = '';
  let prev = '';
  for (let s = 0; s < stops.length; s++) {
    const hex = shortHex(clamp255(stops[s][1]), clamp255(stops[s][2]), clamp255(stops[s][3]));
    if (hex === prev && s !== stops.length - 1) continue;
    prev = hex;
    body += `<stop offset="${round(stops[s][0], 3)}" stop-color="${hex}"/>`;
  }
  return body;
}

/** Average the fine per-bin Oklab samples into a curve, back-filling empty bins. */
function buildCurve(
  fineL: Float64Array, fineA: Float64Array, fineB: Float64Array, fineN: Float64Array,
  k: number, fine: number,
): { curve: Float64Array; w: Float64Array } {
  const curve = new Float64Array(fine * 3);
  const w = new Float64Array(fine);
  let last = -1;
  for (let j = 0; j < fine; j++) {
    const b = k * fine + j;
    if (fineN[b] > 0) {
      curve[j * 3] = fineL[b] / fineN[b];
      curve[j * 3 + 1] = fineA[b] / fineN[b];
      curve[j * 3 + 2] = fineB[b] / fineN[b];
      w[j] = fineN[b];
      if (last === -1) {
        for (let t = 0; t < j; t++) { curve[t * 3] = curve[j * 3]; curve[t * 3 + 1] = curve[j * 3 + 1]; curve[t * 3 + 2] = curve[j * 3 + 2]; }
      }
      last = j;
    } else if (last >= 0) {
      curve[j * 3] = curve[last * 3]; curve[j * 3 + 1] = curve[last * 3 + 1]; curve[j * 3 + 2] = curve[last * 3 + 2];
    }
  }
  return { curve, w };
}

/**
 * Greedily choose stops from a fine Oklab curve until the rendered gradient's
 * error falls below `targetSq`, or `maxStops` is reached. Starts from the two
 * endpoints and repeatedly inserts a stop at the sample the current stops render
 * worst, so stops land where the ramp actually bends. Returns `[offset,r,g,b]`.
 */
function selectStops(
  curve: Float64Array, weight: Float64Array, fine: number, maxStops: number, targetSq: number,
): number[][] {
  const chosen = [0, fine - 1];
  const rgb: [number, number, number] = [0, 0, 0];
  const lab = new Float64Array(3);
  for (;;) {
    const stops = chosen.map((j) => {
      const [r, g, b] = oklabToSrgb(curve[j * 3], curve[j * 3 + 1], curve[j * 3 + 2]);
      return [j / (fine - 1), r, g, b];
    });
    let worst = -1, worstErr = -1, totE = 0, totW = 0;
    for (let j = 0; j < fine; j++) {
      if (weight[j] <= 0) continue;
      renderStops(stops, j / (fine - 1), rgb);
      srgbToOklab(Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), lab);
      const e = sq(lab[0] - curve[j * 3]) + sq(lab[1] - curve[j * 3 + 1]) + sq(lab[2] - curve[j * 3 + 2]);
      totE += e * weight[j];
      totW += weight[j];
      if (e * weight[j] > worstErr && chosen.indexOf(j) < 0) { worstErr = e * weight[j]; worst = j; }
    }
    if (chosen.length >= maxStops || worst < 0 || (totW > 0 && totE / totW <= targetSq)) {
      return stops;
    }
    chosen.push(worst);
    chosen.sort((a, b) => a - b);
  }
}

/** Reproduce a renderer's sRGB piecewise-linear stop interpolation at `off`. */
function renderStops(stops: number[][], off: number, out: [number, number, number]): void {
  if (off <= stops[0][0]) { out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3]; return; }
  const last = stops[stops.length - 1];
  if (off >= last[0]) { out[0] = last[1]; out[1] = last[2]; out[2] = last[3]; return; }
  for (let s = 1; s < stops.length; s++) {
    const b = stops[s];
    if (off <= b[0]) {
      const a = stops[s - 1];
      const fr = (off - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * fr;
      out[1] = a[2] + (b[2] - a[2]) * fr;
      out[2] = a[3] + (b[3] - a[3]) * fr;
      return;
    }
  }
  out[0] = last[1]; out[1] = last[2]; out[2] = last[3];
}

// --- small numeric helpers -------------------------------------------------

type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Solve a symmetric 3×3 system by Cramer's rule; null when near-singular. */
function solve3(m: Mat3, r0: number, r1: number, r2: number): [number, number, number] | null {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const x =
    (r0 * (m[4] * m[8] - m[5] * m[7]) - m[1] * (r1 * m[8] - m[5] * r2) + m[2] * (r1 * m[7] - m[4] * r2)) * inv;
  const y =
    (m[0] * (r1 * m[8] - m[5] * r2) - r0 * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * r2 - r1 * m[6])) * inv;
  const z =
    (m[0] * (m[4] * r2 - r1 * m[7]) - m[1] * (m[3] * r2 - r1 * m[6]) + r0 * (m[3] * m[7] - m[4] * m[6])) * inv;
  return [x, y, z];
}

/** Unit top eigenvector of the symmetric 2×2 [[a,b],[b,c]]; null when isotropic. */
function topEigenvector2(a: number, b: number, c: number): [number, number] | null {
  if (a + c < 1e-12) return null; // no colour variation
  const disc = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const lambda = (a + c) / 2 + disc;
  let vx: number, vy: number;
  if (Math.abs(b) > 1e-12) { vx = lambda - c; vy = b; }
  else { vx = a >= c ? 1 : 0; vy = a >= c ? 0 : 1; }
  const len = Math.hypot(vx, vy);
  if (len < 1e-12) return null;
  return [vx / len, vy / len];
}

function sq(v: number): number { return v * v; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp255(v: number): number { return Math.min(255, Math.max(0, Math.round(v))); }
function round(v: number, places: number): number {
  const p = 10 ** places;
  return Math.round(v * p) / p;
}
