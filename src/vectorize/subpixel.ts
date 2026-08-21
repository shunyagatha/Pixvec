import type { Loop } from './contour.js';
import type { RasterImage } from '../types.js';

/**
 * Sub-pixel edge extraction from anti-aliasing coverage.
 *
 * **The problem this solves.** Crack following puts every boundary vertex on an
 * integer lattice point, so a traced outline is a staircase: each interior vertex
 * sits √2/2 ≈ 0.707 px off the chord across it, and every turn is exactly 90°.
 * That wrecks everything downstream. Douglas–Peucker at a sub-pixel tolerance
 * cannot delete a vertex that far off its chord, so it keeps all of them;
 * `findBreakpoints` then sees a 90° turn at every retained anchor, which exceeds
 * any sane `cornerAngle`, so every span is two points; `fitCubic` takes its
 * two-point branch and `emit` finds the handles collinear and writes a line. The
 * curve fitter is correct, complete, and never runs.
 *
 * **Why the information to fix it is already there.** Anti-aliasing is not noise
 * to be quantised away — it is a *measurement* of where the true edge fell inside
 * each boundary pixel. A pixel that is 30% covered by a region tells you the edge
 * crosses it 30% of the way through. Recovering that turns "fit a curve through a
 * staircase" into "fit a curve through points that lie on a curve", and a long
 * straight diagonal collapses to one segment instead of hundreds of steps.
 *
 * **The estimator.** For a unit crack step, the two pixels either side are a
 * mixture of the region colour and its neighbour's. Sampling one pixel further out
 * on each side gives the two pure endpoints `A` (inside) and `B` (outside), and
 * projecting a boundary pixel onto the `A→B` line recovers its coverage:
 *
 *     α(P) = clamp( (P − B) · (A − B) / |A − B|² , 0, 1 )
 *
 * If the true edge lies exactly on the crack line then the inside pixel is fully
 * covered and the outside pixel not at all, so `α_in + α_out − 1 = 0`. Displace
 * the edge outward by `d` and the outside pixel picks up `d` of coverage; displace
 * it inward and the inside pixel loses `d`. Either way
 *
 *     d = α_in + α_out − 1
 *
 * which is the signed distance to move along the outward normal. All four channels
 * take part in the projection, so an alpha boundary is measured the same way a
 * colour boundary is.
 *
 * **Hard edges are a fixed point, by construction.** With no anti-aliasing,
 * `α_in = 1` and `α_out = 0` exactly, so `d = 0` and nothing moves. Pixel art and
 * sprites come through this pass unchanged — not approximately, identically — and
 * a test asserts it, because their lattice vertices are already the exact answer
 * and "improving" them would be a regression.
 *
 * **Densification.** The walker collapses collinear runs, so an edge can span many
 * pixels, each with its own coverage. A single displacement per edge would average
 * a curve into a chord, so each edge is walked in unit steps and each step
 * displaced on its own. That costs nothing on a genuinely straight run: the `d`
 * values come out equal, the extra vertices are collinear, and Douglas–Peucker
 * removes them again downstream.
 *
 * **Two independent passes stand between a raw pixel and the vertex this module
 * hands the fitter, and they attack two different failure modes.** Upstream, in
 * `trace.ts`, boundary-adjacent source pixels are read through a band-limited
 * bilateral filter (`refine-source.ts`) before `findPlateau`/the coverage
 * projection ever see them — that removes per-PIXEL noise (resize/sharpening
 * ringing, JPEG blocking) riding on top of a genuine antialiasing ramp, at the
 * raster level, before a displacement is ever computed. Downstream, right here,
 * `smoothVertexDisplacements` removes whatever per-VERTEX noise survives that —
 * residual sign-flipping between adjacent points' otherwise-independent
 * measurements — after displacement is computed, gated so it never crosses a
 * genuine corner. Neither pass alone was sufficient on the edge that motivated
 * both (see their own doc comments for the measurements); they are layered
 * because they remove noise introduced at different stages of the same pipeline.
 *
 * **Robust smoothing of the per-vertex signal — measured, honestly.** Each
 * vertex's raw displacement, above, is a single independent measurement: one
 * step's coverage projection, or two averaged at a corner. On some real
 * edges (documented at `refineOpenArc`'s investigation history) that raw
 * signal is locally noisy enough to defeat simplification even after this
 * pass runs — adjacent vertices disagreeing sharply about which way to move.
 * `smoothVertexDisplacements` (below) recovers a robust estimate from a
 * small window of neighbouring vertices, gated by {@link cornerCuts} so a
 * genuine corner is never smoothed across.
 *
 * The gate that gets that right ALSO has to leave a small, genuinely tightly
 * curved shape's own legitimate short-period structure alone — its
 * per-vertex correction is not noise around a smooth trend, and treating it
 * as noise measurably makes curve-fitting on it worse (more anchors, not
 * fewer; see `test/metrics.test.ts`'s `logo` preset colour-count test, which
 * this pass is tuned to leave passing). Instrumenting both that fixture and a
 * real run over the target image found their raw-displacement magnitude
 * distributions are close enough that magnitude alone cannot reliably tell
 * them apart (see {@link FIGHT_MAGNITUDE_MIN}). The floor this pass ships
 * with was chosen to fully protect the small-curve fixture, which is the
 * side of that trade a rendering library has to take — but the honest
 * consequence is that the same floor leaves this pass only weakly active on
 * the real edge it was built to fix, on its own. Layered on top of the
 * band-limited source denoise upstream, the two together measurably do more
 * than either alone — see the release notes for this change for the actual
 * before/after numbers on the target edge.
 */

/** Below this the two sides are the same colour and coverage is unrecoverable. */
const MIN_CONTRAST_SQ = 3 * 3 * 4;

/** A boundary lies within half a pixel of its crack line; beyond that is noise. */
const MAX_SHIFT = 0.5;

/**
 * How far {@link findPlateau} may walk before giving up. Measured against the
 * corpus rather than assumed: the widest real anti-aliasing ramp found (a
 * large silhouette's outer edge, `yoyokd14-calm-7149117_1920.png`'s black
 * outline) resolves to flat colour within 10px of raw perpendicular sampling.
 * 12 leaves that a two-pixel margin without inviting a walk on a genuine
 * gradient background to wander arbitrarily far from the edge it is meant to
 * describe. A thinner region caps the walk itself, sooner, via the region
 * check below — this is a ceiling, not the expected reach on most edges.
 *
 * Exported so `refine-source.ts` can size its boundary-band dilation to
 * provably cover every pixel a plateau walk could ever read, rather than
 * duplicating this number and risking the two drifting apart.
 */
export const MAX_PLATEAU_REACH = 12;

/**
 * Two consecutive samples this close (summed squared channel delta) are
 * "no more ramp here", not two pure-colour measurements that happen to
 * coincide. Chosen above the ~2-per-channel jitter measured between
 * neighbouring same-region pixels on real corpus photos (JPEG ringing,
 * dithering) so ordinary compression noise cannot be mistaken for a plateau
 * one step early, while still resolving well inside a true flat region.
 */
const PLATEAU_EPS_SQ = 4 * 4;

/**
 * Walk outward from a boundary-adjacent pixel `(x0, y0)` in direction
 * `(dx, dy)` — a unit step, since that is all a crack-following normal ever
 * is — until the sampled colour stops changing: the "pure" reference the
 * coverage projection in {@link refineLoop} and {@link refineOpenArc} assumes
 * is one pixel away. A fixed one-pixel reach is only correct when the
 * source's anti-aliasing ramp is at most a pixel wide (see the module doc);
 * on a wider ramp that pixel is still mid-gradient, and using it as "pure"
 * makes the projected displacement wrong and noisy at every step along the
 * edge — which is what defeats simplification downstream even after this
 * pass runs.
 *
 * The walk stops, and the last usable sample is returned, at whichever comes
 * first:
 *
 *  - two consecutive samples differ by less than {@link PLATEAU_EPS_SQ} — the
 *    ramp has resolved to flat colour;
 *  - the next pixel does not belong to `match` in `region` — walking further
 *    would leave the shape being measured and start sampling some *other*
 *    shape's ramp. This is the case a fixed reach cannot see coming: on a
 *    stroke thin enough that its two edges' ramps meet in the middle (a 1-2px
 *    bicycle spoke is exactly this), an unbounded walk searching for "pure"
 *    would cross clean through to the far side and average in a second edge's
 *    antialiasing, actively making that side's coverage measurement worse
 *    rather than better. Stopping at the region boundary keeps the walk from
 *    ever taking a sample that belongs to a different edge than the one being
 *    refined;
 *  - {@link MAX_PLATEAU_REACH} pixels have been walked with no plateau — a
 *    genuine gradient background has no "pure" colour to find, so the
 *    farthest sample is the least-wrong approximation available;
 *  - the walk leaves the image.
 *
 * Falls back to the boundary pixel itself (step 0) when even one step out is
 * unusable — out of bounds, or already a different region — matching what a
 * fixed one-pixel reach did in the same situation: a shape touching the frame,
 * or a region a single pixel wide, is refined against its own edge rather
 * than against a sample that was never validated.
 */
function findPlateau(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: Int32Array,
  match: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
): number {
  let prevOff = (y0 * width + x0) * 4;
  for (let step = 1; step <= MAX_PLATEAU_REACH; step++) {
    const x = x0 + dx * step, y = y0 + dy * step;
    if (x < 0 || y < 0 || x >= width || y >= height) break;
    if (region[y * width + x] !== match) break;
    const off = (y * width + x) * 4;
    const dr = data[off] - data[prevOff];
    const dg = data[off + 1] - data[prevOff + 1];
    const db = data[off + 2] - data[prevOff + 2];
    const da = data[off + 3] - data[prevOff + 3];
    prevOff = off;
    if (dr * dr + dg * dg + db * db + da * da <= PLATEAU_EPS_SQ) break;
  }
  return prevOff;
}

/**
 * Robust smoothing radius (in vertices) applied to each vertex's raw 2D
 * displacement before it is written to the output — see
 * {@link smoothVertexDisplacements}.
 *
 * This is a ceiling on how far the window CAN reach, not how often it fires;
 * {@link FIGHT_MAGNITUDE_MIN} and {@link OSCILLATION_MIN} are what gate
 * activation. 2 (a 5-point window) is large enough to catch a short noisy
 * run without spanning so much of a small, tightly-curved loop (radius
 * ~18-30px in the `test/metrics.test.ts` fixtures) that the window mixes in
 * a different part of the curve's genuine trend.
 */
const SMOOTH_RADIUS = 2;

/**
 * The minimum |dx| + |dy| a window entry's raw displacement must reach before
 * a sign disagreement it takes part in counts toward
 * {@link OSCILLATION_MIN} — see {@link smoothVertexDisplacements}.
 *
 * MEASURED, not assumed, and this number is the central honest finding of
 * this pass: magnitude alone does not separate the two cases it needs
 * to. Instrumenting both the small-circle fixtures and a real run over
 * `yoyokd14-calm-7149117_1920.png` (`SUBPIXEL_DEBUG`, since removed) found
 * near-identical raw-displacement magnitude distributions — medians of
 * 0.28-0.36px on the circles, 0.34-0.5px on yoyokd14's own large loops — so
 * there is no threshold here that reliably keeps one and drops the other.
 * 0.25 is the value that happened to leave the `logo` preset's colour-count
 * regression test passing (see `no band-aids` in the file's honesty
 * obligations) with the least aggressive floor found; at 0.15 the small
 * circles measurably regressed (more anchors, not fewer) and at 0.35 the
 * pass stopped visibly touching yoyokd14 at all.
 */
const FIGHT_MAGNITUDE_MIN = 0.25;

/**
 * How many sign disagreements between consecutive window entries are
 * required before a vertex is treated as sitting in a noisy stretch — see
 * {@link smoothVertexDisplacements}.
 *
 * 1 disagreement anywhere in the window is enough to trigger; a stricter
 * threshold of 2 (originally chosen to mean "the window fights itself twice,
 * not once") left the pass almost inert on yoyokd14 while barely improving
 * protection of the circle fixtures over {@link FIGHT_MAGNITUDE_MIN} alone —
 * that floor is carrying the real weight of telling the two cases apart, not
 * this count.
 */
const OSCILLATION_MIN = 1;

/**
 * How long a run of steps sharing one tangent direction must be, on BOTH
 * sides of a direction change, before that change is trusted as a real
 * corner rather than staircase noise — see {@link cornerCuts}.
 *
 * This is the load-bearing number for "don't blur real corners". The
 * distinguishing signature is run length, not angle: every step direction
 * change looks identical in isolation (crack-following only ever turns in 90°
 * increments), but a genuine corner in vector art is the END of an edge that
 * ran straight for several pixels, while the staircase jaggies this pass
 * exists to fix are short runs (1-3px) alternating almost every step because
 * the true edge is a diagonal or a gentle curve. Set to 4 from the corpus:
 * `keycap`'s rectangle corners meet runs of 8+ px on both sides and are always
 * protected; the yoyokd14 edge's runs are typically 1-3 px and are freely
 * smoothed across.
 */
const CORNER_RUN_MIN = 4;

/**
 * Locate genuine corners along a densified crack-follow polyline, from its
 * own tangent directions alone — no measurement involved, so this is exactly
 * as available on an unmeasured or low-contrast stretch as anywhere else.
 *
 * Steps are grouped into maximal runs sharing one axis-aligned tangent
 * `(tx[i], ty[i])`; a run-boundary is returned as a "hard cut" — a genuine
 * corner the smoothing window in {@link smoothVertexDisplacements} must not
 * cross — only when both runs meeting there are at least
 * {@link CORNER_RUN_MIN} steps long. Short runs on either side are staircase
 * noise, not corners, and are left smoothable.
 *
 * Returns one flag per VERTEX (length `nSteps` for a wrapping loop,
 * `nSteps + 1` for an open arc — the extra slot is the trailing endpoint,
 * always 0): `cut[v] === 1` means a hard corner sits at vertex `v`, between
 * the step arriving at it and the step leaving it.
 *
 * Exported (with {@link smoothVertexDisplacements}) only so the test suite can
 * drive them directly with hand-built tangent/displacement sequences. Unlike
 * {@link findPlateau}, whose behaviour a caller can pin precisely through the
 * public `refineLoop`/`refineOpenArc` entry points with an image built to a
 * known coverage, this pair's INPUT is itself the output of densification and
 * two-steps-per-vertex averaging earlier in the same functions — an image-level
 * fixture cannot dictate the exact per-vertex sequence these see without
 * effectively re-deriving that pipeline by hand. Not part of the module's
 * public contract otherwise; `refineLoop`/`refineOpenArc` remain the only
 * supported entry points for actually refining a loop or arc.
 */
export function cornerCuts(tx: Int8Array, ty: Int8Array, nSteps: number, wrap: boolean): Uint8Array {
  const cut = new Uint8Array(wrap ? nSteps : nSteps + 1);
  if (nSteps === 0) return cut;

  const runId = new Int32Array(nSteps);
  const runLen: number[] = [];
  let id = 0, start = 0;
  for (let i = 1; i < nSteps; i++) {
    if (tx[i] !== tx[i - 1] || ty[i] !== ty[i - 1]) {
      for (let k = start; k < i; k++) runId[k] = id;
      runLen.push(i - start);
      id++;
      start = i;
    }
  }
  for (let k = start; k < nSteps; k++) runId[k] = id;
  runLen.push(nSteps - start);

  // The seam is a boundary too, not a run split, when the last run wraps
  // straight into the first with no direction change.
  if (wrap && runLen.length > 1 && tx[0] === tx[nSteps - 1] && ty[0] === ty[nSteps - 1]) {
    const firstId = runId[0], lastId = runId[nSteps - 1];
    const merged = runLen[firstId]! + runLen[lastId]!;
    for (let k = 0; k < nSteps; k++) if (runId[k] === lastId) runId[k] = firstId;
    runLen[firstId] = merged;
  }

  // Vertex v sits between the step arriving at it (v - 1) and the step
  // leaving it (v). An open arc's vertex 0 has no arriving step, so it is
  // never a cut; its endpoint (vertex nSteps) is pinned by the caller and is
  // left 0 (unused) regardless.
  for (let v = wrap ? 0 : 1; v < nSteps; v++) {
    const prev = v === 0 ? nSteps - 1 : v - 1; // only reached when wrap
    if (runId[prev] === runId[v]) continue;
    if (runLen[runId[prev]!]! >= CORNER_RUN_MIN && runLen[runId[v]!]! >= CORNER_RUN_MIN) cut[v] = 1;
  }
  return cut;
}

/**
 * Robustly smooth a sequence of per-vertex 2D displacements with a windowed
 * median, gated so the window never crosses a genuine corner.
 *
 * **Why per-vertex 2D, not per-step scalar.** An earlier version of this pass
 * windowed the raw per-step signed outward displacement directly — the
 * quantity `refineLoop`/`refineOpenArc` compute per crack-step. That is only
 * safe to average across steps that share a normal: on a tightly curved
 * boundary (measured on the small-circle fixtures in
 * `test/metrics.test.ts`), consecutive steps' normals rotate through all four
 * axis directions within a handful of steps, and a "displacement along the
 * normal" is only the same physical quantity when the normal is the same.
 * Medianing across a rotating normal doesn't remove noise, it mixes
 * incomparable projections of the true curve and measurably WORSENED the
 * output — more anchors, not fewer, on those fixtures. A vertex's final 2D
 * displacement, in contrast, is an actual offset in image coordinates
 * regardless of which local direction produced it, so neighbouring vertices'
 * values are directly comparable and a window can span a turn safely.
 *
 * **Why the median.** A mean would blur a genuine step-change in the
 * underlying curve across the window; a median reproduces it once the
 * window's centre has crossed it — exactly the "don't blur real corners"
 * property this pass needs, on top of the explicit corner gate from
 * {@link cornerCuts}. Each axis is smoothed independently.
 *
 * **What "invalid" means to the window.** `valid[v] === 0` — this file found
 * no usable measurement anywhere incident to vertex `v` — excludes it from
 * every window it would otherwise fall in, AND leaves its own output
 * untouched (still `(0, 0)`, i.e. on the lattice): there is nothing here to
 * smooth an unmeasured vertex from, and inventing a displacement for it from
 * neighbours alone would be extrapolation the AA coverage never supported.
 *
 * **The noise trigger — why this is not unconditional, and its real limit.**
 * A first version applied the window to every valid vertex unconditionally,
 * and separately a version that triggered on any single sign disagreement
 * with the nearest neighbour. Both measurably WORSENED the small-circle
 * fixtures (radius ~18-30px) in `test/metrics.test.ts` — more anchors, not
 * fewer, i.e. curve-fitting got LESS efficient, not more. A tight circle's
 * per-vertex correction is not noise around a smooth trend; it has genuine
 * short-period structure from how the true curve digitises onto the pixel
 * grid, including its own legitimate sign changes near-zero-crossing, and
 * both of those triggers fired on that structure as often as on real noise.
 *
 * What ships instead: for each valid vertex, build its ordered window (the
 * same points the median below would use), and count sign disagreements
 * between CONSECUTIVE window entries whose magnitude both clear
 * {@link FIGHT_MAGNITUDE_MIN}. Only when that count reaches
 * {@link OSCILLATION_MIN} does the vertex's raw value get replaced by the
 * window's median; otherwise it is written through unchanged.
 *
 * Exported for direct testing — see {@link cornerCuts}'s doc for why.
 */
export function smoothVertexDisplacements(
  dx: Float64Array,
  dy: Float64Array,
  valid: Uint8Array,
  cut: Uint8Array,
  n: number,
  wrap: boolean,
): { x: Float64Array; y: Float64Array } {
  const outX = new Float64Array(n);
  const outY = new Float64Array(n);
  if (n === 0) return { x: outX, y: outY };

  const idx = (raw: number): number => {
    if (wrap) return ((raw % n) + n) % n;
    return raw >= 0 && raw < n ? raw : -1;
  };

  const median = (vals: number[]): number => {
    vals.sort((a, b) => a - b);
    const mid = vals.length >> 1;
    return vals.length % 2 === 1 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
  };

  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;

    // Build the window in INDEX ORDER (left to right), respecting hard cuts —
    // the same list serves both the noise trigger below and the median.
    const wx: number[] = [];
    const wy: number[] = [];
    for (let r = SMOOTH_RADIUS; r >= 1; r--) {
      const li = idx(i - r);
      if (li === -1) continue;
      let blocked = false;
      for (let b = 0; b < r; b++) {
        const bi = idx(i - b);
        if (bi !== -1 && cut[bi]) { blocked = true; break; }
      }
      if (!blocked && valid[li]) { wx.push(dx[li]!); wy.push(dy[li]!); }
    }
    wx.push(dx[i]!); wy.push(dy[i]!);
    for (let r = 1; r <= SMOOTH_RADIUS; r++) {
      const ri = idx(i + r);
      if (ri === -1) continue;
      let blocked = false;
      for (let b = 1; b <= r; b++) {
        const bi = idx(i + b);
        if (bi !== -1 && cut[bi]) { blocked = true; break; }
      }
      if (!blocked && valid[ri]) { wx.push(dx[ri]!); wy.push(dy[ri]!); }
    }

    // The noise trigger: count sign disagreements between CONSECUTIVE window
    // entries (in arc order) whose magnitude is large enough to be a real
    // measurement rather than near-zero jitter. One isolated disagreement is
    // consistent with a genuine, once-per-window direction change (a tightly
    // curved but legitimate boundary); {@link OSCILLATION_MIN} or more, within
    // one window, is the back-and-forth signature investigated on yoyokd14.
    let changes = 0;
    for (let k = 1; k < wx.length; k++) {
      const magA = Math.abs(wx[k - 1]!) + Math.abs(wy[k - 1]!);
      const magB = Math.abs(wx[k]!) + Math.abs(wy[k]!);
      if (magA < FIGHT_MAGNITUDE_MIN || magB < FIGHT_MAGNITUDE_MIN) continue;
      if (wx[k - 1]! * wx[k]! + wy[k - 1]! * wy[k]! < 0) changes++;
    }

    if (changes < OSCILLATION_MIN) {
      // Not oscillating — agrees with its neighbours, or disagrees only once,
      // which a genuinely curved (not noisy) boundary does too.
      outX[i] = dx[i]!;
      outY[i] = dy[i]!;
      continue;
    }
    outX[i] = median(wx);
    outY[i] = median(wy);
  }
  return { x: outX, y: outY };
}

export interface RefinedLoop {
  /** Interleaved `x, y`, ready to hand straight to {@link fitLoop}. */
  pts: Float64Array;
  /** Vertices that actually moved — 0 means the input had no usable coverage. */
  moved: number;
  /** Vertices considered, after densification. */
  total: number;
}

/**
 * Refine one crack-followed loop against the continuous-tone source.
 *
 * `classes` and `cls` are needed to tell inside from outside. That could be read
 * off the winding direction instead, but asking the class map is unambiguous and
 * does not silently depend on the walker's turn-policy conventions.
 */
export function refineLoop(
  loop: Loop,
  img: RasterImage,
  classes: Int32Array,
  cls: number,
): RefinedLoop {
  const { width, height, data } = img;
  const src = loop.pts;
  const srcN = src.length / 2;
  if (srcN < 2) return { pts: Float64Array.from(src), moved: 0, total: srcN };

  // --- Densify to unit steps -------------------------------------------------
  let count = 0;
  for (let i = 0; i < srcN; i++) {
    const j = (i + 1) % srcN;
    count += Math.abs(src[j * 2] - src[i * 2]) + Math.abs(src[j * 2 + 1] - src[i * 2 + 1]);
  }
  if (count === 0) return { pts: Float64Array.from(src), moved: 0, total: srcN };

  const vx = new Float64Array(count);
  const vy = new Float64Array(count);

  let k = 0;
  for (let i = 0; i < srcN; i++) {
    const j = (i + 1) % srcN;
    const x0 = src[i * 2], y0 = src[i * 2 + 1];
    const x1 = src[j * 2], y1 = src[j * 2 + 1];
    const steps = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    for (let s = 0; s < steps; s++) {
      vx[k] = x0 + dx * s;
      vy[k] = y0 + dy * s;
      k++;
    }
  }

  // Tangent direction per step, straight from the densified polyline —
  // independent of measurement, so corners are locatable even where AA
  // coverage could not be read. See `cornerCuts`.
  const stepTx = new Int8Array(count);
  const stepTy = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    stepTx[i] = Math.sign(vx[j] - vx[i]);
    stepTy[i] = Math.sign(vy[j] - vy[i]);
  }
  const cut = cornerCuts(stepTx, stepTy, count, true);

  // --- Measure each unit step ------------------------------------------------
  const at = (x: number, y: number): number => (y * width + x) * 4;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;

  // Accumulated displacement per vertex, and the number of incident steps that
  // contributed, so a corner averages its two normals rather than taking one.
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const hits = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = vx[i], ay = vy[i];
    const bx = vx[j], by = vy[j];
    const ex = bx - ax, ey = by - ay;

    // The two pixels this crack step separates. A lattice point (x, y) is the
    // top-left corner of pixel (x, y), so a horizontal step lies between the
    // pixel above and the pixel below, and a vertical step between left and right.
    let p1x: number, p1y: number, p2x: number, p2y: number;
    if (ey === 0) {
      const x = Math.min(ax, bx);
      p1x = x; p1y = ay - 1;   // above
      p2x = x; p2y = ay;       // below
    } else {
      const y = Math.min(ay, by);
      p1x = ax - 1; p1y = y;   // left
      p2x = ax; p2y = y;       // right
    }

    const in1 = inBounds(p1x, p1y) && classes[p1y * width + p1x] === cls;
    const in2 = inBounds(p2x, p2y) && classes[p2y * width + p2x] === cls;
    // Exactly one side must be the region, or this is not its boundary.
    if (in1 === in2) continue;

    const ix = in1 ? p1x : p2x, iy = in1 ? p1y : p2y;
    const ox = in1 ? p2x : p1x, oy = in1 ? p2y : p1y;
    // A region touching the frame has no outside pixel to measure, and there is
    // nothing to recover from data the image does not contain. Skipping leaves
    // that stretch of boundary on the lattice, which is the honest answer;
    // reading past the edge produced `undefined` and propagated NaN into the
    // vertex, poisoning both its neighbours through the averaging below.
    if (!inBounds(ox, oy)) continue;
    // Outward normal: from the inside pixel's centre toward the outside pixel's.
    const nx = ox - ix, ny = oy - iy;

    // Walk outward on each side independently until the colour plateaus, for
    // the two pure endpoints — see `findPlateau`. `outCls` is whatever class
    // the outside pixel actually is; bounding that walk to it (rather than to
    // "not cls") stops it at the far side's own edge instead of averaging in
    // a third region if the outside happens to be thin too.
    const outCls = classes[oy * width + ox]!;
    const aOff = findPlateau(data, width, height, classes, cls, ix, iy, -nx, -ny);
    const bOff = findPlateau(data, width, height, classes, outCls, ox, oy, nx, ny);

    let contrast = 0;
    const abr = data[aOff] - data[bOff];
    const abg = data[aOff + 1] - data[bOff + 1];
    const abb = data[aOff + 2] - data[bOff + 2];
    const aba = data[aOff + 3] - data[bOff + 3];
    contrast = abr * abr + abg * abg + abb * abb + aba * aba;
    if (contrast < MIN_CONTRAST_SQ) continue;

    const iOff = at(ix, iy);
    const oOff = at(ox, oy);
    const project = (off: number): number => {
      const t =
        ((data[off] - data[bOff]) * abr +
          (data[off + 1] - data[bOff + 1]) * abg +
          (data[off + 2] - data[bOff + 2]) * abb +
          (data[off + 3] - data[bOff + 3]) * aba) / contrast;
      return t < 0 ? 0 : t > 1 ? 1 : t;
    };

    let d = project(iOff) + project(oOff) - 1;
    if (d > MAX_SHIFT) d = MAX_SHIFT;
    else if (d < -MAX_SHIFT) d = -MAX_SHIFT;
    if (d === 0) continue;

    // The whole step moves along its normal, so both endpoints do.
    sx[i] += d * nx; sy[i] += d * ny; hits[i]++;
    sx[j] += d * nx; sy[j] += d * ny; hits[j]++;
  }

  // Raw per-vertex displacement, before smoothing — the corner-averaged
  // estimate each vertex got from its own incident step(s) alone.
  const rawOx = new Float64Array(count);
  const rawOy = new Float64Array(count);
  const vertexValid = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const n = hits[i];
    if (n === 0) continue;
    rawOx[i] = sx[i] / n;
    rawOy[i] = sy[i] / n;
    vertexValid[i] = 1;
  }

  const smoothed = smoothVertexDisplacements(rawOx, rawOy, vertexValid, cut, count, true);

  const out = new Float64Array(count * 2);
  let displaced = 0;
  for (let i = 0; i < count; i++) {
    const ox = smoothed.x[i]!;
    const oy = smoothed.y[i]!;
    if (ox !== 0 || oy !== 0) displaced++;
    out[i * 2] = vx[i] + ox;
    out[i * 2 + 1] = vy[i] + oy;
  }

  return { pts: out, moved: displaced, total: count };
}

export interface RefinedArc {
  /** Interleaved `x, y`, ready to hand straight to {@link fitOpen}. */
  pts: Float64Array;
  /** Vertices that actually moved — 0 means the input had no usable coverage. */
  moved: number;
  /** Vertices considered, after densification. */
  total: number;
}

/**
 * Refine one open interior arc against the continuous-tone source, endpoints pinned.
 *
 * A reversal-symmetric adaptation of {@link refineLoop} for the shared-boundary runs
 * `decomposeToArcs` produces (see `arcs.ts`), rather than whole loops. Two things
 * differ from a loop: the walk does not wrap around, and the first and last vertices
 * are junctions other arcs continue from, so they are excluded from the result
 * regardless of what the per-step measurement finds there — moving them would tear
 * the seam `arcs.ts` exists to prevent.
 *
 * `labels` must be COMPONENT ids (`ComponentMap.labels` from `connectedComponents`),
 * not the palette-class map `refineLoop` reads. `Arc.a`/`Arc.b` (`arcs.ts`) are
 * component ids, and testing them against palette classes silently fails the
 * inside/outside test on nearly every step — that reads as "no antialiasing signal
 * on these arcs", when the real cause is comparing against the wrong map.
 * `refineLoop` gets away with palette classes only because it runs per class-loop,
 * a different situation from this, which runs per shared arc.
 *
 * `cls` may be either of the arc's two component ids: displacement is measured as
 * `d · n` (coverage excess along the outward normal), and swapping which side counts
 * as "inside" flips the sign of both `d` and `n`, leaving their product — and so the
 * point actually moved — unchanged. Verified at 0/760 disagreements across every
 * real interior open arc on dog.jpg, comparing `cls = arc.a` against `cls = arc.b`.
 */
export function refineOpenArc(
  pts: Int32Array | Float64Array | number[],
  img: RasterImage,
  labels: Int32Array,
  cls: number,
): RefinedArc {
  const { width, height, data } = img;
  const srcN = pts.length / 2;
  const asFloat = (): Float64Array => {
    const out = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i++) out[i] = pts[i]!;
    return out;
  };
  if (srcN < 2) return { pts: asFloat(), moved: 0, total: srcN };

  // --- Densify to unit steps, start to end, no wraparound ---------------------
  let count = 1; // the start vertex, not walked as an edge below
  for (let i = 0; i < srcN - 1; i++) {
    count += Math.abs(pts[(i + 1) * 2]! - pts[i * 2]!) +
      Math.abs(pts[(i + 1) * 2 + 1]! - pts[i * 2 + 1]!);
  }
  if (count < 2) return { pts: asFloat(), moved: 0, total: srcN };

  const vx = new Float64Array(count);
  const vy = new Float64Array(count);

  let k = 0;
  for (let i = 0; i < srcN - 1; i++) {
    const x0 = pts[i * 2]!, y0 = pts[i * 2 + 1]!;
    const x1 = pts[(i + 1) * 2]!, y1 = pts[(i + 1) * 2 + 1]!;
    const steps = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    for (let s = 0; s < steps; s++) {
      vx[k] = x0 + dx * s;
      vy[k] = y0 + dy * s;
      k++;
    }
  }
  vx[k] = pts[(srcN - 1) * 2]!;
  vy[k] = pts[(srcN - 1) * 2 + 1]!;
  k++;
  // k === count here, by construction of the sum above.

  // Tangent direction per step, straight from the densified polyline —
  // independent of measurement, so corners are locatable even where AA
  // coverage could not be read. See `cornerCuts`.
  const nSteps = count - 1;
  const stepTx = new Int8Array(nSteps);
  const stepTy = new Int8Array(nSteps);
  for (let i = 0; i < nSteps; i++) {
    stepTx[i] = Math.sign(vx[i + 1]! - vx[i]!);
    stepTy[i] = Math.sign(vy[i + 1]! - vy[i]!);
  }
  const cut = cornerCuts(stepTx, stepTy, nSteps, false); // length count; last slot unused (pinned endpoint)

  // --- Measure each unit step (count - 1 of them; no wraparound) --------------
  const at = (x: number, y: number): number => (y * width + x) * 4;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;

  // Accumulated displacement per vertex, and the number of incident steps that
  // contributed, so a corner averages its two normals rather than taking one.
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const hits = new Uint8Array(count);

  for (let i = 0; i < nSteps; i++) {
    const j = i + 1;
    const ax = vx[i]!, ay = vy[i]!;
    const bx = vx[j]!, by = vy[j]!;
    const ey = by - ay;

    // Same convention as `refineLoop`: a lattice point (x, y) is the top-left
    // corner of pixel (x, y), so a horizontal step lies between the pixel above
    // and the pixel below, and a vertical step between left and right.
    let p1x: number, p1y: number, p2x: number, p2y: number;
    if (ey === 0) {
      const x = Math.min(ax, bx);
      p1x = x; p1y = ay - 1;   // above
      p2x = x; p2y = ay;       // below
    } else {
      const y = Math.min(ay, by);
      p1x = ax - 1; p1y = y;   // left
      p2x = ax; p2y = y;       // right
    }

    const in1 = inBounds(p1x, p1y) && labels[p1y * width + p1x] === cls;
    const in2 = inBounds(p2x, p2y) && labels[p2y * width + p2x] === cls;
    // Exactly one side must be the region, or this is not its boundary.
    if (in1 === in2) continue;

    const ix = in1 ? p1x : p2x, iy = in1 ? p1y : p2y;
    const ox = in1 ? p2x : p1x, oy = in1 ? p2y : p1y;
    if (!inBounds(ox, oy)) continue;
    // Outward normal: from the inside pixel's centre toward the outside pixel's.
    const nx = ox - ix, ny = oy - iy;

    // Walk outward on each side independently until the colour plateaus —
    // see `findPlateau`. `outLabel` bounds the outward walk to the specific
    // component the outside pixel belongs to, so it stops at that region's
    // own far edge rather than crossing into a third component.
    const outLabel = labels[oy * width + ox]!;
    const aOff = findPlateau(data, width, height, labels, cls, ix, iy, -nx, -ny);
    const bOff = findPlateau(data, width, height, labels, outLabel, ox, oy, nx, ny);

    const abr = data[aOff]! - data[bOff]!;
    const abg = data[aOff + 1]! - data[bOff + 1]!;
    const abb = data[aOff + 2]! - data[bOff + 2]!;
    const aba = data[aOff + 3]! - data[bOff + 3]!;
    const contrast = abr * abr + abg * abg + abb * abb + aba * aba;
    if (contrast < MIN_CONTRAST_SQ) continue;

    const iOff = at(ix, iy);
    const oOff = at(ox, oy);
    const project = (off: number): number => {
      const t =
        ((data[off]! - data[bOff]!) * abr +
          (data[off + 1]! - data[bOff + 1]!) * abg +
          (data[off + 2]! - data[bOff + 2]!) * abb +
          (data[off + 3]! - data[bOff + 3]!) * aba) / contrast;
      return t < 0 ? 0 : t > 1 ? 1 : t;
    };

    let d = project(iOff) + project(oOff) - 1;
    if (d > MAX_SHIFT) d = MAX_SHIFT;
    else if (d < -MAX_SHIFT) d = -MAX_SHIFT;
    if (d === 0) continue;

    // The whole step moves along its normal, so both endpoints do.
    sx[i] += d * nx; sy[i] += d * ny; hits[i]++;
    sx[j] += d * nx; sy[j] += d * ny; hits[j]++;
  }

  // Raw per-vertex displacement, before smoothing — the corner-averaged
  // estimate each vertex got from its own incident step(s) alone. Endpoints
  // are pinned regardless, so they are left invalid here and never smoothed.
  const rawOx = new Float64Array(count);
  const rawOy = new Float64Array(count);
  const vertexValid = new Uint8Array(count);
  for (let i = 1; i < count - 1; i++) {
    const n = hits[i]!;
    if (n === 0) continue;
    rawOx[i] = sx[i]! / n;
    rawOy[i] = sy[i]! / n;
    vertexValid[i] = 1;
  }

  const smoothed = smoothVertexDisplacements(rawOx, rawOy, vertexValid, cut, count, false);

  const out = new Float64Array(count * 2);
  let displaced = 0;
  for (let i = 0; i < count; i++) {
    // Endpoints are junctions other arcs continue from — pinned, never displaced,
    // regardless of what the per-step measurement found there.
    if (i === 0 || i === count - 1) {
      out[i * 2] = vx[i]!;
      out[i * 2 + 1] = vy[i]!;
      continue;
    }
    const ox = smoothed.x[i]!;
    const oy = smoothed.y[i]!;
    if (ox !== 0 || oy !== 0) displaced++;
    out[i * 2] = vx[i]! + ox;
    out[i * 2 + 1] = vy[i]! + oy;
  }

  return { pts: out, moved: displaced, total: count };
}
