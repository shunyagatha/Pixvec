import type { Loop } from './contour.js';

/**
 * Shared-boundary agreement, by pinning junctions rather than sharing structure.
 *
 * THE PROBLEM. Every region is traced as its own closed loop, so two neighbours
 * hold two private copies of the boundary between them. Smooth them independently
 * and they drift apart; rendered, the subject falls to pieces and the background
 * shows through.
 *
 * THE OBVIOUS FIX, AND WHY IT IS NOT THE ONE. The instinct is to trace each
 * boundary once into a shared arc structure and have both faces reference it. That
 * was built — arc keys, a canonical-orientation cache, junction splitting in the
 * contour walk — and it is unnecessary. The requirement is not that a boundary be
 * *computed* once. It is that both faces reach the *same answer*, and that follows
 * from a rule both evaluate identically.
 *
 * WHY PINNING IS SUFFICIENT. At a lattice vertex where exactly two cracks meet,
 * exactly two faces meet, and both traverse BOTH cracks — in opposite order. So
 * the vertex's two neighbours are the same pair of points for both faces, merely
 * swapped, and the Laplacian update `(prev + next) / 2` is symmetric under that
 * swap. Both faces therefore compute the same new position, and by induction stay
 * equal for every pass. The collinear collapse does not break this: collinearity is
 * a property of the path, so both sides drop the same vertices and the surviving
 * neighbours still match.
 *
 * It fails only where three or more cracks meet, because there the two faces follow
 * *different* cracks away from the vertex and their neighbourhoods genuinely
 * differ. Pin those and the agreement is exact — no cache, no shared arcs, no
 * change to the contour walk.
 *
 * THE FRAME IS PINNED TOO, and that is a bug fix rather than a precaution. An image
 * corner has crack degree 2, so nothing above would hold it: today's closed-loop
 * regularisation smooths it inward and the fill retreats off the edge of the
 * picture.
 */

/**
 * How many of the four grid edges radiating from lattice vertex `(vx, vy)`
 * separate two differently-labelled cells.
 *
 * A purely local test on the four cells around the vertex — no graph, no
 * traversal. Outside the frame counts as its own label so a border crack is still
 * a crack.
 */
export function crackDegree(
  labels: Int32Array, width: number, height: number, vx: number, vy: number,
): number {
  const cell = (cx: number, cy: number): number =>
    (cx < 0 || cy < 0 || cx >= width || cy >= height) ? OUTSIDE : labels[cy * width + cx];
  const tl = cell(vx - 1, vy - 1);
  const tr = cell(vx, vy - 1);
  const bl = cell(vx - 1, vy);
  const br = cell(vx, vy);
  let d = 0;
  if (tl !== tr) d++;
  if (bl !== br) d++;
  if (tl !== bl) d++;
  if (tr !== br) d++;
  return d;
}

/** Sentinel for "beyond the image", distinct from any real label including -1. */
const OUTSIDE = -999;

/**
 * Which vertices of a loop must not move: junctions, and anything on the frame.
 */
export function pinsFor(
  loop: Loop, labels: Int32Array, width: number, height: number,
): Uint8Array {
  const n = loop.pts.length / 2;
  const pinned = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = loop.pts[i * 2];
    const y = loop.pts[i * 2 + 1];
    if (x <= 0 || y <= 0 || x >= width || y >= height) { pinned[i] = 1; continue; }
    if (crackDegree(labels, width, height, x, y) !== 2) pinned[i] = 1;
  }
  return pinned;
}

/**
 * Laplacian smoothing of a closed loop with some vertices held fixed.
 *
 * Same band-constrained rule as `regulariseClosed` in fit.ts — every free vertex
 * stays within `band` of where the lattice put it — with the pinned set excluded.
 * Returns interleaved `x, y`; the input `Loop.pts` is an `Int32Array` and must not
 * be written back to, or the smoothing rounds straight back onto the lattice.
 */
export function regularisePinned(
  loop: Loop, pinned: Uint8Array, band: number, passes: number,
): Float64Array {
  const n = loop.pts.length / 2;
  const out = new Float64Array(loop.pts.length);
  for (let k = 0; k < loop.pts.length; k++) out[k] = loop.pts[k];
  if (n < 4 || passes <= 0 || band <= 0) return out;

  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ox[i] = px[i] = loop.pts[i * 2];
    oy[i] = py[i] = loop.pts[i * 2 + 1];
  }
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const band2 = band * band;

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      if (pinned[i]) { tx[i] = px[i]; ty[i] = py[i]; continue; }
      const a = i === 0 ? n - 1 : i - 1;
      const b = i === n - 1 ? 0 : i + 1;
      tx[i] = (px[i] + (px[a] + px[b]) / 2) / 2;
      ty[i] = (py[i] + (py[a] + py[b]) / 2) / 2;
    }
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
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

  for (let i = 0; i < n; i++) {
    out[i * 2] = px[i];
    out[i * 2 + 1] = py[i];
  }
  return out;
}

/** Smooth every loop, pinning junctions so neighbours agree by construction. */
export function regulariseAgreeing(
  loopsByComponent: Loop[][],
  labels: Int32Array, width: number, height: number,
  passes: number, band = 0.75,
): Map<Loop, Float64Array> {
  const geometry = new Map<Loop, Float64Array>();
  if (passes <= 0) return geometry;
  for (const loops of loopsByComponent) {
    for (const loop of loops ?? []) {
      geometry.set(loop, regularisePinned(loop, pinsFor(loop, labels, width, height), band, passes));
    }
  }
  return geometry;
}
