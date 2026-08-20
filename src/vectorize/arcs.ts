import { type Loop, OUTSIDE_FRAME } from './contour.js';
import { crackDegree } from './junctions.js';
import {
  type FitOptions, type FittedPath, type OpenFitOptions, type Segment,
  fitLoop, fitOpen,
} from './fit.js';
import { refineOpenArc } from './subpixel.js';
import type { Point, RasterImage } from '../types.js';

/**
 * Boundary decomposition into arcs shared by exactly two regions.
 *
 * WHY THIS EXISTS, GIVEN THAT junctions.ts ARGUES IT DOES NOT NEED TO.
 *
 * That argument is correct, and it is about a different operation. Pinning makes
 * two neighbours agree because the Laplacian update `(prev + next) / 2` is
 * symmetric under reversing the traversal, so both faces compute the same new
 * position for every shared vertex — measured at 0 disagreeing vertices over
 * ~50,000 of them. Nothing here supersedes that.
 *
 * Curve fitting has no such symmetry, and the difference is not subtle. Fitting a
 * lattice circle, then fitting the same points reversed:
 *
 *   circle r=10     4 curves  /  4 curves    max deviation 0.94 px
 *   circle r=25    37         / 37                        0.99
 *   circle r=60    42         / 46                        1.85
 *   circle r=120   58         / 60                        2.94
 *
 * Different *counts*, not different last bits. Douglas-Peucker is reversal-
 * symmetric, but corner detection, chord-length parameterisation, the Schneider
 * least-squares solve and the merge passes are not, and they compound. Two faces
 * fitting their private copies of one shared boundary therefore land up to 2.94 px
 * apart — four times the regularisation band, and well past what any seam cover
 * could hide. That is the tearing, and pinning cannot prevent it, because the
 * divergence happens after pinning has done its work.
 *
 * So: fit each shared boundary ONCE and let both faces reference the result. The
 * agreement is then true by construction rather than by an argument about symmetry
 * that only holds for one of the two passes.
 *
 * WHERE THE SPLITS GO. An arc ends where the neighbour changes (`otherSide`, which
 * the contour walk already records) or where the crack degree is not 2. The first
 * is symmetric by definition: if A sees its run of B end at vertex v, that run of
 * A|B cracks ended at v from B's side too. The second is a function of `labels`
 * alone, so it cannot depend on which face is asking. Both tests are therefore
 * face-independent, which is the property the whole scheme rests on — and
 * {@link verifyTwins} checks it on real output rather than trusting this paragraph.
 * Measured over the eight-subject corpus at `clean`'s pre-passes: 0 unpaired out
 * of 15,516 interior arcs on alpha-dice, 2,185 on logo-tux and 31,212 on
 * photo-motorcycles, with every face rebuilding exactly.
 *
 * SPLITTING AT EVERY JUNCTION LOOKS WASTEFUL, AND MERGING BACK IS NOT AVAILABLE.
 * An interior arc is drawn by both faces and cannot cost either of them less than
 * one segment, so the arc count puts a hard floor under the emitted total and the
 * obvious economy is to join two consecutive arcs into one. That only stays
 * face-independent when both arcs separate the SAME region pair — otherwise the
 * neighbour across the junction still splits there and the two sides stop
 * agreeing, which is the tearing this whole file exists to prevent.
 *
 * But an arc ends precisely WHERE the neighbour changes, so a same-pair join needs
 * the neighbour to change and change back: a degree-4 saddle. Measured over the
 * corpus, 1,469 of 169,268 consecutive joins qualify — 0.87%, and **0 of 4,409 on
 * logo-tux**, the flattest subject and the one this preset is aimed at. The lever
 * is not merely rare, it is structurally almost absent. Segment economy on a
 * mosaic lives in `optimizeError`; do not spend the effort here again.
 */

/** One boundary run, stored once and referenced by the two faces that share it. */
export interface Arc {
  /** Flat `x, y` pairs in canonical direction, endpoints included. */
  pts: Int32Array;
  /** The lower-numbered of the two regions either side. */
  a: number;
  /** The higher-numbered. {@link OUTSIDE_FRAME} or -1 where there is no region. */
  b: number;
  /** True when the arc is an entire loop carrying no junction at all. */
  closed: boolean;
}

/** How one face traverses one arc. */
export interface ArcRef {
  /** Index into {@link ArcDecomposition.arcs}. */
  arc: number;
  /** True when this face walks the arc against its canonical direction. */
  reversed: boolean;
}

export interface ArcDecomposition {
  arcs: Arc[];
  /**
   * For each loop, the cycle of arcs that reconstitutes it.
   *
   * Up to rotation, not byte-for-byte: an arc cycle starts at the loop's first
   * junction rather than at its index 0, and a closed path has no privileged
   * first vertex, so the emitted geometry is identical either way. Measured on
   * the corpus, 20-27% of faces come back rotated and none comes back different.
   */
  faces: Map<Loop, ArcRef[]>;
}

/** Canonical key for an open run, plus whether producing it meant reversing. */
function canonical(xs: number[], ys: number[]): { key: string; reversed: boolean } {
  const n = xs.length;
  const fwd: string[] = [];
  const rev: string[] = [];
  for (let i = 0; i < n; i++) {
    fwd.push(xs[i] + ',' + ys[i]);
    rev.push(xs[n - 1 - i] + ',' + ys[n - 1 - i]);
  }
  const f = fwd.join(';');
  const r = rev.join(';');
  return f <= r ? { key: f, reversed: false } : { key: r, reversed: true };
}

/**
 * Normalise a closed run: rotate to its lexicographically smallest vertex, then
 * orient it the same way from both sides.
 *
 * A loop with no junction on it — a disc alone in a field of background — is one
 * closed arc, and the two faces enter it at different points as well as in
 * opposite directions. Both differences have to be normalised away or the two
 * copies never match.
 */
function canonicalClosed(
  xs: number[], ys: number[],
): { key: string; reversed: boolean; start: number } {
  const n = xs.length;
  let best = 0;
  for (let i = 1; i < n; i++) {
    if (xs[i] < xs[best] || (xs[i] === xs[best] && ys[i] < ys[best])) best = i;
  }
  const fwd: string[] = [];
  const rev: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = (best + i) % n;
    const r = (best - i + n * n) % n;
    fwd.push(xs[f] + ',' + ys[f]);
    rev.push(xs[r] + ',' + ys[r]);
  }
  const f = fwd.join(';');
  const r = rev.join(';');
  return f <= r
    ? { key: f, reversed: false, start: best }
    : { key: r, reversed: true, start: best };
}

/** Order a region pair so both sides key it the same way. */
function pair(one: number, other: number): { a: number; b: number } {
  return one <= other ? { a: one, b: other } : { a: other, b: one };
}

/**
 * Split every loop into arcs, storing each shared run once.
 *
 * `loopsByComponent` must come from `traceComponents(..., splitAtJunctions=true)`,
 * or the runs the two sides see will not line up: without it the collinear
 * collapse deletes a junction that happens to sit on a straight stretch, and one
 * face's arc spans two of its neighbour's.
 */
export function decomposeToArcs(
  loopsByComponent: Loop[][],
  labels: Int32Array,
  width: number,
  height: number,
): ArcDecomposition {
  const arcs: Arc[] = [];
  const faces = new Map<Loop, ArcRef[]>();
  const index = new Map<string, number>();

  for (let comp = 0; comp < loopsByComponent.length; comp++) {
    for (const loop of loopsByComponent[comp] ?? []) {
      const os = loop.otherSide;
      if (!os) throw new Error('decomposeToArcs needs otherSide; trace with splitAtJunctions');
      const n = loop.pts.length / 2;
      const px = (i: number): number => loop.pts[i * 2];
      const py = (i: number): number => loop.pts[i * 2 + 1];

      // A vertex is a junction when the neighbour across the boundary changes
      // there, or when more than two cracks meet.
      //
      // The second test subsumes the first, and provably so: if the neighbour
      // changes at a vertex then three labels meet there, and three labels among
      // four cells make at least three of the four crack tests differ. Measured
      // over the corpus, 0 vertices in ~160,000 fire the neighbour test without
      // also failing the degree test. The degree test alone does 14 to 622
      // additional splits per subject — the checkerboard saddle, where one region
      // meets itself diagonally and the walker sees the same neighbour either
      // side.
      //
      // Both are kept because `contour.ts` decides what survives the collinear
      // collapse using the neighbour test specifically. Naming it here as well
      // keeps the two modules visibly agreeing about what a junction is, rather
      // than relying on a subsumption argument holding after someone edits one of
      // them.
      const isJunction = new Uint8Array(n);
      let junctionCount = 0;
      for (let i = 0; i < n; i++) {
        const prev = os[(i - 1 + n) % n];
        if (prev !== os[i] || crackDegree(labels, width, height, px(i), py(i)) !== 2) {
          isJunction[i] = 1;
          junctionCount++;
        }
      }

      const refs: ArcRef[] = [];

      if (junctionCount === 0) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < n; i++) { xs.push(px(i)); ys.push(py(i)); }
        const { key, reversed, start } = canonicalClosed(xs, ys);
        let id = index.get(key);
        if (id === undefined) {
          const pts = new Int32Array(n * 2);
          for (let i = 0; i < n; i++) {
            const j = reversed ? (start - i + n * n) % n : (start + i) % n;
            pts[i * 2] = xs[j];
            pts[i * 2 + 1] = ys[j];
          }
          id = arcs.length;
          arcs.push({ pts, ...pair(comp, os[0]), closed: true });
          index.set(key, id);
        }
        refs.push({ arc: id, reversed });
        faces.set(loop, refs);
        continue;
      }

      // Start at a junction so every run between two of them comes out whole.
      let start = 0;
      while (!isJunction[start]) start++;

      let i = start;
      do {
        const xs: number[] = [px(i)];
        const ys: number[] = [py(i)];
        const other = os[i];
        let j = (i + 1) % n;
        for (;;) {
          xs.push(px(j));
          ys.push(py(j));
          if (isJunction[j]) break;
          j = (j + 1) % n;
        }
        const { key, reversed } = canonical(xs, ys);
        let id = index.get(key);
        if (id === undefined) {
          const pts = new Int32Array(xs.length * 2);
          for (let k = 0; k < xs.length; k++) {
            const s = reversed ? xs.length - 1 - k : k;
            pts[k * 2] = xs[s];
            pts[k * 2 + 1] = ys[s];
          }
          id = arcs.length;
          arcs.push({ pts, ...pair(comp, other), closed: false });
          index.set(key, id);
        }
        refs.push({ arc: id, reversed });
        i = j;
      } while (i !== start);

      faces.set(loop, refs);
    }
  }

  return { arcs, faces };
}

/** True when both sides of an arc are real regions, so it is an interior seam. */
export function isInterior(arc: Arc): boolean {
  return arc.a !== OUTSIDE_FRAME && arc.b !== OUTSIDE_FRAME && arc.a !== -1 && arc.b !== -1;
}

/**
 * Walk a face's arcs and rebuild the vertex sequence it stands for.
 *
 * Each open arc contributes every vertex but its last, because the last is the
 * next arc's first. The result must equal `loop.pts` up to rotation, which is what
 * makes the decomposition safe to substitute for the loop.
 */
export function rebuildFace(refs: ArcRef[], arcs: Arc[]): Int32Array {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const ref of refs) {
    const arc = arcs[ref.arc];
    const n = arc.pts.length / 2;
    if (arc.closed) {
      // Replayed from the canonical start, which is generally not where the loop
      // entered — the same cycle, rotated. See `ArcDecomposition.faces`.
      for (let i = 0; i < n; i++) {
        const c = ref.reversed ? (n - i) % n : i;
        xs.push(arc.pts[c * 2]);
        ys.push(arc.pts[c * 2 + 1]);
      }
      continue;
    }
    for (let i = 0; i < n - 1; i++) {
      const j = ref.reversed ? n - 1 - i : i;
      xs.push(arc.pts[j * 2]);
      ys.push(arc.pts[j * 2 + 1]);
    }
  }
  const out = new Int32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i];
    out[i * 2 + 1] = ys[i];
  }
  return out;
}

/** What {@link verifyTwins} found, so a caller can report rather than throw. */
export interface TwinReport {
  /** Interior arcs referenced by exactly two faces, once each way. */
  paired: number;
  /** Interior arcs referenced the wrong number of times, or the same way twice. */
  unpaired: number;
  /** Arcs with a region on one side only — the outer silhouette and the frame. */
  boundary: number;
}

/**
 * Check the property the whole scheme rests on: every interior arc is used by
 * exactly two faces, in opposite directions.
 *
 * Asserted rather than assumed, because the argument for it depends on the
 * collinear collapse retaining the same vertices from both sides, and that is a
 * property of code in another module which could change without anyone here
 * noticing.
 */
export function verifyTwins(dec: ArcDecomposition): TwinReport {
  const forward = new Int32Array(dec.arcs.length);
  const backward = new Int32Array(dec.arcs.length);
  for (const refs of dec.faces.values()) {
    for (const ref of refs) {
      if (ref.reversed) backward[ref.arc]++;
      else forward[ref.arc]++;
    }
  }
  let paired = 0;
  let unpaired = 0;
  let boundary = 0;
  for (let i = 0; i < dec.arcs.length; i++) {
    if (!isInterior(dec.arcs[i])) { boundary++; continue; }
    if (forward[i] === 1 && backward[i] === 1) paired++;
    else unpaired++;
  }
  return { paired, unpaired, boundary };
}

/**
 * Reverse a fitted path exactly.
 *
 * Every control point is reused, swapped in pairs — no refitting, so the reversed
 * traversal is the same curve to the last bit. That is the whole point of arcs:
 * the face on the other side gets geometry that agrees by construction rather
 * than by refitting and hoping.
 *
 * A QUADRATIC KEEPS ITS SINGLE CONTROL POINT, which is a claim rather than an
 * assumption and is checked in the suite. `B(t) = (1-t)^2 P0 + 2(1-t)t Q + t^2
 * P2`, so `B(1-t)` is the same expression with `P0` and `P2` exchanged and `Q`
 * where it was — the Bernstein basis is symmetric and there is only one middle
 * term to swap with itself. The cubic case swaps two, which is why it looks like
 * the general rule and is not.
 */
export function reversePath(path: FittedPath): FittedPath {
  const on: Point[] = [path.start];
  for (const s of path.segments) on.push({ x: s.x, y: s.y });

  const segments: Segment[] = [];
  for (let i = path.segments.length - 1; i >= 0; i--) {
    const s = path.segments[i];
    const target = on[i];
    if (s.kind === 'line') segments.push({ kind: 'line', x: target.x, y: target.y });
    else if (s.kind === 'quad') {
      segments.push({ kind: 'quad', x1: s.x1, y1: s.y1, x: target.x, y: target.y });
    } else {
      segments.push({
        kind: 'curve',
        x1: s.x2, y1: s.y2,
        x2: s.x1, y2: s.y1,
        x: target.x, y: target.y,
      });
    }
  }
  return { start: on[on.length - 1], segments };
}

/** Fitting options for a whole decomposition. */
export interface FitArcsOptions extends OpenFitOptions {
  /** Passed to {@link fitLoop} for arcs that carry no junction. */
  closed?: FitOptions;
  /**
   * Continuous-tone source, for antialiasing-based refinement of open interior
   * arcs (see {@link refineOpenArc}) before each is fitted. Requires `labels`.
   * Omit either to fit every open arc's raw lattice points unchanged, exactly as
   * before this option existed.
   */
  image?: RasterImage;
  /** Component ids from `connectedComponents`, matching `image` pixel-for-pixel. */
  labels?: Int32Array;
}

/**
 * Fit every arc once, then assemble each face from the results.
 *
 * The two faces sharing an arc receive the same curve, one of them reversed
 * through {@link reversePath}. Nothing is fitted twice, so nothing can disagree —
 * which is what the reversal asymmetry recorded at the top of this file makes
 * impossible any other way.
 */
export function fitFaces(
  dec: ArcDecomposition, opts: FitArcsOptions,
): Map<Loop, FittedPath> {
  const fitted: Array<FittedPath | null> = dec.arcs.map((arc) => {
    if (!arc.closed) {
      // Refine only interior arcs: a silhouette or frame edge (see `isInterior`)
      // has no real region on its outside to measure coverage against.
      const pts = opts.image && opts.labels && isInterior(arc)
        ? refineOpenArc(arc.pts, opts.image, opts.labels, arc.a).pts
        : arc.pts;
      return fitOpen(pts, opts);
    }
    const loop = fitLoop(arc.pts, opts.closed ?? {
      tolerance: opts.tolerance,
      fitError: opts.fitError,
      cornerAngle: opts.cornerAngle,
      polygonOnly: false,
      optimize: opts.optimize,
      optimizeError: opts.optimizeError,
      regularise: opts.regularise,
      regulariseBand: opts.regulariseBand,
      quadratics: opts.quadratics,
    });
    if (!loop) return null;
    // Make the cycle explicit so reversal and concatenation treat closed and open
    // arcs alike. `fitLoop`'s polygon branch leaves the return leg to `z`; the
    // curve branch already emits it.
    const last = loop.segments[loop.segments.length - 1];
    if (last && (last.x !== loop.start.x || last.y !== loop.start.y)) {
      loop.segments.push({ kind: 'line', x: loop.start.x, y: loop.start.y });
    }
    return loop;
  });

  const out = new Map<Loop, FittedPath>();
  for (const [loop, refs] of dec.faces) {
    const segments: Segment[] = [];
    let start: Point | null = null;
    for (const ref of refs) {
      const base = fitted[ref.arc];
      if (!base) continue;
      const piece = ref.reversed ? reversePath(base) : base;
      if (start === null) start = piece.start;
      for (const s of piece.segments) segments.push(s);
    }
    if (start === null || segments.length === 0) continue;
    // The last segment lands back on the first point; `z` covers that, and a
    // zero-length line before it is the redundancy fit.ts already removed once.
    const last = segments[segments.length - 1];
    if (last.kind === 'line' && last.x === start.x && last.y === start.y) segments.pop();
    if (segments.length === 0) continue;
    out.set(loop, { start, segments });
  }
  return out;
}
