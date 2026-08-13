import { oklabToSrgb, srgbToOklab } from '../color.js';
import type { RasterImage } from '../types.js';

/**
 * Colour quantisation, in two stages.
 *
 * 1. **Wu's algorithm** (Graphics Gems II) builds 3-D colour moments on a 32³
 *    grid and repeatedly splits the box whose split buys the largest variance
 *    reduction. It is deterministic — no random seeding — and gets close to the
 *    optimal palette on the first try.
 * 2. **Lloyd relaxation in Oklab** then polishes the palette. Wu minimises
 *    variance in sRGB, where equal numeric distances are not equally visible;
 *    a few k-means passes in a perceptually uniform space move the centroids to
 *    where the eye actually wants them.
 *
 * Doing only step 1 leaves visible banding in skin tones and skies. Doing only
 * step 2 needs a random init and converges to a worse local minimum.
 */

const SIDE = 33; // 32 usable bins plus a zero row for the cumulative moments
const R_STRIDE = SIDE * SIDE; // 1089
const G_STRIDE = SIDE;
const VOLUME = SIDE * SIDE * SIDE; // 35937

function boxIndex(r: number, g: number, b: number): number {
  return r * R_STRIDE + g * G_STRIDE + b;
}

interface Box {
  r0: number; r1: number;
  g0: number; g1: number;
  b0: number; b1: number;
  vol: number;
}

interface Moments {
  /** Cumulative pixel counts. */
  wt: Float64Array;
  mr: Float64Array;
  mg: Float64Array;
  mb: Float64Array;
  /** Cumulative sum of r²+g²+b². */
  m2: Float64Array;
  /** Non-cumulative bin counts, kept for the Lloyd stage. */
  binCount: Float64Array;
  binR: Float64Array;
  binG: Float64Array;
  binB: Float64Array;
  /** Total number of opaque-enough pixels folded into the histogram. */
  total: number;
}

/**
 * Accumulate 3-D colour moments over every pixel whose alpha clears `alphaFloor`.
 *
 * Fully transparent pixels carry no visible colour, so letting them vote would
 * drag palette entries toward whatever garbage RGB the encoder happened to
 * store under alpha 0.
 */
function buildMoments(img: RasterImage, alphaFloor: number): Moments {
  const wt = new Float64Array(VOLUME);
  const mr = new Float64Array(VOLUME);
  const mg = new Float64Array(VOLUME);
  const mb = new Float64Array(VOLUME);
  const m2 = new Float64Array(VOLUME);

  const d = img.data;
  const n = img.width * img.height;
  let total = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (d[o + 3] < alphaFloor) continue;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const idx = boxIndex((r >> 3) + 1, (g >> 3) + 1, (b >> 3) + 1);
    wt[idx] += 1;
    mr[idx] += r;
    mg[idx] += g;
    mb[idx] += b;
    m2[idx] += r * r + g * g + b * b;
    total++;
  }

  // Snapshot the raw bins before they are turned into cumulative sums.
  const binCount = wt.slice();
  const binR = mr.slice();
  const binG = mg.slice();
  const binB = mb.slice();

  accumulate(wt, mr, mg, mb, m2);

  return { wt, mr, mg, mb, m2, binCount, binR, binG, binB, total };
}

/** Convert per-bin moments into 3-D prefix sums so any box sums in O(1). */
function accumulate(
  wt: Float64Array, mr: Float64Array, mg: Float64Array,
  mb: Float64Array, m2: Float64Array,
): void {
  const area = new Float64Array(SIDE);
  const areaR = new Float64Array(SIDE);
  const areaG = new Float64Array(SIDE);
  const areaB = new Float64Array(SIDE);
  const area2 = new Float64Array(SIDE);

  for (let r = 1; r < SIDE; r++) {
    area.fill(0); areaR.fill(0); areaG.fill(0); areaB.fill(0); area2.fill(0);

    for (let g = 1; g < SIDE; g++) {
      let line = 0, lineR = 0, lineG = 0, lineB = 0, line2 = 0;

      for (let b = 1; b < SIDE; b++) {
        const cur = boxIndex(r, g, b);
        line += wt[cur];
        lineR += mr[cur];
        lineG += mg[cur];
        lineB += mb[cur];
        line2 += m2[cur];

        area[b] += line;
        areaR[b] += lineR;
        areaG[b] += lineG;
        areaB[b] += lineB;
        area2[b] += line2;

        const prev = cur - R_STRIDE; // same g,b at r-1
        wt[cur] = wt[prev] + area[b];
        mr[cur] = mr[prev] + areaR[b];
        mg[cur] = mg[prev] + areaG[b];
        mb[cur] = mb[prev] + areaB[b];
        m2[cur] = m2[prev] + area2[b];
      }
    }
  }
}

/** Sum of `m` over a box, by inclusion–exclusion on its eight corners. */
function volume(c: Box, m: Float64Array): number {
  return (
    m[boxIndex(c.r1, c.g1, c.b1)] - m[boxIndex(c.r1, c.g1, c.b0)] -
    m[boxIndex(c.r1, c.g0, c.b1)] + m[boxIndex(c.r1, c.g0, c.b0)] -
    m[boxIndex(c.r0, c.g1, c.b1)] + m[boxIndex(c.r0, c.g1, c.b0)] +
    m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)]
  );
}

type Axis = 'r' | 'g' | 'b';

/** The part of a box's sum that does not depend on where the cut lands. */
function bottom(c: Box, dir: Axis, m: Float64Array): number {
  switch (dir) {
    case 'r':
      return (
        -m[boxIndex(c.r0, c.g1, c.b1)] + m[boxIndex(c.r0, c.g1, c.b0)] +
        m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)]
      );
    case 'g':
      return (
        -m[boxIndex(c.r1, c.g0, c.b1)] + m[boxIndex(c.r1, c.g0, c.b0)] +
        m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)]
      );
    case 'b':
      return (
        -m[boxIndex(c.r1, c.g1, c.b0)] + m[boxIndex(c.r1, c.g0, c.b0)] +
        m[boxIndex(c.r0, c.g1, c.b0)] - m[boxIndex(c.r0, c.g0, c.b0)]
      );
  }
}

/** The part that does depend on the cut position. */
function top(c: Box, dir: Axis, pos: number, m: Float64Array): number {
  switch (dir) {
    case 'r':
      return (
        m[boxIndex(pos, c.g1, c.b1)] - m[boxIndex(pos, c.g1, c.b0)] -
        m[boxIndex(pos, c.g0, c.b1)] + m[boxIndex(pos, c.g0, c.b0)]
      );
    case 'g':
      return (
        m[boxIndex(c.r1, pos, c.b1)] - m[boxIndex(c.r1, pos, c.b0)] -
        m[boxIndex(c.r0, pos, c.b1)] + m[boxIndex(c.r0, pos, c.b0)]
      );
    case 'b':
      return (
        m[boxIndex(c.r1, c.g1, pos)] - m[boxIndex(c.r1, c.g0, pos)] -
        m[boxIndex(c.r0, c.g1, pos)] + m[boxIndex(c.r0, c.g0, pos)]
      );
  }
}

/** Weighted variance of a box — the quantity the splitter tries to reduce. */
function variance(c: Box, m: Moments): number {
  const dr = volume(c, m.mr);
  const dg = volume(c, m.mg);
  const db = volume(c, m.mb);
  const xx = volume(c, m.m2);
  const w = volume(c, m.wt);
  if (w === 0) return 0;
  return xx - (dr * dr + dg * dg + db * db) / w;
}

interface CutCandidate {
  position: number;
  reduction: number;
}

/** Find the cut along `dir` that maximises the resulting variance reduction. */
function maximize(
  c: Box, dir: Axis, first: number, last: number,
  wholeR: number, wholeG: number, wholeB: number, wholeW: number,
  m: Moments,
): CutCandidate {
  const baseR = bottom(c, dir, m.mr);
  const baseG = bottom(c, dir, m.mg);
  const baseB = bottom(c, dir, m.mb);
  const baseW = bottom(c, dir, m.wt);

  let best = -1;
  let bestPos = -1;

  for (let i = first; i < last; i++) {
    let halfR = baseR + top(c, dir, i, m.mr);
    let halfG = baseG + top(c, dir, i, m.mg);
    let halfB = baseB + top(c, dir, i, m.mb);
    let halfW = baseW + top(c, dir, i, m.wt);

    if (halfW === 0) continue; // empty slice on the low side
    let temp = (halfR * halfR + halfG * halfG + halfB * halfB) / halfW;

    halfR = wholeR - halfR;
    halfG = wholeG - halfG;
    halfB = wholeB - halfB;
    halfW = wholeW - halfW;

    if (halfW === 0) continue; // empty slice on the high side
    temp += (halfR * halfR + halfG * halfG + halfB * halfB) / halfW;

    if (temp > best) {
      best = temp;
      bestPos = i;
    }
  }

  return { position: bestPos, reduction: best };
}

/** Split `set1` in two, returning false when the box cannot be divided further. */
function cut(set1: Box, set2: Box, m: Moments): boolean {
  const wholeR = volume(set1, m.mr);
  const wholeG = volume(set1, m.mg);
  const wholeB = volume(set1, m.mb);
  const wholeW = volume(set1, m.wt);

  const cr = maximize(set1, 'r', set1.r0 + 1, set1.r1, wholeR, wholeG, wholeB, wholeW, m);
  const cg = maximize(set1, 'g', set1.g0 + 1, set1.g1, wholeR, wholeG, wholeB, wholeW, m);
  const cb = maximize(set1, 'b', set1.b0 + 1, set1.b1, wholeR, wholeG, wholeB, wholeW, m);

  let dir: Axis;
  if (cr.reduction >= cg.reduction && cr.reduction >= cb.reduction) {
    if (cr.position < 0) return false;
    dir = 'r';
  } else if (cg.reduction >= cr.reduction && cg.reduction >= cb.reduction) {
    dir = 'g';
  } else {
    dir = 'b';
  }

  const chosen = dir === 'r' ? cr : dir === 'g' ? cg : cb;
  if (chosen.position < 0) return false;

  set2.r1 = set1.r1;
  set2.g1 = set1.g1;
  set2.b1 = set1.b1;

  switch (dir) {
    case 'r':
      set2.r0 = set1.r1 = chosen.position;
      set2.g0 = set1.g0;
      set2.b0 = set1.b0;
      break;
    case 'g':
      set2.g0 = set1.g1 = chosen.position;
      set2.r0 = set1.r0;
      set2.b0 = set1.b0;
      break;
    case 'b':
      set2.b0 = set1.b1 = chosen.position;
      set2.r0 = set1.r0;
      set2.g0 = set1.g0;
      break;
  }

  set1.vol = (set1.r1 - set1.r0) * (set1.g1 - set1.g0) * (set1.b1 - set1.b0);
  set2.vol = (set2.r1 - set2.r0) * (set2.g1 - set2.g0) * (set2.b1 - set2.b0);
  return true;
}

export interface QuantizeOptions {
  /** Ignore pixels whose alpha is below this when building the palette. */
  alphaFloor?: number;
  /** Lloyd relaxation passes in Oklab. 0 disables the refinement stage. */
  refineIterations?: number;
}

export interface Palette {
  /** `count * 3` sRGB bytes. */
  rgb: Uint8Array;
  /** `count * 3` Oklab coordinates, for nearest-colour search. */
  lab: Float64Array;
  count: number;
}

/** Build a palette of at most `maxColors` entries for `img`. */
export function quantize(img: RasterImage, maxColors: number, opts: QuantizeOptions = {}): Palette {
  const alphaFloor = opts.alphaFloor ?? 1;
  const k = Math.max(1, Math.min(256, Math.floor(maxColors)));
  const m = buildMoments(img, alphaFloor);

  if (m.total === 0) {
    return { rgb: new Uint8Array([0, 0, 0]), lab: new Float64Array(3), count: 1 };
  }

  const boxes: Box[] = Array.from({ length: k }, () => ({
    r0: 0, r1: 0, g0: 0, g1: 0, b0: 0, b1: 0, vol: 0,
  }));
  boxes[0] = { r0: 0, r1: 32, g0: 0, g1: 32, b0: 0, b1: 32, vol: 32 * 32 * 32 };

  const residual = new Float64Array(k);
  let next = 0;
  let used = 1;

  for (let i = 1; i < k; i++) {
    if (cut(boxes[next], boxes[i], m)) {
      residual[next] = boxes[next].vol > 1 ? variance(boxes[next], m) : 0;
      residual[i] = boxes[i].vol > 1 ? variance(boxes[i], m) : 0;
    } else {
      residual[next] = 0; // this box can never be split again
      i--; // retry the slot with a different parent
    }

    next = 0;
    let worst = residual[0];
    for (let j = 1; j <= i; j++) {
      if (residual[j] > worst) {
        worst = residual[j];
        next = j;
      }
    }
    if (worst <= 0) {
      used = i + 1;
      break;
    }
    used = i + 1;
  }

  const rgb = new Uint8Array(used * 3);
  for (let i = 0; i < used; i++) {
    const w = volume(boxes[i], m.wt);
    if (w > 0) {
      rgb[i * 3] = clamp255(volume(boxes[i], m.mr) / w);
      rgb[i * 3 + 1] = clamp255(volume(boxes[i], m.mg) / w);
      rgb[i * 3 + 2] = clamp255(volume(boxes[i], m.mb) / w);
    } else {
      // Degenerate box: fall back to the centre of its colour cube.
      rgb[i * 3] = clamp255(((boxes[i].r0 + boxes[i].r1) / 2) * 8);
      rgb[i * 3 + 1] = clamp255(((boxes[i].g0 + boxes[i].g1) / 2) * 8);
      rgb[i * 3 + 2] = clamp255(((boxes[i].b0 + boxes[i].b1) / 2) * 8);
    }
  }

  const palette: Palette = { rgb, lab: new Float64Array(used * 3), count: used };
  refineOklab(palette, m, opts.refineIterations ?? 4);
  computeLab(palette);
  return palette;
}

function clamp255(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function computeLab(p: Palette): void {
  for (let i = 0; i < p.count; i++) {
    srgbToOklab(p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], p.lab, i * 3);
  }
}

/**
 * Lloyd relaxation over the 32³ histogram bins, in Oklab.
 *
 * Operating on bins rather than pixels caps the cost at 32768 weighted points
 * regardless of image size, which is what makes this affordable on a 50-megapixel
 * input.
 */
function refineOklab(p: Palette, m: Moments, iterations: number): void {
  if (iterations <= 0) return;

  // Collect non-empty bins as weighted Oklab points.
  const binIdx: number[] = [];
  for (let i = 0; i < VOLUME; i++) if (m.binCount[i] > 0) binIdx.push(i);
  if (binIdx.length <= p.count) return; // fewer distinct colours than slots

  const bins = binIdx.length;
  const pts = new Float64Array(bins * 3);
  const weights = new Float64Array(bins);
  const scratch = new Float64Array(3);

  for (let i = 0; i < bins; i++) {
    const b = binIdx[i];
    const w = m.binCount[b];
    weights[i] = w;
    srgbToOklab(
      clamp255(m.binR[b] / w),
      clamp255(m.binG[b] / w),
      clamp255(m.binB[b] / w),
      scratch,
    );
    pts[i * 3] = scratch[0];
    pts[i * 3 + 1] = scratch[1];
    pts[i * 3 + 2] = scratch[2];
  }

  const centroids = new Float64Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    srgbToOklab(p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], centroids, i * 3);
  }

  const sums = new Float64Array(p.count * 3);
  const totals = new Float64Array(p.count);

  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0);
    totals.fill(0);
    let moved = false;

    for (let i = 0; i < bins; i++) {
      const L = pts[i * 3], A = pts[i * 3 + 1], B = pts[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < p.count; c++) {
        const dL = L - centroids[c * 3];
        const dA = A - centroids[c * 3 + 1];
        const dB = B - centroids[c * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestD) { bestD = d; best = c; }
      }
      const w = weights[i];
      sums[best * 3] += L * w;
      sums[best * 3 + 1] += A * w;
      sums[best * 3 + 2] += B * w;
      totals[best] += w;
    }

    for (let c = 0; c < p.count; c++) {
      if (totals[c] === 0) continue; // orphaned centroid: leave it where it is
      const nL = sums[c * 3] / totals[c];
      const nA = sums[c * 3 + 1] / totals[c];
      const nB = sums[c * 3 + 2] / totals[c];
      if (nL !== centroids[c * 3] || nA !== centroids[c * 3 + 1] || nB !== centroids[c * 3 + 2]) {
        moved = true;
      }
      centroids[c * 3] = nL;
      centroids[c * 3 + 1] = nA;
      centroids[c * 3 + 2] = nB;
    }

    if (!moved) break;
  }

  // Write the relaxed centroids back as sRGB.
  for (let c = 0; c < p.count; c++) {
    const [r, g, b] = oklabToSrgb(centroids[c * 3], centroids[c * 3 + 1], centroids[c * 3 + 2]);
    p.rgb[c * 3] = r;
    p.rgb[c * 3 + 1] = g;
    p.rgb[c * 3 + 2] = b;
  }
}

/**
 * Constant-time nearest-palette lookup backed by a lazily filled 2^24 table.
 *
 * A per-pixel linear scan over 256 palette entries costs billions of operations
 * on a large photo. A direct-indexed cache turns every repeat colour into a
 * single array read, and real images repeat colours constantly.
 */
export class NearestColor {
  private readonly cache: Int16Array | null;
  private readonly map: Map<number, number> | null;
  private readonly scratch = new Float64Array(3);

  constructor(private readonly palette: Palette, expectedPixels: number) {
    // 33 MB of direct-indexed table only pays for itself on larger images.
    if (expectedPixels > 250_000) {
      this.cache = new Int16Array(1 << 24).fill(-1);
      this.map = null;
    } else {
      this.cache = null;
      this.map = new Map();
    }
  }

  index(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    if (this.cache) {
      const hit = this.cache[key];
      if (hit >= 0) return hit;
      const found = this.search(r, g, b);
      this.cache[key] = found;
      return found;
    }
    const hit = this.map!.get(key);
    if (hit !== undefined) return hit;
    const found = this.search(r, g, b);
    this.map!.set(key, found);
    return found;
  }

  private search(r: number, g: number, b: number): number {
    srgbToOklab(r, g, b, this.scratch);
    const L = this.scratch[0], A = this.scratch[1], B = this.scratch[2];
    const lab = this.palette.lab;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < this.palette.count; c++) {
      const dL = L - lab[c * 3];
      const dA = A - lab[c * 3 + 1];
      const dB = B - lab[c * 3 + 2];
      const d = dL * dL + dA * dA + dB * dB;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
}

/**
 * One-dimensional Lloyd clustering over an alpha histogram.
 *
 * Alpha usually takes only a handful of distinct values (0, 255, and a soft
 * edge or two). Quantising it uniformly would spend levels on empty ranges;
 * clustering spends them where the pixels actually are.
 */
export function quantizeAlpha(img: RasterImage, maxLevels: number): Uint8Array {
  const hist = new Float64Array(256);
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) hist[d[i * 4 + 3]]++;

  const present: number[] = [];
  for (let v = 0; v < 256; v++) if (hist[v] > 0) present.push(v);

  // Few enough distinct values to keep them all — the common case.
  if (present.length <= maxLevels) return Uint8Array.from(present);

  // Seed evenly across the observed range, then relax.
  const k = Math.max(1, maxLevels);
  let centers = Array.from({ length: k }, (_, i) =>
    present[Math.min(present.length - 1, Math.round((i * (present.length - 1)) / (k - 1 || 1)))],
  );

  for (let iter = 0; iter < 24; iter++) {
    const sums = new Float64Array(k);
    const counts = new Float64Array(k);
    for (const v of present) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = Math.abs(v - centers[c]);
        if (dd < bestD) { bestD = dd; best = c; }
      }
      sums[best] += v * hist[v];
      counts[best] += hist[v];
    }
    let moved = false;
    const nextCenters = centers.slice();
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const nv = Math.round(sums[c] / counts[c]);
      if (nv !== centers[c]) moved = true;
      nextCenters[c] = nv;
    }
    centers = nextCenters;
    if (!moved) break;
  }

  // Alpha 0 and alpha 255 are visually load-bearing: fully transparent must stay
  // fully transparent, and fully opaque must not develop a haze.
  const levels = new Set(centers);
  if (hist[0] > 0) levels.add(0);
  if (hist[255] > 0) levels.add(255);
  return Uint8Array.from([...levels].sort((x, y) => x - y));
}
