/**
 * Turning lattice polygons into smooth paths.
 *
 * Three stages, each solving a problem the next one cannot:
 *
 * 1. **Douglas–Peucker** finds the structurally important vertices. The raw
 *    crack-following output is a staircase where *every* vertex is a 90° turn,
 *    so angle-based corner detection applied directly to it would call
 *    everything a corner.
 * 2. **Corner detection** on that simplified outline separates genuine sharp
 *    features (the tip of a star) from the gentle bends of a curve.
 * 3. **Schneider least-squares fitting** (Graphics Gems, 1990) fits cubic
 *    Béziers to the *original* lattice points between corners, subdividing
 *    wherever the error exceeds tolerance. Fitting the original points rather
 *    than the simplified ones is what keeps curves faithful — the simplified
 *    outline is used only to decide where to break, never as the data.
 */

import type { Point } from '../types.js';

export interface FitOptions {
  /** Douglas–Peucker tolerance, in pixels, for the structural outline. */
  tolerance: number;
  /** Maximum permitted Bézier fitting error, in pixels. */
  fitError: number;
  /** Turn angle in degrees above which a vertex is treated as a hard corner. */
  cornerAngle: number;
  /** Emit straight segments only — no curve fitting. */
  polygonOnly: boolean;
  /**
   * Merge adjacent curves back together where one curve fits both. Default on.
   * This is the equivalent of potrace's curve-optimisation pass.
   */
  optimize?: boolean;
  /** Error budget for a merge. Defaults to `fitError`. */
  optimizeError?: number;
  /**
   * Snap near-axis right-angle corners to an exact 90° and pin them as hard
   * corners, so rectangular features (UI, screenshots, pixel art) stay crisp
   * instead of being rounded or skewed by the fit. This is imagetracerjs's
   * `rightangleenhance`, generalised from its exact-only test to a tolerance so
   * it also rectifies corners that quantisation left a degree or two off.
   */
  rightAngleEnhance?: boolean;
  /** Degrees of slack allowed from true axis/right angle for {@link rightAngleEnhance}. Default 12. */
  rightAngleThreshold?: number;
}

export type Segment =
  | { kind: 'line'; x: number; y: number }
  | { kind: 'curve'; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

export interface FittedPath {
  start: Point;
  segments: Segment[];
}

const MAX_NEWTON_ITERATIONS = 6;
/** Controls how far Béziers may be from a line before they stop being one. */
const COLLINEAR_EPSILON = 0.05;
/** Longest control handle allowed, as a multiple of the chord it spans. */
const MAX_HANDLE_RATIO = 1;
/** Error band, in multiples of the tolerance, where Newton refinement pays off. */
const NEWTON_BAND = 4;
/** Half-width of the window used to estimate a tangent on a pixel staircase. */
const TANGENT_WINDOW = 4;
/** Merge passes before giving up; each pass can halve the curve count. */
const MAX_OPTIMIZE_PASSES = 8;

/** Fit one closed lattice loop. Returns null if the loop degenerates. */
export function fitLoop(pts: Int32Array, opts: FitOptions): FittedPath | null {
  const n = pts.length / 2;
  if (n < 3) return null;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts[i * 2];
    py[i] = pts[i * 2 + 1];
  }

  // Back off the tolerance rather than let a feature disappear.
  //
  // Every interior vertex of a one-pixel-wide sliver sits less than 1px from the
  // chord across it, so simplifying at the default tolerance leaves fewer than
  // three anchors and the loop would be discarded — deleting a hairline, a
  // one-pixel outline, or a soft alpha edge outright. Losing detail to rounding
  // is a trade-off; losing it to silent deletion is a bug. `minArea` remains the
  // explicit, principled way to drop features that genuinely should go.
  let tolerance = opts.tolerance;
  let anchors = simplifyClosed(px, py, n, tolerance);
  while (anchors.length < 3 && tolerance > 0) {
    tolerance = tolerance > 0.05 ? tolerance / 2 : 0;
    anchors = simplifyClosed(px, py, n, tolerance);
  }
  if (anchors.length < 3) return null;

  // Rectify near-axis right angles before anything downstream reads the anchor
  // positions, so both the polygon and the curve paths see the crisp corner.
  const forcedCorners = opts.rightAngleEnhance
    ? enhanceRightAngles(px, py, anchors, opts.rightAngleThreshold ?? 12)
    : undefined;

  if (opts.polygonOnly) {
    const segments: Segment[] = [];
    for (let i = 1; i < anchors.length; i++) {
      segments.push({ kind: 'line', x: px[anchors[i]], y: py[anchors[i]] });
    }
    segments.push({ kind: 'line', x: px[anchors[0]], y: py[anchors[0]] });
    return { start: { x: px[anchors[0]], y: py[anchors[0]] }, segments };
  }

  const breaks = findBreakpoints(px, py, n, anchors, opts.cornerAngle, forcedCorners);
  const segments: Segment[] = [];

  for (let b = 0; b < breaks.length; b++) {
    const startIdx = breaks[b].index;
    const endIdx = breaks[(b + 1) % breaks.length].index;

    const chain = extractChain(px, py, n, startIdx, endIdx);
    if (chain.x.length < 2) continue;

    const t1 = breaks[b].corner
      ? leftTangent(chain.x, chain.y, 0)
      : centerTangentAt(px, py, n, startIdx);
    const t2 = breaks[(b + 1) % breaks.length].corner
      ? rightTangent(chain.x, chain.y, chain.x.length - 1)
      : negate(centerTangentAt(px, py, n, endIdx));

    const fitted: FittedSegment[] = [];
    fitCubic(chain.x, chain.y, 0, chain.x.length - 1, t1, t2, opts.fitError, fitted);

    // Recursive subdivision only ever splits, never reconsiders. Merging back
    // is where most of the redundancy goes.
    const optimized = opts.optimize === false
      ? fitted
      : optimizeCurves(chain.x, chain.y, fitted, opts.optimizeError ?? opts.fitError);

    for (const f of optimized) segments.push(f.segment);
  }

  if (segments.length === 0) return null;
  return { start: { x: px[breaks[0].index], y: py[breaks[0].index] }, segments };
}

// ---------------------------------------------------------------------------
// Stage 1 — Douglas–Peucker on a closed polygon
// ---------------------------------------------------------------------------

/**
 * A closed polygon has no natural endpoints, so it is cut at its two most
 * extreme vertices first: index 0 and whichever vertex is furthest from it.
 * Running DP on an arbitrary cut would let the algorithm delete the very
 * vertices that define the shape's extent.
 */
function simplifyClosed(
  px: Float64Array, py: Float64Array, n: number, tolerance: number,
): number[] {
  if (n <= 3 || tolerance <= 0) return Array.from({ length: n }, (_, i) => i);

  let far = 0;
  let farDist = -1;
  for (let i = 1; i < n; i++) {
    const d = (px[i] - px[0]) ** 2 + (py[i] - py[0]) ** 2;
    if (d > farDist) { farDist = d; far = i; }
  }
  if (far === 0) return Array.from({ length: n }, (_, i) => i);

  const first: number[] = [];
  douglasPeucker(px, py, 0, far, tolerance, first, (i) => i);
  const second: number[] = [];
  const wrapLength = n - far;
  douglasPeucker(
    px, py, 0, wrapLength, tolerance, second, (i) => (far + i) % n,
  );

  const out = [0, ...first, far, ...second.filter((i) => i !== 0 && i !== far)];
  // `second` closes back onto index 0, which is already the list head.
  return dedupeOrdered(out, n);
}

/**
 * Classic DP over a chain addressed through `map`, so the same routine handles
 * both the straight run and the run that wraps past the end of the array.
 */
function douglasPeucker(
  px: Float64Array, py: Float64Array,
  first: number, last: number, tolerance: number,
  out: number[], map: (i: number) => number,
): void {
  if (last <= first + 1) return;

  const ax = px[map(first)], ay = py[map(first)];
  const bx = px[map(last)], by = py[map(last)];
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let worst = -1;
  let worstDist = tolerance;

  for (let i = first + 1; i < last; i++) {
    const cx = px[map(i)], cy = py[map(i)];
    let dist: number;
    if (lenSq === 0) {
      dist = Math.hypot(cx - ax, cy - ay);
    } else {
      // Perpendicular distance to the infinite line through a and b. The
      // endpoints are fixed anchors, so clamping to the segment is unnecessary.
      dist = Math.abs(dy * cx - dx * cy + bx * ay - by * ax) / Math.sqrt(lenSq);
    }
    if (dist > worstDist) { worstDist = dist; worst = i; }
  }

  if (worst === -1) return;
  douglasPeucker(px, py, first, worst, tolerance, out, map);
  out.push(map(worst));
  douglasPeucker(px, py, worst, last, tolerance, out, map);
}

function dedupeOrdered(indices: number[], n: number): number[] {
  const seen = new Uint8Array(n);
  const out: number[] = [];
  for (const i of indices) {
    if (!seen[i]) { seen[i] = 1; out.push(i); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — corner detection
// ---------------------------------------------------------------------------

interface Breakpoint {
  index: number;
  corner: boolean;
}

/**
 * Rectify near-axis right angles in the simplified outline.
 *
 * imagetracerjs preserves a corner only when it is *exactly* axis-aligned
 * (integer runs sharing a coordinate). That misses the common case: after
 * quantisation and simplification a rectangle's corner is often a degree or two
 * off true, so the exact test never fires and the fit rounds it. Here a corner
 * qualifies when its turn is within `thresholdDeg` of 90° *and* both of its
 * edges are within `thresholdDeg` of an axis; the shared vertex is then moved to
 * the exact intersection of the two axis-aligned lines through its neighbours —
 * `(next.x, prev.y)` or `(prev.x, next.y)` — which snaps the angle to 90°
 * without disturbing the neighbouring anchors.
 *
 * Mutates `px`/`py` in place (both are private to the current loop) and returns
 * the anchor indices to pin as hard corners.
 */
function enhanceRightAngles(
  px: Float64Array, py: Float64Array, anchors: number[], thresholdDeg: number,
): Set<number> {
  const forced = new Set<number>();
  const m = anchors.length;
  if (m < 3) return forced;

  const slack = Math.sin(Math.max(0, thresholdDeg) * (Math.PI / 180));

  for (let i = 0; i < m; i++) {
    const prev = anchors[(i - 1 + m) % m];
    const cur = anchors[i];
    const next = anchors[(i + 1) % m];

    const inDx = px[cur] - px[prev], inDy = py[cur] - py[prev];
    const outDx = px[next] - px[cur], outDy = py[next] - py[cur];
    const inLen = Math.hypot(inDx, inDy), outLen = Math.hypot(outDx, outDy);
    if (inLen === 0 || outLen === 0) continue;

    // Near a right angle: the two directions are near-perpendicular, so their
    // normalised dot product is near zero.
    if (Math.abs((inDx * outDx + inDy * outDy) / (inLen * outLen)) > slack) continue;

    const inHoriz = Math.abs(inDy) / inLen <= slack;
    const inVert = Math.abs(inDx) / inLen <= slack;
    const outHoriz = Math.abs(outDy) / outLen <= slack;
    const outVert = Math.abs(outDx) / outLen <= slack;

    if (inHoriz && outVert) {
      py[cur] = py[prev]; // incoming leg becomes exactly horizontal
      px[cur] = px[next]; // outgoing leg becomes exactly vertical
      forced.add(cur);
    } else if (inVert && outHoriz) {
      px[cur] = px[prev];
      py[cur] = py[next];
      forced.add(cur);
    }
  }

  return forced;
}

function findBreakpoints(
  px: Float64Array, py: Float64Array, n: number,
  anchors: number[], cornerAngleDeg: number,
  forced?: Set<number>,
): Breakpoint[] {
  // `cos` below compares successive edge *directions*: 1 means straight on, 0 a
  // right angle, -1 doubling back. A turn is sharp once it exceeds
  // `cornerAngleDeg`, which is exactly cos falling below cos(cornerAngleDeg).
  const threshold = Math.cos(cornerAngleDeg * (Math.PI / 180));
  const corners: Breakpoint[] = [];
  const m = anchors.length;

  for (let i = 0; i < m; i++) {
    const prev = anchors[(i - 1 + m) % m];
    const cur = anchors[i];
    const next = anchors[(i + 1) % m];

    const ax = px[cur] - px[prev], ay = py[cur] - py[prev];
    const bx = px[next] - px[cur], by = py[next] - py[cur];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;

    const cos = (ax * bx + ay * by) / (la * lb);
    // A right-angle-enhanced corner is pinned sharp even if the fit's own angle
    // test would have let it pass as a gentle bend.
    if (cos < threshold || (forced !== undefined && forced.has(cur))) {
      corners.push({ index: cur, corner: true });
    }
  }

  if (corners.length >= 2) return corners;

  // A shape with no corners (a disc, a blob) still needs somewhere to start and
  // a second point to split it, or `fitCubic` would be asked to fit a closed
  // curve as one open chain. Both breaks are marked smooth so the joins stay G1.
  if (corners.length === 1) {
    const start = anchors.indexOf(corners[0].index);
    const opposite = anchors[(start + Math.floor(m / 2)) % m];
    return [corners[0], { index: opposite, corner: false }];
  }
  return [
    { index: anchors[0], corner: false },
    { index: anchors[Math.floor(m / 2)], corner: false },
  ];
}

/** Collect the original lattice points from `start` to `end`, wrapping if needed. */
function extractChain(
  px: Float64Array, py: Float64Array, n: number, start: number, end: number,
): { x: Float64Array; y: Float64Array } {
  const count = start <= end ? end - start + 1 : n - start + end + 1;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const idx = (start + i) % n;
    x[i] = px[idx];
    y[i] = py[idx];
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Tangent estimation
// ---------------------------------------------------------------------------

/**
 * Averaging several neighbours with 1/j weighting instead of taking the single
 * adjacent point: lattice points sit on a staircase, so one step is always
 * axis-aligned and would give a tangent 45° off the true direction.
 */
function leftTangent(x: Float64Array, y: Float64Array, i: number): Point {
  const k = Math.min(TANGENT_WINDOW, x.length - 1 - i);
  let vx = 0, vy = 0;
  for (let j = 1; j <= k; j++) {
    vx += (x[i + j] - x[i]) / j;
    vy += (y[i + j] - y[i]) / j;
  }
  return normalize(vx, vy);
}

function rightTangent(x: Float64Array, y: Float64Array, i: number): Point {
  const k = Math.min(TANGENT_WINDOW, i);
  let vx = 0, vy = 0;
  for (let j = 1; j <= k; j++) {
    vx += (x[i - j] - x[i]) / j;
    vy += (y[i - j] - y[i]) / j;
  }
  return normalize(vx, vy);
}

/** Smooth tangent at a point on the closed loop, using neighbours on both sides. */
function centerTangentAt(px: Float64Array, py: Float64Array, n: number, i: number): Point {
  const k = Math.max(1, Math.min(TANGENT_WINDOW, Math.floor(n / 2) - 1));
  const before = (i - k + n * 2) % n;
  const after = (i + k) % n;
  return normalize(px[after] - px[before], py[after] - py[before]);
}

function normalize(x: number, y: number): Point {
  const len = Math.hypot(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

function negate(p: Point): Point {
  return { x: -p.x, y: -p.y };
}

// ---------------------------------------------------------------------------
// Stage 3 — Schneider cubic Bézier fitting
// ---------------------------------------------------------------------------

/**
 * A fitted curve plus the data it was fitted to.
 *
 * The point range and end tangents are kept so {@link optimizeCurves} can try
 * re-fitting a span with one curve instead of two. Discarding them, as the
 * published algorithm does, makes that pass impossible: you cannot check
 * whether a merged curve is faithful without the points it has to be faithful to.
 */
interface FittedSegment {
  segment: Segment;
  first: number;
  last: number;
  /** Unit tangent leaving `first`. */
  t1: Point;
  /** Unit tangent leaving `last`, pointing back along the curve. */
  t2: Point;
}

function fitCubic(
  x: Float64Array, y: Float64Array,
  first: number, last: number,
  tHat1: Point, tHat2: Point,
  error: number,
  out: FittedSegment[],
  depth = 0,
): void {
  const nPts = last - first + 1;

  if (nPts === 2) {
    // Two points cannot constrain a curve; Wu & Barsky's heuristic places the
    // control points a third of the way along, honouring the tangents.
    const dist = Math.hypot(x[last] - x[first], y[last] - y[first]) / 3;
    emit(
      x[first] + tHat1.x * dist, y[first] + tHat1.y * dist,
      x[last] + tHat2.x * dist, y[last] + tHat2.y * dist,
      x[first], y[first], x[last], y[last], out, first, last, tHat1, tHat2,
    );
    return;
  }

  let u = chordLengthParameterize(x, y, first, last);
  let bez = generateBezier(x, y, first, last, u, tHat1, tHat2);
  let { maxError, splitPoint } = computeMaxError(x, y, first, last, bez, u);

  if (maxError < error) {
    emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
    return;
  }

  // Newton–Raphson reparameterisation is worth trying only when the fit is
  // already close; far from the answer it diverges and wastes the iterations.
  if (maxError < error * NEWTON_BAND) {
    for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
      const uPrime = reparameterize(x, y, first, last, u, bez);
      bez = generateBezier(x, y, first, last, uPrime, tHat1, tHat2);
      const next = computeMaxError(x, y, first, last, bez, uPrime);
      if (next.maxError < error) {
        emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
        return;
      }
      u = uPrime;
      maxError = next.maxError;
      splitPoint = next.splitPoint;
    }
  }

  // Guard against pathological inputs driving unbounded recursion.
  if (depth > 24 || splitPoint <= first || splitPoint >= last) {
    emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
    return;
  }

  const tCenter = centerTangentOfChain(x, y, splitPoint);
  fitCubic(x, y, first, splitPoint, tHat1, negate(tCenter), error, out, depth + 1);
  fitCubic(x, y, splitPoint, last, tCenter, tHat2, error, out, depth + 1);
}

/**
 * Tangent at an interior split point.
 *
 * The single-step version from the published algorithm reads one lattice step
 * either side, which on a staircase can only ever produce one of eight
 * directions — and feeding a 45°-wrong tangent into the least-squares solve is
 * what makes it ill-conditioned in the first place. Widening the window costs
 * nothing and gives a direction that reflects the actual local slope.
 */
/**
 * Merge adjacent curves wherever a single curve fits both within tolerance.
 *
 * The fitter only ever *splits*: when a span is too inaccurate it subdivides at
 * the worst point and fits each half. Nothing ever revisits that decision, so
 * the output carries splits that were needed at the time but are not needed in
 * the final shape — a split made near a sharp bend often leaves two nearly
 * collinear curves on the far side of it.
 *
 * This is potrace's curve-optimisation idea: repeatedly try replacing each
 * adjacent pair with one curve fitted to the same underlying points, and keep
 * the replacement whenever it stays inside the error budget. Every merge is
 * checked against the original lattice points rather than against the curves it
 * replaces, so the error bound is unchanged.
 *
 * **It helps far less here than it does in potrace, and the reason is worth
 * knowing.** potrace fits curves to a polygon and can be left with adjacent
 * curves that were never tested together. Schneider subdivision only splits when
 * a single curve *provably* exceeded the tolerance, so re-fitting that same span
 * usually fails the identical test. Measured over discs, rings and lobed blobs:
 * 60 merge candidates on a disc, 2 accepted, median merged-fit error 1.23x the
 * budget. Segment counts drop by 0–13% depending on the shape, most often 0.
 *
 * It is kept because it is never harmful — a merge is only taken when it passes
 * the same error test the split failed — and occasionally removes a tenth of the
 * curves. It is not the reason potrace beats this fitter on photographs.
 */
function optimizeCurves(
  x: Float64Array, y: Float64Array,
  segments: FittedSegment[],
  error: number,
): FittedSegment[] {
  if (segments.length < 2) return segments;

  let current = segments;

  for (let pass = 0; pass < MAX_OPTIMIZE_PASSES; pass++) {
    const merged: FittedSegment[] = [];
    let changed = false;
    let i = 0;

    while (i < current.length) {
      const a = current[i];
      const b = current[i + 1];

      if (!b || b.first !== a.last) {
        merged.push(a);
        i++;
        continue;
      }

      const candidate = tryMerge(x, y, a, b, error);
      if (candidate) {
        merged.push(candidate);
        changed = true;
        i += 2; // both consumed
      } else {
        merged.push(a);
        i++;
      }
    }

    current = merged;
    if (!changed) break;
  }

  return current;
}

/** Fit one curve across two adjacent spans; null when it would drift too far. */
function tryMerge(
  x: Float64Array, y: Float64Array,
  a: FittedSegment, b: FittedSegment,
  error: number,
): FittedSegment | null {
  const first = a.first;
  const last = b.last;
  if (last - first < 2) return null;

  const u = chordLengthParameterize(x, y, first, last);
  const bez = generateBezier(x, y, first, last, u, a.t1, b.t2);
  const { maxError } = computeMaxError(x, y, first, last, bez, u);
  if (maxError > error) return null;

  const out: FittedSegment[] = [];
  emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, a.t1, b.t2);
  return out[0] ?? null;
}

function centerTangentOfChain(x: Float64Array, y: Float64Array, i: number): Point {
  const k = Math.min(TANGENT_WINDOW, i, x.length - 1 - i);
  if (k < 1) return normalize(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]);
  return normalize(x[i + k] - x[i - k], y[i + k] - y[i - k]);
}

/** Push a curve, or a line when the control points turn out to be collinear. */
function emit(
  c1x: number, c1y: number, c2x: number, c2y: number,
  p0x: number, p0y: number, p3x: number, p3y: number,
  out: FittedSegment[],
  first: number, last: number, t1: Point, t2: Point,
): void {
  const dx = p3x - p0x, dy = p3y - p0y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const d1 = Math.abs(dy * c1x - dx * c1y + p3x * p0y - p3y * p0x) / len;
    const d2 = Math.abs(dy * c2x - dx * c2y + p3x * p0y - p3y * p0x) / len;
    if (d1 < COLLINEAR_EPSILON && d2 < COLLINEAR_EPSILON) {
      out.push({ segment: { kind: 'line', x: p3x, y: p3y }, first, last, t1, t2 });
      return;
    }
  }
  out.push({
    segment: { kind: 'curve', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: p3x, y: p3y },
    first, last, t1, t2,
  });
}

/** Parameter values proportional to accumulated chord length. */
function chordLengthParameterize(
  x: Float64Array, y: Float64Array, first: number, last: number,
): Float64Array {
  const u = new Float64Array(last - first + 1);
  for (let i = first + 1; i <= last; i++) {
    u[i - first] = u[i - first - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  const total = u[last - first];
  if (total > 0) for (let i = 1; i <= last - first; i++) u[i] /= total;
  return u;
}

/**
 * Least-squares fit with the endpoints and both tangent *directions* fixed;
 * only the two control-point distances are solved for. Returns a flat
 * `[p0, c1, c2, p3]`.
 */
function generateBezier(
  x: Float64Array, y: Float64Array,
  first: number, last: number,
  u: Float64Array, tHat1: Point, tHat2: Point,
): Float64Array {
  const nPts = last - first + 1;

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 0; i < nPts; i++) {
    const t = u[i];
    const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);

    const a0x = tHat1.x * b1, a0y = tHat1.y * b1;
    const a1x = tHat2.x * b2, a1y = tHat2.y * b2;

    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;

    // Residual after accounting for the fixed endpoints.
    const tmpX = x[first + i] - (x[first] * (b0 + b1) + x[last] * (b2 + b3));
    const tmpY = y[first + i] - (y[first] * (b0 + b1) + y[last] * (b2 + b3));

    x0 += a0x * tmpX + a0y * tmpY;
    x1 += a1x * tmpX + a1y * tmpY;
  }

  const detC = c00 * c11 - c01 * c01;
  const detXC1 = x0 * c11 - c01 * x1;
  const detC0X = c00 * x1 - c01 * x0;

  let alphaL = detC === 0 ? 0 : detXC1 / detC;
  let alphaR = detC === 0 ? 0 : detC0X / detC;

  const segLength = Math.hypot(x[last] - x[first], y[last] - y[first]);
  const epsilon = 1e-6 * segLength;

  // A negative or vanishing alpha means the least-squares answer folds the
  // curve back on itself; fall back to the same heuristic used for two points.
  if (alphaL < epsilon || alphaR < epsilon) {
    alphaL = alphaR = segLength / 3;
  }

  // Clamp the upper end too, which the published algorithm does not.
  //
  // Fitting to a pixel staircase makes the normal equations ill-conditioned:
  // the sampled points barely constrain the tangent directions, `detC` comes out
  // near zero, and the solve answers with a control handle ten times longer than
  // the chord it spans. The curve then flies far outside the shape before coming
  // back. No cubic that stays near its chord needs a handle longer than the
  // chord itself — a quarter circle, the tightest common case, uses about 0.55 —
  // so clamping there discards only garbage.
  const maxAlpha = segLength * MAX_HANDLE_RATIO;
  if (alphaL > maxAlpha) alphaL = maxAlpha;
  if (alphaR > maxAlpha) alphaR = maxAlpha;

  return new Float64Array([
    x[first], y[first],
    x[first] + tHat1.x * alphaL, y[first] + tHat1.y * alphaL,
    x[last] + tHat2.x * alphaR, y[last] + tHat2.y * alphaR,
    x[last], y[last],
  ]);
}

function computeMaxError(
  x: Float64Array, y: Float64Array,
  first: number, last: number,
  bez: Float64Array, u: Float64Array,
): { maxError: number; splitPoint: number } {
  let maxError = 0;
  let splitPoint = Math.floor((last - first + 1) / 2) + first;

  for (let i = first + 1; i < last; i++) {
    const p = bezierAt(bez, u[i - first]);
    const dist = (p.x - x[i]) ** 2 + (p.y - y[i]) ** 2;
    if (dist >= maxError) {
      maxError = dist;
      splitPoint = i;
    }
  }
  return { maxError: Math.sqrt(maxError), splitPoint };
}

/** One Newton–Raphson step per point, improving the parameter assignment. */
function reparameterize(
  x: Float64Array, y: Float64Array,
  first: number, last: number,
  u: Float64Array, bez: Float64Array,
): Float64Array {
  const out = new Float64Array(u.length);
  for (let i = first; i <= last; i++) {
    out[i - first] = newtonRaphsonRootFind(bez, x[i], y[i], u[i - first]);
  }
  return out;
}

function newtonRaphsonRootFind(bez: Float64Array, px: number, py: number, u: number): number {
  const q = bezierAt(bez, u);
  const d1 = derivativeAt(bez, u, 1);
  const d2 = derivativeAt(bez, u, 2);

  const numerator = (q.x - px) * d1.x + (q.y - py) * d1.y;
  const denominator = d1.x * d1.x + d1.y * d1.y + (q.x - px) * d2.x + (q.y - py) * d2.y;

  if (denominator === 0) return u;
  return u - numerator / denominator;
}

function bezierAt(bez: Float64Array, t: number): Point {
  const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);
  return {
    x: bez[0] * b0 + bez[2] * b1 + bez[4] * b2 + bez[6] * b3,
    y: bez[1] * b0 + bez[3] * b1 + bez[5] * b2 + bez[7] * b3,
  };
}

/** First or second derivative of the cubic, via its hodograph. */
function derivativeAt(bez: Float64Array, t: number, order: 1 | 2): Point {
  const q = new Float64Array(6);
  for (let i = 0; i < 3; i++) {
    q[i * 2] = (bez[(i + 1) * 2] - bez[i * 2]) * 3;
    q[i * 2 + 1] = (bez[(i + 1) * 2 + 1] - bez[i * 2 + 1]) * 3;
  }
  if (order === 1) {
    const mt = 1 - t;
    return {
      x: q[0] * mt * mt + q[2] * 2 * mt * t + q[4] * t * t,
      y: q[1] * mt * mt + q[3] * 2 * mt * t + q[5] * t * t,
    };
  }
  const r = new Float64Array(4);
  for (let i = 0; i < 2; i++) {
    r[i * 2] = (q[(i + 1) * 2] - q[i * 2]) * 2;
    r[i * 2 + 1] = (q[(i + 1) * 2 + 1] - q[i * 2 + 1]) * 2;
  }
  return {
    x: r[0] * (1 - t) + r[2] * t,
    y: r[1] * (1 - t) + r[3] * t,
  };
}

// Cubic Bernstein basis.
function B0(t: number): number { const m = 1 - t; return m * m * m; }
function B1(t: number): number { const m = 1 - t; return 3 * t * m * m; }
function B2(t: number): number { const m = 1 - t; return 3 * t * t * m; }
function B3(t: number): number { return t * t * t; }
