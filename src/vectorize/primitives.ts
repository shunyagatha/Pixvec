/**
 * Geometric primitive recognition.
 *
 * A tracer that only ever emits cubic Béziers turns a circle into a four-curve
 * approximation and a rectangle into four `lineto`s — larger than they need to
 * be and, worse, no longer editable *as* a circle or a rectangle in a vector
 * editor or a CAD tool. This module looks at a boundary loop and, when the
 * shape genuinely *is* one, returns the exact primitive instead: `<circle>`,
 * `<ellipse>`, `<rect>`, or — for a pie slice or a donut segment — a `<path>`
 * of real SVG arc commands.
 *
 * The decision is gated on a hard geometric residual — a loop only becomes a
 * primitive when its boundary lies within `maxError` pixels of the fitted shape
 * — never a guess that rounds an organic blob into a circle. Rectangles fit
 * exactly (their contour *is* four integer corners); circles, ellipses and
 * sectors clear the same sub-pixel bar.
 *
 * "Within a pixel" is not the same as "identical", and the honest word is a
 * *trade*, not "render-preserving". A curved primitive replaces a pixel
 * staircase with a true arc, and an ideal arc cannot follow a staircase exactly
 * — so a `<circle>` or a `<sector>` gives up on the order of 0.02 SSIM against
 * the source raster in exchange for geometry a fraction of the size that a CAD
 * tool can actually read as an arc. That is the same bargain the shipped
 * `<circle>` already makes; the `<rect>` alone is genuinely render-identical.
 *
 * The residual is measured differently for the sector: the contour tracer stores
 * a straight run as its two endpoints however long it is, so a sector's radial
 * edges are only a handful of vertices, and a per-vertex test would say nothing
 * about the pixel between them. The sector is judged on a resampling of the
 * whole boundary instead.
 *
 * Pure: integer lattice in, plain description out. No dependencies.
 */

export type Primitive =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'roundrect'; x: number; y: number; w: number; h: number; r: number }
  /**
   * A circular sector: a pie slice (`r0 === 0`) or a ring/donut segment
   * (`r0 > 0`). Angles are in radians in SVG's screen frame (y down), and the
   * sector sweeps from `a0` to `a1` in the direction of increasing angle.
   */
  | { kind: 'sector'; cx: number; cy: number; r0: number; r1: number; a0: number; a1: number };

export interface PrimitiveOptions {
  /** Every vertex must sit within this many pixels of the fitted shape. Default 1.0. */
  maxError?: number;
  /** Ignore shapes smaller than this (px) in either extent. Default 3. */
  minExtent?: number;
}

const DEFAULTS = { maxError: 1.0, minExtent: 3 } as const;

/**
 * Recognise a `<circle>`, `<ellipse>` or `<rect>` in a boundary loop, or return
 * `null` when the loop is not cleanly one of them. `pts` is a flat, implicitly
 * closed `x,y` polygon on the integer lattice — a {@link Loop}'s `pts`.
 */
export function detectPrimitive(
  pts: Int32Array | number[],
  opts: PrimitiveOptions = {},
): Primitive | null {
  const maxError = opts.maxError ?? DEFAULTS.maxError;
  const minExtent = opts.minExtent ?? DEFAULTS.minExtent;
  const n = pts.length >> 1;
  if (n < 4) return null; // fewer than a quadrilateral: nothing to recognise

  const b = bbox(pts, n);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w < minExtent || h < minExtent) return null;

  const area = Math.abs(shoelace(pts, n));

  // Collect every candidate that clears the residual bar, then keep the tightest
  // fit. Rectangle and circle are near mutually exclusive in practice, but
  // scoring makes the choice robust instead of order-dependent.
  let best: Primitive | null = null;
  let bestErr = Infinity;

  const rect = fitRect(pts, n, b, w, h, area);
  if (rect && rect.err <= maxError) {
    best = rect.prim;
    bestErr = rect.err;
  }

  const circle = fitCircle(pts, n, area);
  if (circle && circle.err <= maxError && circle.err < bestErr) {
    best = circle.prim;
    bestErr = circle.err;
  }

  // Only bother with an ellipse when it is meaningfully non-circular; a round
  // ellipse is a circle and should have been caught above.
  if (Math.abs(w - h) > 1) {
    const ell = fitEllipse(pts, n, b, w, h, area);
    if (ell && ell.err <= maxError && ell.err < bestErr) {
      best = ell.prim;
      bestErr = ell.err;
    }
  }

  // A rounded rectangle — the workhorse UI/icon shape. A sharp rect wins ties
  // (its err is 0), and a circle is caught above, so this only claims shapes
  // that genuinely have rounded corners and no better fit.
  const round = fitRoundRect(pts, n, b, w, h);
  if (round && round.err <= maxError && round.err < bestErr) {
    best = round.prim;
    bestErr = round.err;
  }

  // A pie slice or ring segment. Tried last and only when nothing simpler has
  // already claimed the loop: it is the most expensive fit here, and a circle,
  // rect or rounded rect that fits is never *also* a sector worth preferring.
  if (best === null) {
    const sec = fitSector(pts, n, b, w, h, area, maxError);
    if (sec && sec.err <= maxError) {
      best = sec.prim;
      bestErr = sec.err;
    }
  }

  return best;
}

/** Serialise a primitive to its SVG element. `attrs` carries fill/stroke. */
export function primitiveSvg(prim: Primitive, attrs: string, precision = 2): string {
  const r = (v: number) => round(v, precision);
  switch (prim.kind) {
    case 'circle':
      return `<circle cx="${r(prim.cx)}" cy="${r(prim.cy)}" r="${r(prim.r)}"${attrs}/>`;
    case 'ellipse':
      return `<ellipse cx="${r(prim.cx)}" cy="${r(prim.cy)}" rx="${r(prim.rx)}" ry="${r(prim.ry)}"${attrs}/>`;
    case 'rect':
      return `<rect x="${r(prim.x)}" y="${r(prim.y)}" width="${r(prim.w)}" height="${r(prim.h)}"${attrs}/>`;
    case 'roundrect':
      return `<rect x="${r(prim.x)}" y="${r(prim.y)}" width="${r(prim.w)}" height="${r(prim.h)}" rx="${r(prim.r)}" ry="${r(prim.r)}"${attrs}/>`;
    case 'sector':
      return `<path d="${sectorPath(prim, precision)}"${attrs}/>`;
  }
}

/**
 * A sector as real SVG arc commands — `A rx ry rot large-arc sweep x y` — not a
 * polyline pretending to be round. `d` comes first so the element reads as the
 * arc it is, and so a consumer scanning for arc paths finds it.
 */
function sectorPath(
  prim: Extract<Primitive, { kind: 'sector' }>,
  precision: number,
): string {
  const r = (v: number) => round(v, precision);
  const { cx, cy, r0, r1, a0, a1 } = prim;
  const sweep = a1 - a0;
  const large = sweep > Math.PI ? 1 : 0;
  const px = (rad: number, a: number) => `${r(cx + rad * Math.cos(a))} ${r(cy + rad * Math.sin(a))}`;
  // Outer arc runs a0 -> a1 (increasing angle, sweep-flag 1); the inner arc
  // comes back the other way, so the two radial edges close the figure.
  if (r0 <= 0) {
    return `M${r(cx)} ${r(cy)}L${px(r1, a0)}A${r(r1)} ${r(r1)} 0 ${large} 1 ${px(r1, a1)}Z`;
  }
  return (
    `M${px(r0, a0)}L${px(r1, a0)}` +
    `A${r(r1)} ${r(r1)} 0 ${large} 1 ${px(r1, a1)}` +
    `L${px(r0, a1)}` +
    `A${r(r0)} ${r(r0)} 0 ${large} 0 ${px(r0, a0)}Z`
  );
}

// --- fitters ---------------------------------------------------------------

/** Axis-aligned rectangle: the contour of a real rect is exactly its bbox. */
function fitRect(
  pts: Int32Array | number[],
  n: number,
  b: Bbox,
  w: number,
  h: number,
  area: number,
): { prim: Primitive; err: number } | null {
  // Cheap pre-filter: a real rectangle fills its bounding box.
  if (area < 0.95 * w * h) return null;
  // The real gate is per-vertex, like circle and ellipse: how far the worst
  // boundary vertex sits from the nearest bbox edge. Zero for a true rectangle;
  // large for a notch, slot or spike whose small area the ratio alone waves
  // through (a 2-wide, 60-deep slot removes <5% of area but is 60px off-shape).
  let err = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    const d = Math.min(x - b.minX, b.maxX - x, y - b.minY, b.maxY - y);
    if (d > err) err = d;
  }
  return { prim: { kind: 'rect', x: b.minX, y: b.minY, w, h }, err };
}

/**
 * Rounded rectangle. The outline is the level set `distanceToShrunkBox(p) = r`,
 * where the shrunk box is the bbox inset by the corner radius `r` — that single
 * signed-distance identity scores edges and corner arcs alike. `r` is unknown,
 * so it is swept and the value with the smallest worst-vertex residual wins.
 */
function fitRoundRect(
  pts: Int32Array | number[],
  n: number,
  b: Bbox,
  w: number,
  h: number,
): { prim: Primitive; err: number } | null {
  const maxR = Math.min(w, h) / 2;
  if (maxR < 2) return null; // too small to carry a meaningful radius

  const MIN_R = 2;
  const STEPS = 48;
  let bestR = 0;
  let bestErr = Infinity;
  for (let s = 0; s <= STEPS; s++) {
    const r = MIN_R + ((maxR - MIN_R) * s) / STEPS;
    const ix0 = b.minX + r, ix1 = b.maxX - r, iy0 = b.minY + r, iy1 = b.maxY - r;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[i << 1], y = pts[(i << 1) + 1];
      const qx = Math.max(ix0 - x, x - ix1, 0);
      const qy = Math.max(iy0 - y, y - iy1, 0);
      const res = Math.abs(Math.hypot(qx, qy) - r);
      if (res > worst) worst = res;
      if (worst >= bestErr) break; // cannot beat the incumbent; stop early
    }
    if (worst < bestErr) { bestErr = worst; bestR = r; }
  }
  if (bestR < MIN_R) return null;
  // When the radius fills the whole half-extent AND the box is square, there are
  // no straight edges left — it is a circle, not a rounded rectangle. Defer, so
  // the circle fitter (tried first) keeps it. A stadium (w≠h, r=min/2) is still
  // a legitimate rounded rect and passes.
  if (bestR >= maxR - 0.75 && Math.abs(w - h) <= 1.5) return null;
  return { prim: { kind: 'roundrect', x: b.minX, y: b.minY, w, h, r: bestR }, err: bestErr };
}

/** Algebraic (Kåsa) least-squares circle, gated on the worst radial residual. */
function fitCircle(
  pts: Int32Array | number[],
  n: number,
  area: number,
): { prim: Primitive; err: number } | null {
  // A circle needs a proper arc of samples. Four corners of a rectangle are
  // concyclic and would fit a circumcircle with zero residual — the vertex
  // floor keeps that from ever reaching the circle fitter.
  if (n < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] · [A B C]ᵀ = [sxz syz sz]ᵀ
  const sol = solve3(
    sxx, sxy, sx,
    sxy, syy, sy,
    sx, sy, n,
    sxz, syz, sz,
  );
  if (!sol) return null;
  const [A, B, C] = sol;
  const cx = A / 2, cy = B / 2;
  const rSq = C + cx * cx + cy * cy;
  if (rSq <= 0) return null;
  const r = Math.sqrt(rSq);

  // The polygon must enclose a full disc, not fit a circle along one arc.
  if (area < 0.85 * Math.PI * r * r) return null;

  let maxRes = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i << 1] - cx, dy = pts[(i << 1) + 1] - cy;
    const res = Math.abs(Math.hypot(dx, dy) - r);
    if (res > maxRes) maxRes = res;
  }
  return { prim: { kind: 'circle', cx, cy, r }, err: maxRes };
}

/** Axis-aligned ellipse seeded from the bbox, gated on the worst point residual. */
function fitEllipse(
  pts: Int32Array | number[],
  n: number,
  b: Bbox,
  w: number,
  h: number,
  area: number,
): { prim: Primitive; err: number } | null {
  if (n < 8) return null; // same arc-sampling requirement as the circle
  const cx = b.minX + w / 2, cy = b.minY + h / 2;
  const rx = w / 2, ry = h / 2;
  if (rx < 1 || ry < 1) return null;
  // A full ellipse encloses ~π·rx·ry.
  if (area < 0.85 * Math.PI * rx * ry) return null;

  let maxRes = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i << 1], py = pts[(i << 1) + 1];
    // Sampson distance: a first-order estimate of the true geometric distance
    // to the conic, |F| / |∇F|. Far more accurate than matching eccentric
    // angles, which overestimates the residual off the axes.
    const nx = (px - cx) / rx, ny = (py - cy) / ry;
    const f = nx * nx + ny * ny - 1;
    const gx = (2 * (px - cx)) / (rx * rx);
    const gy = (2 * (py - cy)) / (ry * ry);
    const grad = Math.hypot(gx, gy);
    const res = grad > 1e-9 ? Math.abs(f) / grad : Math.abs(f);
    if (res > maxRes) maxRes = res;
  }
  return { prim: { kind: 'ellipse', cx, cy, rx, ry }, err: maxRes };
}

// --- sector ----------------------------------------------------------------

const TAU = Math.PI * 2;

/** A candidate sector: centre, two radii, and the angular span `a0 -> a0+sweep`. */
interface Sector {
  cx: number; cy: number;
  r0: number; r1: number;
  a0: number; sweep: number;
  /** cos/sin of the two radial rays, cached — the residual needs them per point. */
  c0: number; s0: number; c1: number; s1: number;
  /** Samples that voted for the outer arc; a sector needs a real arc, not two. */
  arcOut: number;
}

/**
 * Pie slice and ring segment.
 *
 * Every least-squares route to the centre fails here, and for one reason: a
 * sector's boundary is mostly *not* the arc. Two straight radial edges and (for
 * a donut) a second arc all pull on the fit, so a circle fitted over the whole
 * loop lands tens of pixels from the true centre, and re-fitting from that
 * estimate only walks further away. Selecting rim points by curvature does not
 * rescue it either: a few percent of contamination is enough, because the
 * normal equations weight every point equally no matter how wrong it is.
 *
 * So the centre is *searched for*, not solved for. The score is the thing that
 * actually has to be true — the worst distance from any boundary sample to the
 * sector outline — evaluated over a grid of candidate centres and then refined
 * by a beam. An outlier cannot drag a search the way it drags a normal equation:
 * a wrong centre simply scores badly and is discarded.
 *
 * Given a centre, the remaining four parameters are read straight off the point
 * cloud, each as a *minimax* estimate so it sits in the middle of the pixel
 * staircase rather than on one edge of it:
 *
 *   - `r1`, `r0` — midpoint of the radius band, measured only over samples well
 *     inside the angular span so the radial edges cannot bias them.
 *   - `a0`, `a1` — each ray rotated to minimise its worst perpendicular offset,
 *     measured only over samples well between the two radii.
 *
 * On a traced 100px pie chart that lands the worst residual at 0.700px — bit for
 * bit the same figure a plain rasterised disc gives the circle fitter, i.e. the
 * staircase floor, with nothing left over for the model to explain. Measured
 * envelope on traced contours: sweeps from about 0.8 rad up to a full turn, radii
 * from ~12px up, and any ring thickness; below those the sagitta gate correctly
 * declines, because a shallower arc is not distinguishable from a straight edge
 * inside the error budget.
 */
function fitSector(
  pts: Int32Array | number[],
  n: number,
  b: Bbox,
  w: number,
  h: number,
  area: number,
  maxError: number,
): { prim: Primitive; err: number } | null {
  // A sector needs a sampled arc plus two edges. Anything this small or this
  // coarse is cheaper to leave as a path, and skipping it keeps the fitter off
  // the thousands of four-vertex specks a photograph produces.
  if (n < 20 || w < 8 || h < 8) return null;
  const diag = Math.hypot(w, h);

  // One dense cloud, and two strided subsets of it. The dense one is what the
  // gate judges by, because it has to see the whole boundary: a contour stores a
  // straight run as its two endpoints however long it is, so testing vertices
  // alone would let a spike or a notch through between them.
  //
  // Subsets rather than independent resamplings, so `worst` over a sparse cloud
  // is provably a lower bound on `worst` over the dense one — which is what lets
  // the search abandon a hopeless shape early instead of running to convergence
  // to find out.
  const fine = densify(pts, n, 1800);
  const coarse = stride(fine, 192);
  const probe = stride(fine, 56);

  // --- locate the centre ---
  //
  // A coarse grid over an expanded bounding box (the centre of a thin ring
  // segment sits well outside the segment's own box) proposes starting points,
  // and a beam of the best few is then refined, halving the step each round.
  //
  // A beam and not a single descent: the score is piecewise, because moving the
  // centre far enough makes the angular gap turn up somewhere else entirely and
  // the model jumps. A lone greedy walk stalls in those side valleys — measured,
  // not assumed; it is what kept losing one segment of the donut.
  const pad = 0.6 * diag;
  const step0 = Math.max(1, diag / 12);

  // How much better the score can still get, given the search may still move the
  // centre by `2√2·s` in total (the halving series, diagonally).
  //
  // The bound is sound rather than tuned: the sector family is closed under
  // translation and the residual is 1-Lipschitz in a translation of the centre,
  // so the best model at any centre c′ scores at least `score(c) − |c′ − c|`.
  // Anything still that far above the error budget cannot reach it, and is
  // dropped without finishing the descent.
  const reachable = (q: number, s: number): boolean => q - 2.9 * s <= maxError;
  const keep = maxError + 2.9 * step0;
  // The grid is by far the most-visited code here — hundreds of cells for every
  // hole-free region in the image — so it runs on a *sparse* cloud. Fifty-odd
  // samples cannot measure a sector, but they can rule one out, which is all
  // this pass is for; survivors are re-scored properly before the beam starts.
  let beam: { x: number; y: number; q: number }[] = [];
  for (let cx = b.minX - pad; cx <= b.maxX + pad; cx += step0) {
    for (let cy = b.minY - pad; cy <= b.maxY + pad; cy += step0) {
      const q = score(probe, cx, cy, keep, false);
      if (q < keep) beam.push({ x: cx, y: cy, q });
    }
  }
  // Nowhere near a sector? Stop before paying for the refinement. The threshold
  // is deliberately loose — the grid is coarse, so a true sector still scores a
  // few pixels here — but it rejects most shapes outright.
  if (beam.length === 0) return null;
  beam = prune(beam, BEAM, step0);
  for (const c of beam) c.q = score(coarse, c.x, c.y, keep, false);
  beam = prune(beam, BEAM, 0);
  if (!reachable(beam[0].q, step0)) return null;

  for (let s = step0; s > 0.04; s /= 2) {
    // Once the step goes sub-pixel the approximations that made the search cheap
    // are larger than the move being decided, so the last rounds switch to the
    // full model *and* to the same dense cloud the acceptance gate uses. Judging
    // the final half pixel on a sparser cloud than the gate is how a good centre
    // gets discarded: the two disagree by more than the plateau is wide.
    const close = s <= 1;
    const D = close ? fine : coarse;
    const cut = maxError + 2.9 * s;
    const cand: { x: number; y: number; q: number }[] = [];
    for (const c of beam) {
      cand.push({ x: c.x, y: c.y, q: score(D, c.x, c.y, cut, close) });
      for (let d = 0; d < 8; d++) {
        const x = c.x + DIR_X[d] * s, y = c.y + DIR_Y[d] * s;
        cand.push({ x, y, q: score(D, x, y, cut, close) });
      }
    }
    cand.sort((p, q) => p.q - q.q);
    if (!reachable(cand[0].q, s)) return null;
    beam = prune(cand, close ? 3 : BEAM, s / 2);
  }

  // --- judge the winner against every boundary sample ---
  const m = derive(fine, beam[0].x, beam[0].y, true);
  if (!m) return null;
  const err = worst(fine, m, Infinity);
  if (err > maxError) return null;

  // The arc has to be an arc. A thin triangle is a sector whose "arc" is almost
  // a chord, and it would pass the residual gate purely because the sagitta is
  // sub-pixel; requiring the bulge to be several times the error budget keeps
  // straight-edged shapes out.
  const sagitta = m.r1 * (1 - Math.cos(m.sweep / 2));
  if (sagitta < Math.max(2, 3 * maxError)) return null;
  if (m.arcOut < 8) return null;

  // And it has to be *this* shape: a sector's area is fixed by its parameters,
  // so a loop that merely hugs part of the outline cannot pass.
  const sArea = 0.5 * m.sweep * (m.r1 * m.r1 - m.r0 * m.r0);
  if (Math.abs(sArea - area) > 0.06 * Math.max(area, 1)) return null;

  return {
    prim: { kind: 'sector', cx: m.cx, cy: m.cy, r0: m.r0, r1: m.r1, a0: m.a0, a1: m.a0 + m.sweep },
    err,
  };
}

const DIR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const DIR_Y = [0, 0, 1, -1, 1, -1, 1, -1];
/** Centres carried forward per refinement round. */
const BEAM = 5;

/** Worst residual of the best sector through `(cx, cy)`, or Infinity if none. */
function score(D: Float64Array, cx: number, cy: number, bail: number, refine: boolean): number {
  const m = derive(D, cx, cy, refine);
  if (!m) return Infinity;
  return worst(D, m, bail);
}

/**
 * Keep the `k` best candidates that are at least `apart` from one another, so
 * the beam spends its width on distinct basins instead of on `k` samples of the
 * same one. Sorts `cand` in place.
 */
function prune(
  cand: { x: number; y: number; q: number }[],
  k: number,
  apart: number,
): { x: number; y: number; q: number }[] {
  cand.sort((p, q) => p.q - q.q);
  const out: { x: number; y: number; q: number }[] = [];
  for (const c of cand) {
    if (out.length >= k) break;
    let clear = true;
    for (const p of out) {
      if (Math.hypot(p.x - c.x, p.y - c.y) <= apart) { clear = false; break; }
    }
    if (clear) out.push(c);
  }
  return out.length > 0 ? out : cand.slice(0, 1);
}

/**
 * Resample the closed polygon at roughly one point per pixel, capped at `cap`
 * points. Long straight runs are stored as a single edge by the contour tracer,
 * so walking vertices would skip most of a radial edge entirely.
 */
function densify(pts: Int32Array | number[], n: number, cap: number): Float64Array {
  let perim = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    perim += Math.hypot(pts[i << 1] - pts[j << 1], pts[(i << 1) + 1] - pts[(j << 1) + 1]);
  }
  const step = Math.max(1, perim / cap);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i << 1], y0 = pts[(i << 1) + 1];
    const dx = pts[j << 1] - x0, dy = pts[(j << 1) + 1] - y0;
    const k = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let t = 0; t < k; t++) out.push(x0 + (dx * t) / k, y0 + (dy * t) / k);
  }
  return Float64Array.from(out);
}

/** Every k-th point of a cloud, k chosen to land near `cap` points. */
function stride(D: Float64Array, cap: number): Float64Array {
  const m = D.length >> 1;
  const k = Math.max(1, Math.ceil(m / cap));
  if (k === 1) return D;
  const out = new Float64Array(((m + k - 1) / k | 0) * 2);
  for (let i = 0, j = 0; i < m; i += k, j++) {
    out[j << 1] = D[i << 1];
    out[(j << 1) + 1] = D[(i << 1) + 1];
  }
  return out;
}

/**
 * Read `r0`, `r1`, `a0`, `a1` off the point cloud for a fixed centre.
 *
 * `refine` buys the last half pixel: it re-seats each radial ray in the middle
 * of its staircase band and re-reads the radii from the corrected span. Skipped
 * while the search is still tens of pixels out, where it changes the score by
 * less than the step size and costs more than the rest of the fit put together.
 */
function derive(D: Float64Array, cx: number, cy: number, refine: boolean): Sector | null {
  const m = D.length >> 1;
  if (m < 12) return null;
  const rad = new Float64Array(m);
  const ang = new Float64Array(m);
  let rMax = 0, rMin = Infinity;
  for (let i = 0; i < m; i++) {
    const dx = D[i << 1] - cx, dy = D[(i << 1) + 1] - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    rad[i] = r;
    ang[i] = Math.atan2(dy, dx);
    if (r > rMax) rMax = r;
    if (r < rMin) rMin = r;
  }
  if (rMax < 5) return null;

  let r1 = rMax;
  // A hole in the middle means a ring segment; an apex that reaches the centre
  // means a pie slice, and then the inner radius is exactly zero.
  let r0 = rMin > 0.12 * rMax ? rMin : 0;

  // The angular span is the complement of the largest gap in the angle set.
  // Samples near the apex are excluded: at r -> 0 their angle is noise.
  const gate = Math.max(r0 + 1, 0.25 * r1);
  const angs: number[] = [];
  for (let i = 0; i < m; i++) if (rad[i] >= gate) angs.push(ang[i]);
  if (angs.length < 8) return null;
  angs.sort((p, q) => p - q);
  let gap = -1, gi = 0;
  for (let i = 0; i < angs.length; i++) {
    const next = i === angs.length - 1 ? angs[0] + TAU : angs[i + 1];
    if (next - angs[i] > gap) { gap = next - angs[i]; gi = i; }
  }
  let a0 = angs[(gi + 1) % angs.length];
  let a1 = angs[gi];
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += TAU;
  // No gap at all is a full disc or annulus, which the circle fitter owns.
  if (sweep < 0.25 || sweep > TAU - 0.15) return null;
  a1 = a0 + sweep;

  let arcOut = 0;
  const passes = refine ? 3 : 1;
  for (let pass = 0; pass < passes; pass++) {
    // Radii from arc samples only — those inside the span and clear of both
    // rays, so a radial edge running out to the rim cannot drag the estimate.
    const band = Math.max(2, Math.min(5, 0.05 * r1));
    const marg = Math.min(0.35 * sweep, 4 / r1);
    let oHi = -Infinity, oLo = Infinity, oN = 0;
    let iHi = -Infinity, iLo = Infinity, iN = 0;
    const mid = r0 > 0 ? (r0 + r1) / 2 : r1 / 2;
    for (let i = 0; i < m; i++) {
      let a = ang[i] - a0;
      a -= TAU * Math.floor(a / TAU);
      if (a < marg || a > sweep - marg) continue;
      const r = rad[i];
      if (r > r1 - band && r > mid) {
        if (r > oHi) oHi = r;
        if (r < oLo) oLo = r;
        oN++;
      } else if (r0 > 0 && r < r0 + band) {
        if (r > iHi) iHi = r;
        if (r < iLo) iLo = r;
        iN++;
      }
    }
    if (oN < 6) return null;
    arcOut = oN;
    // Midpoint of the band, not its mean: the residual gate is a worst case, so
    // the estimate that minimises the worst case is the one to hand it.
    r1 = (oHi + oLo) / 2;
    if (r0 > 0) {
      if (iN < 4) return null;
      r0 = (iHi + iLo) / 2;
    }
    if (r1 - r0 < 3) return null;

    if (!refine) break;

    // Rays from edge samples only — those between the two radii, so the arcs
    // cannot drag them. Each ray is then rotated about the centre to the angle
    // that minimises its worst perpendicular offset: the middle of the
    // staircase band, which is what puts the residual at the pixel floor
    // instead of at the full width of the band.
    const pad = Math.max(1.5, 0.04 * (r1 - r0));
    const loR = r0 + pad, hiR = r1 - pad;
    const near = Math.max(2.5, Math.min(6, 0.06 * r1));
    const g0r: number[] = [], g0a: number[] = [], g1r: number[] = [], g1a: number[] = [];
    for (let i = 0; i < m; i++) {
      const r = rad[i];
      if (r < loR || r > hiR) continue;
      const d0 = wrapPi(ang[i] - a0), d1 = wrapPi(ang[i] - a1);
      const p0 = Math.abs(r * Math.sin(d0)), p1 = Math.abs(r * Math.sin(d1));
      if (p0 <= p1) {
        if (p0 < near && Math.abs(d0) < 0.5) { g0r.push(r); g0a.push(d0); }
      } else if (p1 < near && Math.abs(d1) < 0.5) { g1r.push(r); g1a.push(d1); }
    }
    if (g0r.length >= 3) a0 = seatRay(g0r, g0a, a0);
    if (g1r.length >= 3) a1 = seatRay(g1r, g1a, a1);
    sweep = a1 - a0;
    if (sweep <= 0) sweep += TAU;
    if (sweep < 0.25 || sweep > TAU - 0.15) return null;
    a1 = a0 + sweep;
  }

  return {
    cx, cy, r0, r1, a0, sweep, arcOut,
    c0: Math.cos(a0), s0: Math.sin(a0),
    c1: Math.cos(a1), s1: Math.sin(a1),
  };
}

/**
 * Rotate a ray about the sector centre to the angle whose worst perpendicular
 * offset is smallest. The offsets are `r·sin(Δθ)`, a unimodal function of the
 * rotation, so a ternary search finds the minimum without derivatives.
 */
function seatRay(rs: number[], as: number[], base: number): number {
  // The worst offset is set by a handful of extreme points, so stepping over a
  // long edge finds the same optimum for a fraction of the arithmetic.
  const skip = Math.max(1, Math.ceil(rs.length / 48));
  const f = (dt: number): number => {
    let mx = 0;
    for (let i = 0; i < rs.length; i += skip) {
      const e = Math.abs(rs[i] * Math.sin(as[i] - dt));
      if (e > mx) mx = e;
    }
    return mx;
  };
  let lo = -0.3, hi = 0.3;
  // Ternary search: 22 rounds shrink the bracket by (2/3)^22, to ~2e-4 rad —
  // a twentieth of a pixel at r = 250.
  for (let k = 0; k < 22; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2; else lo = m1;
  }
  return base + (lo + hi) / 2;
}

/**
 * Exact distance from a point to the sector's outline: the arcs plus the two
 * radial edges, whichever is nearest.
 *
 * This runs on every sample of every candidate centre, so it is written without
 * `atan2` or `hypot`. Whether the point falls within the angular span is decided
 * by the sign of two cross products against the cached ray directions — the same
 * answer, a few multiplies instead of an inverse tangent.
 */
function sectorResidual(px: number, py: number, m: Sector): number {
  const dx = px - m.cx, dy = py - m.cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  // Past the first ray, and short of the second. For a reflex span the wedge is
  // the union rather than the intersection of those two half-planes.
  const past0 = m.c0 * dy - m.s0 * dx >= 0;
  const before1 = dx * m.s1 - dy * m.c1 >= 0;
  const inside = m.sweep <= Math.PI ? past0 && before1 : past0 || before1;
  let best = Infinity;
  if (inside) {
    best = Math.abs(r - m.r1);
    if (m.r0 > 0) {
      const inner = Math.abs(r - m.r0);
      if (inner < best) best = inner;
    }
  }
  const d0 = segDist(px, py,
    m.cx + m.r0 * m.c0, m.cy + m.r0 * m.s0, m.cx + m.r1 * m.c0, m.cy + m.r1 * m.s0);
  if (d0 < best) best = d0;
  const d1 = segDist(px, py,
    m.cx + m.r0 * m.c1, m.cy + m.r0 * m.s1, m.cx + m.r1 * m.c1, m.cy + m.r1 * m.s1);
  if (d1 < best) best = d1;
  return best;
}

/**
 * Worst residual over the whole cloud. `bail` stops the scan the moment the
 * candidate is already worse than one we hold — most of a coarse grid is
 * nowhere near a sector and gives up after a handful of samples.
 */
function worst(D: Float64Array, m: Sector, bail: number): number {
  let mx = 0;
  for (let i = 0; i < D.length; i += 2) {
    const e = sectorResidual(D[i], D[i + 1], m);
    if (e > mx) { mx = e; if (mx >= bail) return mx; }
  }
  return mx;
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const vx = x1 - x0, vy = y1 - y0;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - x0) * vx + (py - y0) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (x0 + vx * t), ey = py - (y0 + vy * t);
  return Math.sqrt(ex * ex + ey * ey);
}

/** Wrap an angle difference into (-π, π]. */
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// --- small numeric helpers -------------------------------------------------

interface Bbox { minX: number; minY: number; maxX: number; maxY: number; }

function bbox(pts: Int32Array | number[], n: number): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Signed polygon area (shoelace) over a flat, implicitly-closed x,y array. */
function shoelace(pts: Int32Array | number[], n: number): number {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i << 1], yi = pts[(i << 1) + 1];
    const xj = pts[j << 1], yj = pts[(j << 1) + 1];
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

/** Solve a 3×3 system by Cramer's rule; null if singular. */
function solve3(
  a: number, b: number, c: number,
  d: number, e: number, f: number,
  g: number, h: number, i: number,
  u: number, v: number, w: number,
): [number, number, number] | null {
  const det =
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const dx =
    u * (e * i - f * h) -
    b * (v * i - f * w) +
    c * (v * h - e * w);
  const dy =
    a * (v * i - f * w) -
    u * (d * i - f * g) +
    c * (d * w - v * g);
  const dz =
    a * (e * w - v * h) -
    b * (d * w - v * g) +
    u * (d * h - e * g);
  return [dx / det, dy / det, dz / det];
}

function round(value: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}
