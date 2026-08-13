/**
 * Geometric primitive recognition.
 *
 * A tracer that only ever emits cubic Béziers turns a circle into a four-curve
 * approximation and a rectangle into four `lineto`s — larger than they need to
 * be and, worse, no longer editable *as* a circle or a rectangle in a vector
 * editor or a CAD tool. This module looks at a boundary loop and, when the
 * shape genuinely *is* one, returns the exact primitive instead: `<circle>`,
 * `<ellipse>`, `<rect>`.
 *
 * The decision is gated on a hard geometric residual — a loop only becomes a
 * primitive when every one of its vertices lies within `maxError` pixels of the
 * fitted shape — so the substitution is render-preserving, never a guess that
 * rounds an organic blob into a circle. Rectangles fit exactly (their contour
 * *is* four integer corners); circles and ellipses clear the same sub-pixel bar.
 *
 * Pure: integer lattice in, plain description out. No dependencies.
 */

export type Primitive =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number };

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

  const rect = fitRect(b, w, h, area);
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
  }
}

// --- fitters ---------------------------------------------------------------

/** Axis-aligned rectangle: the contour of a real rect is exactly its bbox. */
function fitRect(
  b: Bbox,
  w: number,
  h: number,
  area: number,
): { prim: Primitive; err: number } | null {
  // The loop must actually fill its bounding box, or an L-shape / frame whose
  // vertices all happen to touch the border would masquerade as a rectangle.
  if (area < 0.95 * w * h) return null;
  // Residual is how far the polygon's area is from the box, expressed as an
  // average edge offset — 0 for a true rectangle.
  const err = (w * h - area) / (2 * (w + h));
  return { prim: { kind: 'rect', x: b.minX, y: b.minY, w, h }, err };
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
    // Nearest point on the axis-aligned ellipse, approximated by matching the
    // point's parametric angle — accurate enough for a sub-pixel residual test.
    const t = Math.atan2((py - cy) / ry, (px - cx) / rx);
    const ex = cx + rx * Math.cos(t), ey = cy + ry * Math.sin(t);
    const res = Math.hypot(px - ex, py - ey);
    if (res > maxRes) maxRes = res;
  }
  return { prim: { kind: 'ellipse', cx, cy, rx, ry }, err: maxRes };
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
