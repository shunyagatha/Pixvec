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
 */

/** Below this the two sides are the same colour and coverage is unrecoverable. */
const MIN_CONTRAST_SQ = 3 * 3 * 4;

/** A boundary lies within half a pixel of its crack line; beyond that is noise. */
const MAX_SHIFT = 0.5;

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
  // Accumulated displacement per vertex, and the number of incident steps that
  // contributed, so a corner averages its two normals rather than taking one.
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const hits = new Uint8Array(count);

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

  // --- Measure each unit step ------------------------------------------------
  const at = (x: number, y: number): number => (y * width + x) * 4;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;

  let moved = 0;
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

    // One pixel further out on each side, for the two pure endpoints. Falling
    // back to the boundary pixel itself when that lands outside the image keeps a
    // shape touching the frame from being refined against nothing.
    const pax = ix - nx, pay = iy - ny;
    const pbx = ox + nx, pby = oy + ny;
    const aOff = inBounds(pax, pay) ? at(pax, pay) : at(ix, iy);
    const bOff = inBounds(pbx, pby) ? at(pbx, pby) : at(ox, oy);

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
    moved++;
  }

  const out = new Float64Array(count * 2);
  let displaced = 0;
  for (let i = 0; i < count; i++) {
    const n = hits[i];
    const ox = n > 0 ? sx[i] / n : 0;
    const oy = n > 0 ? sy[i] / n : 0;
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
  // Accumulated displacement per vertex, and the number of incident steps that
  // contributed, so a corner averages its two normals rather than taking one.
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const hits = new Uint8Array(count);

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

  // --- Measure each unit step (count - 1 of them; no wraparound) --------------
  const at = (x: number, y: number): number => (y * width + x) * 4;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;

  let moved = 0;
  for (let i = 0; i < count - 1; i++) {
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

    const pax = ix - nx, pay = iy - ny;
    const pbx = ox + nx, pby = oy + ny;
    const aOff = inBounds(pax, pay) ? at(pax, pay) : at(ix, iy);
    const bOff = inBounds(pbx, pby) ? at(pbx, pby) : at(ox, oy);

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
    moved++;
  }

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
    const n = hits[i]!;
    const ox = n > 0 ? sx[i]! / n : 0;
    const oy = n > 0 ? sy[i]! / n : 0;
    if (ox !== 0 || oy !== 0) displaced++;
    out[i * 2] = vx[i]! + ox;
    out[i * 2 + 1] = vy[i]! + oy;
  }

  return { pts: out, moved: displaced, total: count };
}
