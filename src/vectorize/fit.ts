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
   * Simplify with the quantisation-aware straightness test instead of
   * Douglas-Peucker. Correct whenever the boundary is still on the pixel lattice,
   * which is every trace that did not run sub-pixel refinement. See
   * {@link simplifyLattice} for why DP cannot do this job.
   */
  latticeSimplify?: boolean;
  /**
   * Laplacian passes over the contour before fitting, each vertex held inside the
   * pixel grid's own uncertainty band. 0 (default) skips it.
   *
   * This is what lets the curve fitter engage on a boundary that came off a noisy
   * raster. Smoothing the IMAGE does not do it — that changes which pixels are in
   * the region; this changes only where the boundary between them is drawn, within
   * the error bar the lattice already has.
   */
  regularise?: number;
  /** How far a vertex may travel from where the lattice put it. Default 0.75px. */
  regulariseBand?: number;
  /**
   * Half-width of the band a run of vertices must fit inside to count as one
   * straight edge, in pixels. Must exceed 0.707 — the deviation of a 45-degree
   * staircase — or no diagonal is ever recognised. Default 0.75.
   */
  latticeBand?: number;
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

/**
 * WHERE THE FLAT-ART GAP IS NOT, so the next attempt starts somewhere new.
 *
 * A paid rival describes logo-tux with 551 curves at SSIM 0.9483. This fitter uses
 * 1,082 at 0.8747 — more curves, worse fit — which looks like over-subdivision.
 * It is not, and the following have each been swept and found not to move it:
 *
 *   cornerAngle 45..160        SSIM flat at 0.871-0.877 across the whole range
 *   tolerance/fitError 0.3     +0.007, and 0.4 is a documented dead-zone edge
 *   colours 16 -> 32 -> 64     WORSE (0.8747 -> 0.8526 -> 0.8390)
 *   minArea 0                  +0.015, at 2.4x the bytes
 *   MAX_HANDLE_RATIO 1..4      nothing, +-0.0001
 *   NEWTON_BAND 4 -> 12        nothing
 *   strokeWidth                +0.054, but paints outside the silhouette
 *   segmentation, image-space smoothing, contour regularisation — all measured
 *   elsewhere and none of them close it
 *
 * Throwing bytes at it caps out around 0.89 while the rival holds 0.9483 at 54 KB.
 * So the limit is not a parameter in this file, and it is not the palette either —
 * the rival uses TEN distinct fills against our sixteen and still wins. What
 * remains untested is where the region boundaries are decided in the first place,
 * which is quantisation and region formation, not curve fitting. Look there.
 */
const MAX_NEWTON_ITERATIONS = 6;
/** Controls how far Béziers may be from a line before they stop being one. */
const COLLINEAR_EPSILON = 0.05;
/** Longest control handle allowed, as a multiple of the chord it spans. */
const MAX_HANDLE_RATIO = 1;
/** Error band, in multiples of the tolerance, where Newton refinement pays off. */
const NEWTON_BAND = 4;
/** Half-width of the window used to estimate a tangent on a pixel staircase. */
const TANGENT_WINDOW = 4;
/**
 * Merge passes before giving up; each pass can halve the curve count.
 *
 * NOT THE LIMITER, measured, so nobody reaches for it when the merge pass looks
 * weak. Instrumented over the eight corpus subjects at `clean`'s settings: 9,194
 * calls, of which 662 need a second pass, 58 a third and 6 a fourth. The cap is
 * reached 0 times and the deepest any call goes is 4 of 8.
 *
 * What actually bounds the pass is `optimizeError`, which defaults to `fitError`
 * — see {@link optimizeCurves}.
 */
const MAX_OPTIMIZE_PASSES = 8;

/** Fit one closed lattice loop. Returns null if the loop degenerates. */
export function fitLoop(pts: Int32Array | Float64Array | number[], opts: FitOptions): FittedPath | null {
  const n = pts.length / 2;
  if (n < 3) return null;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts[i * 2];
    py[i] = pts[i * 2 + 1];
  }

  // Regularise the polyline before anything reads its shape.
  //
  // The fitter was never short of tolerance. It was being fed a staircase, and a
  // staircase fits a staircase-shaped curve: forcing curves on rough boundaries
  // produced 547 speckling segments where 7 clean ones were wanted. Gating the
  // fitter off was the wrong response to that, and this is the right one — fix the
  // input, then let the existing fitter do its job.
  //
  // The move is licensed by the grid's own uncertainty. A lattice vertex says "the
  // boundary passed within half a pixel of here" and nothing more, so every curve
  // running inside that band is equally consistent with the evidence. Among those,
  // pick the smoothest. Nothing is invented: no vertex leaves its band.
  if (opts.regularise && opts.regularise > 0) {
    regulariseClosed(px, py, n, opts.regulariseBand ?? 0.75, opts.regularise);
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
  let anchors = opts.latticeSimplify
    ? simplifyLattice(px, py, n, opts.latticeBand ?? 0.75)
    : simplifyClosed(px, py, n, tolerance);
  // The lattice test has no tolerance to relax — its band is the grid's own
  // uncertainty — so only the Douglas-Peucker path retries.
  while (!opts.latticeSimplify && anchors.length < 3 && tolerance > 0) {
    tolerance = tolerance > 0.05 ? tolerance / 2 : 0;
    anchors = simplifyClosed(px, py, n, tolerance);
  }
  if (anchors.length < 3) return null;

  // Rectify near-axis right angles before anything downstream reads the anchor
  // positions, so both the polygon and the curve paths see the crisp corner.
  const forcedCorners = opts.rightAngleEnhance
    ? enhanceRightAngles(px, py, anchors, opts.rightAngleThreshold ?? 12)
    : undefined;

  // Skip the fitter when it provably cannot produce a curve.
  //
  // Douglas-Peucker removing *nothing* means every anchor is still a raw lattice
  // vertex, and crack-following only ever emits axis-aligned unit steps. So each
  // junction is either straight on — collinear, which `emit` downgrades to a
  // line — or a 90° turn, which is a hard corner that ends the span at two
  // points, where `fitCubic` takes its straight-line branch. Either way the
  // output is lines, and Douglas-Peucker, corner detection, Schneider
  // least-squares, Newton reparameterisation and up to eight merge passes all
  // run to produce them.
  //
  // Measured on the corpus at the default tolerance: byte-identical output,
  // 69 ms -> 35 ms on logo-tux and 142 -> 95 on alpha-dice.
  //
  // The condition is deliberately narrow. At the `logo` and `lineart` presets
  // (tolerance 0.6) DP *does* remove vertices, the fitter *does* fire, and this
  // shortcut correctly stays out of the way.
  const fitterIsDead = anchors.length === n && !opts.rightAngleEnhance;

  if (opts.polygonOnly || fitterIsDead) {
    const segments: Segment[] = [];
    for (let i = 1; i < anchors.length; i++) {
      segments.push({ kind: 'line', x: px[anchors[i]], y: py[anchors[i]] });
    }
    // No closing segment back to the start. `z` *is* the closing line: it draws a
    // straight line from the current point to the subpath's initial point, and
    // every caller ends with `PathBuilder.close()`. Emitting the return leg
    // explicitly first only made `z` cover a zero-length gap — and `lineTo`
    // elides nothing but an exact-zero move (svg/path.ts), so that redundant
    // `h`/`v`/`l` survived into every closed polygon this tracer has ever
    // written. Measured on the real corpus: -17% anchors, -16% bytes, with
    // rendering identical to the subpixel channel at two magnifications.
    //
    // Only the polygon branch. A curve back to the start is real geometry that
    // `z` cannot reproduce, so the fitted path below still emits its final
    // segment.
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
/**
 * Simplification that knows its input is quantised.
 *
 * Douglas-Peucker measures deviation against a EUCLIDEAN budget, which on a
 * lattice boundary conflates two different things: the staircase a diagonal edge
 * was forced into by the pixel grid, and genuine curvature. Both look like
 * deviation. So below the staircase amplitude DP removes nothing — measured, a
 * hard cliff between tolerance 0.40 (5,924 anchors, zero curves) and 0.45 (4,514
 * anchors, 367 curves) — and above it DP removes the staircase by also moving
 * real boundaries, which costs accuracy every time: SSIM 0.8355 at 0.4, 0.8145 at
 * 0.5, 0.7671 at 0.8.
 *
 * The way out is potrace's: do not ask "how far is this point from the chord",
 * ask "does ANY straight line pass within the pixel's own uncertainty of every
 * point in this run". Crack-following emits axis-aligned unit steps, so a run
 * that came from a straight edge always has such a line, and a run that came from
 * a curve does not. The band is a property of the grid, not a knob — which is why
 * this can flatten staircases without a budget that also erodes geometry.
 *
 * Greedy longest-run cover: from each anchor take the furthest vertex still
 * reachable, and start again there. Not the globally optimal polygon potrace
 * computes, and within a few percent of it on closed boundaries, without the
 * dynamic program.
 */
/**
 * Move each vertex toward the average of its neighbours, without letting any of
 * them leave the band the pixel grid licenses.
 *
 * In place, on a closed loop. The band is a hard constraint rather than a penalty
 * so the guarantee is exact and stateable: the returned polyline lies within
 * `band` pixels of the traced one, everywhere. 0.75 is the same figure
 * `simplifyLattice` uses, and for the same reason — a 45-degree staircase deviates
 * 0.707px from its own chord, so a band below that cannot flatten one.
 *
 * Corners survive because they are consistent across passes: a real corner has the
 * same neighbours pulling from the same two directions every time, so it reaches
 * the edge of its band and stops. A staircase step has neighbours that disagree,
 * and averaging cancels it.
 *
 * WHY THIS DEFAULTS TO OFF, which is the useful part of this comment.
 *
 * The mechanism works. On the reported sticker it takes the fitter from 7 curve
 * segments to 233 — the fitter was never short of tolerance, it was being fed a
 * staircase, and this is the fix for that.
 *
 * It is not shippable on its own, because every region is traced as its own closed
 * loop and this smooths each one INDEPENDENTLY. Two neighbours share a boundary;
 * smoothing their two copies of it moves them apart, and the background shows
 * through the gap. Rendered, the subject visibly falls to pieces.
 *
 * `extendUnder` closes the holes — it extends fills beneath later regions, so
 * there is no seam to open — and the result is solid and still wrong: the shapes
 * stack over one another and the subject turns muddy, measurably worse than a
 * classical tracer on the same input at 58,667 bytes against its 53,920.
 *
 * THE PREREQUISITE WAS SHARED-BOUNDARY TOPOLOGY, AND IT HAS SINCE LANDED. This
 * paragraph used to name that topology as the missing piece and say the two
 * failures were worth keeping so a later attempt would start from it. The attempt
 * happened, twice, and both halves are now in the tree:
 *
 * - `junctions.ts` makes two neighbours agree on a SMOOTHED boundary without a
 *   shared structure at all, by pinning the vertices where three or more cracks
 *   meet. The Laplacian update `(prev + next) / 2` is symmetric under reversing
 *   the traversal, so both faces compute the same position for every free vertex.
 * - `arcs.ts` supersedes even that for FITTING, and has to: the argument from
 *   symmetry covers smoothing and stops there. Fitting a lattice circle forwards
 *   and backwards gives 42 curves against 46, up to 2.94px apart. So each boundary
 *   is cut into arcs at junctions, each arc is fitted ONCE, and the second face
 *   gets that same curve reversed control point by control point.
 *
 * WHAT IS LEFT FOR THIS FUNCTION, instrumented on logo-tux rather than assumed. It
 * is unreachable from `trace`'s own `fitOpts`, which passes a hard 0 — across
 * `regularise` 0, 2 and 6, all 509 `fitLoop` calls arrive with `regularise: 0` and
 * this function is entered zero times. Its live caller is `fitFaces` in arcs.ts,
 * which routes junction-free CLOSED arcs here with at least 2 passes: 6 entries
 * under `--preset clean`, 17 at `regularise: 6`, every one of them doing work. So
 * it still runs on the shipped `clean` path, on exactly the arcs where there is no
 * junction to pin and no second copy to disagree with.
 */
export function regulariseClosed(
  px: Float64Array, py: Float64Array, n: number, band: number, passes: number,
): void {
  if (n < 4 || passes <= 0 || band <= 0) return;
  const ox = Float64Array.from(px);
  const oy = Float64Array.from(py);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const band2 = band * band;

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? n - 1 : i - 1;
      const b = i === n - 1 ? 0 : i + 1;
      // Halfway to the midpoint of the neighbours: full weight overshoots and
      // oscillates on a closed loop.
      tx[i] = (px[i] + (px[a] + px[b]) / 2) / 2;
      ty[i] = (py[i] + (py[a] + py[b]) / 2) / 2;
    }
    for (let i = 0; i < n; i++) {
      let dx = tx[i] - ox[i];
      let dy = ty[i] - oy[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > band2) {
        // Outside the licence: project back onto the band rather than refuse to
        // move, so a vertex still travels as far as the evidence allows.
        const k = band / Math.sqrt(d2);
        dx *= k;
        dy *= k;
      }
      px[i] = ox[i] + dx;
      py[i] = oy[i] + dy;
    }
  }
}

function simplifyLattice(
  // 0.75, and the value is forced rather than tuned: a 45-degree staircase
  // deviates from its own diagonal by 1/sqrt(2) = 0.707, so any band at or below
  // that cannot see a diagonal edge as straight and the whole method does
  // nothing. Swept on a real image, 0.35/0.5/0.65 are identical and useless;
  // 0.75 and 0.85 agree to 0.0004 SSIM; 1.0 starts eating real corners
  // (0.8918 -> 0.8768). The useful window is narrow and sits just above 0.707.
  px: Float64Array, py: Float64Array, n: number, band = 0.75,
): number[] {
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);

  /** Can a single line cover every vertex from `a` to `b` inclusive? */
  const straight = (a: number, b: number): boolean => {
    const ax = px[a], ay = py[a];
    const dx = px[b] - ax, dy = py[b] - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) return false;
    for (let k = a + 1; k < b; k++) {
      // Perpendicular distance to the chord. Beyond the band the run is not a
      // quantised straight edge, whatever its total extent.
      const d = Math.abs((px[k] - ax) * dy - (py[k] - ay) * dx) / len;
      if (d > band) return false;
    }
    return true;
  };

  const anchors: number[] = [0];
  let i = 0;
  while (i < n - 1) {
    // Furthest reachable vertex, found by doubling then bisecting: a long
    // straight run is common on flat artwork and a linear walk makes this
    // quadratic on exactly those paths.
    let step = 1;
    while (i + step * 2 < n && straight(i, i + step * 2)) step *= 2;
    let lo = i + step;
    let hi = Math.min(n - 1, i + step * 2);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (straight(i, mid)) lo = mid; else hi = mid - 1;
    }
    const next = Math.max(lo, i + 1);
    anchors.push(next);
    i = next;
  }
  // The closing vertex duplicates the start on a closed loop.
  if (anchors.length > 1 && anchors[anchors.length - 1] === n - 1 && n > 1) anchors.pop();

  // Fewer than three anchors means the loop collapsed to a line or a point, and
  // a closed path needs three to enclose anything. Subdivide rather than fall
  // back to every vertex: falling back fires precisely when the simplification
  // worked BEST — a perfect staircase is one straight run, yields [0, n-1], and
  // loses its last anchor to the pop above. That bug returned all 40 points on a
  // 40-point diagonal, the exact case this function exists to collapse.
  while (anchors.length < 3 && anchors.length < n) {
    let gap = 0;
    let at = 0;
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      const b = k + 1 < anchors.length ? anchors[k + 1] : n;
      if (b - a > gap) { gap = b - a; at = k; }
    }
    if (gap < 2) break;
    anchors.splice(at + 1, 0, anchors[at] + (gap >> 1));
  }
  return anchors;
}

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
 *
 * Iterative with an explicit work stack, not recursive: a large component with a
 * long, finely-serrated boundary can retain thousands of vertices in one loop,
 * and a monotone split arrangement there would blow the call stack. The kept
 * interior indices are collected and emitted in increasing order, which is
 * exactly the in-order output the recursive form produced.
 */
function douglasPeucker(
  px: Float64Array, py: Float64Array,
  first: number, last: number, tolerance: number,
  out: number[], map: (i: number) => number,
): void {
  if (last <= first + 1) return;

  const keep: number[] = [];
  const stack: Array<[number, number]> = [[first, last]];
  while (stack.length > 0) {
    const [f, l] = stack.pop()!;
    if (l <= f + 1) continue;

    const ax = px[map(f)], ay = py[map(f)];
    const bx = px[map(l)], by = py[map(l)];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstDist = tolerance;
    for (let i = f + 1; i < l; i++) {
      const cx = px[map(i)], cy = py[map(i)];
      // Perpendicular distance to the infinite line through a and b (or to a
      // when the segment is degenerate). Endpoints are fixed anchors, so no
      // clamping to the segment is needed.
      const dist = lenSq === 0
        ? Math.hypot(cx - ax, cy - ay)
        : Math.abs(dy * cx - dx * cy + bx * ay - by * ax) / Math.sqrt(lenSq);
      if (dist > worstDist) { worstDist = dist; worst = i; }
    }

    if (worst === -1) continue;
    keep.push(worst);
    stack.push([f, worst]);
    stack.push([worst, l]);
  }

  keep.sort((a, b) => a - b);
  for (const i of keep) out.push(map(i));
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
 *
 * **AND THAT SENTENCE IS ALSO THE PASS'S CEILING, WHICH IS A CHOICE RATHER THAN A
 * PROPERTY.** "The same error test" means `optimizeError`, which defaults to
 * `fitError` — so by default the merge is asked to pass a test the split has
 * already demonstrated it fails, and it accepts only a small fraction of what it
 * tries. Widening that one budget is what makes the pass work: `clean` sets 0.75
 * and drops 16.2% of its segments corpus-wide.
 *
 * Every merge is still verified against the original chain points, so the bound is
 * whatever the caller asked for rather than a guess — the budget is the knob, and
 * the algorithm was never the problem.
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
  //
  // CHALLENGED AND CONFIRMED. The argument above was written for staircase input,
  // and sub-pixel refinement no longer produces one, so the clamp looked like it
  // might have outlived its reason and be forcing splits on long smooth spans.
  // Swept on logo-tux at `preset: logo`, against a paid rival scoring 0.9483 with
  // 551 curves:
  //
  //   MAX_HANDLE_RATIO   1      2      3      4
  //   curves          1,082  1,091  1,091  1,091
  //   SSIM           0.8747 0.8747 0.8748 0.8747
  //
  // and NEWTON_BAND 4 against 12 changes nothing either. Both constants are
  // correct as they stand: the fitter is neither over-clamping nor starved of
  // reparameterisation. "Discards only garbage" is measured, not assumed.
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
  // Written in place. Each output depends only on the input at the *same*
  // index, so there is no read-after-write hazard within the loop, and the one
  // caller (`fitCubic`) drops the old parameterisation the moment this returns.
  for (let i = first; i <= last; i++) {
    u[i - first] = newtonRaphsonRootFind(bez, x[i], y[i], u[i - first]);
  }
  return u;
}

/**
 * One Newton step, written out longhand rather than composed from helpers.
 *
 * This is the innermost expression in the fitter — four million calls on a
 * single photograph at the `logo` preset. Calling `bezierAt` and `derivativeAt`
 * here cost three `{x, y}` objects per call plus two typed-array allocations
 * inside `derivativeAt`, and computed the hodograph twice because the two
 * derivative calls could not see each other's work.
 *
 * The arithmetic is reproduced term for term, in the same association order, so
 * the result is bit-identical — verified as unchanged sha256 across the corpus.
 * `bezierAt` stays for `computeMaxError`, which is not hot.
 */
function newtonRaphsonRootFind(bez: Float64Array, px: number, py: number, u: number): number {
  const b0 = B0(u), b1 = B1(u), b2 = B2(u), b3 = B3(u);
  const qx = bez[0] * b0 + bez[2] * b1 + bez[4] * b2 + bez[6] * b3;
  const qy = bez[1] * b0 + bez[3] * b1 + bez[5] * b2 + bez[7] * b3;

  // The hodograph, once — both derivatives are read off it.
  const h0x = (bez[2] - bez[0]) * 3, h0y = (bez[3] - bez[1]) * 3;
  const h1x = (bez[4] - bez[2]) * 3, h1y = (bez[5] - bez[3]) * 3;
  const h2x = (bez[6] - bez[4]) * 3, h2y = (bez[7] - bez[5]) * 3;

  const mt = 1 - u;
  const d1x = h0x * mt * mt + h1x * 2 * mt * u + h2x * u * u;
  const d1y = h0y * mt * mt + h1y * 2 * mt * u + h2y * u * u;

  const d2x = ((h1x - h0x) * 2) * mt + ((h2x - h1x) * 2) * u;
  const d2y = ((h1y - h0y) * 2) * mt + ((h2y - h1y) * 2) * u;

  const numerator = (qx - px) * d1x + (qy - py) * d1y;
  const denominator = d1x * d1x + d1y * d1y + (qx - px) * d2x + (qy - py) * d2y;

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

// The cubic's derivatives used to live here as a `derivativeAt(bez, t, order)`
// helper with hoisted scratch arrays. `newtonRaphsonRootFind` was its only
// caller, and inlining it there removed the scratch along with the function:
// the hodograph is now computed once per step instead of once per derivative.

// Cubic Bernstein basis.
function B0(t: number): number { const m = 1 - t; return m * m * m; }
function B1(t: number): number { const m = 1 - t; return 3 * t * m * m; }
function B2(t: number): number { const m = 1 - t; return 3 * t * t * m; }
function B3(t: number): number { return t * t * t; }

// ---------------------------------------------------------------------------
// Open runs — fitting a shared boundary arc once, for both faces
// ---------------------------------------------------------------------------

export interface OpenFitOptions {
  /** Douglas–Peucker tolerance, in pixels. */
  tolerance: number;
  /** Maximum permitted Bézier fitting error, in pixels. */
  fitError: number;
  /** Turn angle in degrees above which an interior vertex is a hard corner. */
  cornerAngle: number;
  /** Merge adjacent curves where one fits both. Default on. */
  optimize?: boolean;
  /** Error budget for a merge. Defaults to `fitError`. */
  optimizeError?: number;
  /** Laplacian passes before fitting, both endpoints pinned. 0 skips it. */
  regularise?: number;
  /** How far a vertex may travel from where the lattice put it. Default 0.75px. */
  regulariseBand?: number;
}

/**
 * Laplacian smoothing of an OPEN run with both endpoints held fixed.
 *
 * The endpoints are junctions, shared with whatever arcs continue past them, so
 * moving one would pull the boundary apart at exactly the place three regions
 * meet. Everything between them is free within `band`, which is the pixel grid's
 * own uncertainty — see {@link regulariseClosed} for why that licence exists.
 */
export function regulariseOpen(
  px: Float64Array, py: Float64Array, n: number, band: number, passes: number,
): void {
  if (n < 3 || passes <= 0 || band <= 0) return;
  const ox = Float64Array.from(px);
  const oy = Float64Array.from(py);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const band2 = band * band;

  for (let pass = 0; pass < passes; pass++) {
    tx[0] = px[0]; ty[0] = py[0];
    tx[n - 1] = px[n - 1]; ty[n - 1] = py[n - 1];
    for (let i = 1; i < n - 1; i++) {
      tx[i] = (px[i] + (px[i - 1] + px[i + 1]) / 2) / 2;
      ty[i] = (py[i] + (py[i - 1] + py[i + 1]) / 2) / 2;
    }
    for (let i = 1; i < n - 1; i++) {
      let dx = tx[i] - ox[i];
      let dy = ty[i] - oy[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > band2) {
        const k = band / Math.sqrt(d2);
        dx *= k;
        dy *= k;
      }
      px[i] = ox[i] + dx;
      py[i] = oy[i] + dy;
    }
  }
}

/** Tangent at `i` on an open chain, clamped at the ends rather than wrapped. */
function centerTangentOpen(px: Float64Array, py: Float64Array, n: number, i: number): Point {
  const k = Math.max(1, Math.min(TANGENT_WINDOW, n - 1));
  const before = Math.max(0, i - k);
  const after = Math.min(n - 1, i + k);
  return normalize(px[after] - px[before], py[after] - py[before]);
}

/**
 * Fit one open run of points and return the segments that follow its first point.
 *
 * Separate from {@link fitLoop} because a closed loop has no endpoints and this
 * has two that are not negotiable: they are junctions where other arcs continue,
 * so they anchor both the smoothing and the simplification.
 *
 * The reason to fit a run here rather than inside each face's own loop is that
 * this fitter is not reversal-symmetric — the same points fitted backwards come
 * out as a different number of curves, up to 2.94px away. See `arcs.ts`.
 */
export function fitOpen(
  pts: Int32Array | Float64Array | number[], opts: OpenFitOptions,
): { start: Point; segments: Segment[] } | null {
  const n = pts.length / 2;
  if (n < 2) return null;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pts[i * 2];
    py[i] = pts[i * 2 + 1];
  }

  if (opts.regularise && opts.regularise > 0) {
    regulariseOpen(px, py, n, opts.regulariseBand ?? 0.75, opts.regularise);
  }

  const start = { x: px[0], y: py[0] };
  if (n === 2) return { start, segments: [{ kind: 'line', x: px[1], y: py[1] }] };

  const interior: number[] = [];
  douglasPeucker(px, py, 0, n - 1, opts.tolerance, interior, (i) => i);
  const anchors = [0, ...interior, n - 1];

  // Two anchors and nothing between them: the whole run is one straight edge.
  if (anchors.length === 2) {
    return { start, segments: [{ kind: 'line', x: px[n - 1], y: py[n - 1] }] };
  }

  // Both endpoints are breaks by definition. Interior anchors become breaks only
  // where the turn is sharp, exactly as on a closed loop.
  const threshold = Math.cos(opts.cornerAngle * (Math.PI / 180));
  const breaks: Breakpoint[] = [{ index: 0, corner: true }];
  for (let a = 1; a < anchors.length - 1; a++) {
    const prev = anchors[a - 1], cur = anchors[a], next = anchors[a + 1];
    const ax = px[cur] - px[prev], ay = py[cur] - py[prev];
    const bx = px[next] - px[cur], by = py[next] - py[cur];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    if ((ax * bx + ay * by) / (la * lb) < threshold) breaks.push({ index: cur, corner: true });
  }
  breaks.push({ index: n - 1, corner: true });

  const segments: Segment[] = [];
  for (let b = 0; b < breaks.length - 1; b++) {
    const startIdx = breaks[b].index;
    const endIdx = breaks[b + 1].index;
    const count = endIdx - startIdx + 1;
    if (count < 2) continue;

    const cx = new Float64Array(count);
    const cy = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      cx[i] = px[startIdx + i];
      cy[i] = py[startIdx + i];
    }

    const t1 = breaks[b].corner
      ? leftTangent(cx, cy, 0)
      : centerTangentOpen(px, py, n, startIdx);
    const t2 = breaks[b + 1].corner
      ? rightTangent(cx, cy, count - 1)
      : negate(centerTangentOpen(px, py, n, endIdx));

    const fitted: FittedSegment[] = [];
    fitCubic(cx, cy, 0, count - 1, t1, t2, opts.fitError, fitted);
    const optimized = opts.optimize === false
      ? fitted
      : optimizeCurves(cx, cy, fitted, opts.optimizeError ?? opts.fitError);
    for (const f of optimized) segments.push(f.segment);
  }

  if (segments.length === 0) {
    return { start, segments: [{ kind: 'line', x: px[n - 1], y: py[n - 1] }] };
  }
  return { start, segments };
}

/**
 * Sample a fitted path back into a dense polyline, roughly one point per
 * `spacing` pixels of arc length.
 *
 * The point of this is to ask a geometric question of the curve that will
 * actually be *emitted*, rather than of the lattice staircase it came from.
 * Crack-following places every vertex on a pixel corner, so a rasterised disc
 * arrives as a staircase whose corners sit up to ~1.4 px off the disc — and any
 * fitter judging "is this a circle" on those vertices is judging the sampling
 * grid, not the shape. The fitted path has already absorbed that: the smoothing
 * and the least-squares solve put it through the middle of the staircase.
 *
 * Sampling density is deliberately high (default one point per pixel, minimum
 * four per segment). A residual test takes the WORST point, so more samples can
 * only ever raise the residual — the density is a conservative choice, not a way
 * of making shapes look rounder than they are.
 */
export function flattenPath(path: FittedPath, spacing = 1): Float64Array {
  const out: number[] = [];
  let cx = path.start.x;
  let cy = path.start.y;
  out.push(cx, cy);
  const bez = new Float64Array(8);
  for (const s of path.segments) {
    if (s.kind === 'line') {
      // Subdivided, not just its endpoint. A straight run is where a residual
      // test goes blind: a disc with a flat chord sliced off keeps both chord
      // ENDPOINTS exactly on the circle, so a per-vertex test scores it as a
      // perfect circle and the missing 12% is never seen. That is the recorded
      // false positive, and it survives any amount of smoothing — the only thing
      // that catches it is sampling the middle of the straight bit.
      const dl = Math.hypot(s.x - cx, s.y - cy);
      const ds = Math.max(1, Math.min(256, Math.ceil(dl / Math.max(0.05, spacing))));
      for (let k = 1; k <= ds; k++) {
        out.push(cx + ((s.x - cx) * k) / ds, cy + ((s.y - cy) * k) / ds);
      }
      cx = s.x; cy = s.y;
      continue;
    }
    // Control-polygon length is an upper bound on arc length, so this never
    // under-samples.
    const len = Math.hypot(s.x1 - cx, s.y1 - cy)
      + Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
      + Math.hypot(s.x - s.x2, s.y - s.y2);
    const steps = Math.max(4, Math.min(256, Math.ceil(len / Math.max(0.05, spacing))));
    bez[0] = cx; bez[1] = cy;
    bez[2] = s.x1; bez[3] = s.y1;
    bez[4] = s.x2; bez[5] = s.y2;
    bez[6] = s.x; bez[7] = s.y;
    for (let k = 1; k <= steps; k++) {
      const p = bezierAt(bez, k / steps);
      out.push(p.x, p.y);
    }
    cx = s.x; cy = s.y;
  }
  // The path is implicitly closed; drop a duplicated final point so the shoelace
  // area and the vertex census are not distorted by a zero-length edge.
  const n = out.length >> 1;
  if (n > 1 && out[0] === out[(n - 1) * 2] && out[1] === out[(n - 1) * 2 + 1]) out.length -= 2;
  return Float64Array.from(out);
}
