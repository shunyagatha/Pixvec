/**
 * Centerline (single-stroke) tracing.
 *
 * Outline tracing draws *both* edges of every stroke, so a pen, laser or cutting
 * tool runs each line twice and the geometry doubles. For line art, signatures,
 * schematics and UI strokes destined for a plotter/laser/CNC/vinyl cutter, what
 * you want is the *medial axis*: one open path down the middle of each stroke.
 *
 * This is the single most-requested tracer feature that neither potrace nor
 * vtracer ships. The pipeline is: threshold → **Zhang–Suen thinning** to a
 * one-pixel skeleton → walk the skeleton graph into open polylines → simplify
 * (Douglas–Peucker) → emit as stroked `<path fill="none">`. Pure TypeScript.
 */

import { otsuThreshold } from './threshold.js';
import { luma709 } from '../color.js';
import { SvgDoc } from '../svg/build.js';
import { PathBuilder } from '../svg/path.js';
import type { Point, RasterImage } from '../types.js';

export interface CenterlineOptions {
  /** Binarisation cutoff, 0–255, or `'auto'` (Otsu). Default `'auto'`. */
  threshold?: number | 'auto';
  /** Dark pixels are the line on a light ground. Default true. */
  blackOnWhite?: boolean;
  /** Stroke width in pixels. Default 1. */
  strokeWidth?: number;
  /** Stroke colour (any CSS colour). Default `#000`. */
  stroke?: string;
  /** Douglas–Peucker simplification tolerance in pixels. Default 1. */
  simplify?: number;
  /** Drop skeleton paths shorter than this many pixels. Default 3. */
  minLength?: number;
  /** Decimal places in coordinates. Default 2. */
  precision?: number;
  title?: string;
  generator?: string;
}

export interface CenterlineOutput {
  svg: string;
  /** Number of open stroke paths emitted. */
  paths: number;
}

const NBRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

/**
 * Extract the medial-axis polylines of an image — the raw skeleton strokes,
 * simplified and in image coordinates. This is what centreline SVG and G-code
 * toolpaths are both built from.
 */
export function centerlinePolylines(image: RasterImage, opts: CenterlineOptions = {}): Point[][] {
  const { width, height } = image;
  const cutoff = opts.threshold === undefined || opts.threshold === 'auto'
    ? otsuThreshold(image)
    : opts.threshold;
  const blackOnWhite = opts.blackOnWhite ?? true;

  // Binarise into a 1-pixel-padded mask so strokes touching the edge still thin.
  const P = width + 2, Q = height + 2;
  const mask = new Uint8Array(P * Q);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (image.data[o + 3] < 8) continue;
      const lum = luma709(image.data[o], image.data[o + 1], image.data[o + 2]);
      const fg = blackOnWhite ? lum <= cutoff : lum > cutoff;
      if (fg) mask[(y + 1) * P + (x + 1)] = 1;
    }
  }

  zhangSuenThin(mask, P, Q);
  const raw = walkSkeleton(mask, P, Q);

  const minLength = opts.minLength ?? 3;
  const eps = opts.simplify ?? 1;
  const out: Point[][] = [];
  for (const poly of raw) {
    const shifted = poly.map((p) => ({ x: p.x - 1, y: p.y - 1 }));
    const simplified = eps > 0 ? simplify(shifted, eps) : shifted;
    if (simplified.length < 2 || polylineLength(simplified) < minLength) continue;
    out.push(simplified);
  }
  return out;
}

/** Trace an image to single-stroke centreline geometry (SVG). */
export function centerlineTrace(image: RasterImage, opts: CenterlineOptions = {}): CenterlineOutput {
  const { width, height } = image;
  const polylines = centerlinePolylines(image, opts);

  const doc = new SvgDoc({ width, height, generator: opts.generator, title: opts.title });
  const stroke = opts.stroke ?? '#000';
  const strokeWidth = opts.strokeWidth ?? 1;

  for (const poly of polylines) {
    const path = new PathBuilder(opts.precision ?? 2);
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
    doc.add(
      `<path fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ` +
      `stroke-linecap="round" stroke-linejoin="round" d="${path.toString()}"/>`,
    );
  }

  return { svg: doc.toString(), paths: polylines.length };
}

/**
 * Zhang–Suen thinning, in place. Repeats two sub-iterations until no foreground
 * pixel can be removed without breaking connectivity, leaving a 1-pixel skeleton.
 */
function zhangSuenThin(m: Uint8Array, P: number, Q: number): void {
  let changed = true;
  const del: number[] = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < Q - 1; y++) {
        for (let x = 1; x < P - 1; x++) {
          const i = y * P + x;
          if (!m[i]) continue;
          const p2 = m[i - P], p3 = m[i - P + 1], p4 = m[i + 1], p5 = m[i + P + 1];
          const p6 = m[i + P], p7 = m[i + P - 1], p8 = m[i - 1], p9 = m[i - P - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          // Count 0→1 transitions around the ring.
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          del.push(i);
        }
      }
      if (del.length > 0) {
        changed = true;
        for (const i of del) m[i] = 0;
      }
    }
  }
}

/** Walk a 1-pixel skeleton into open polylines, splitting at junctions. */
function walkSkeleton(m: Uint8Array, P: number, Q: number): Point[][] {
  const fg = (x: number, y: number): boolean => m[y * P + x] === 1;
  const degree = (x: number, y: number): number => {
    let d = 0;
    for (const [dx, dy] of NBRS) if (fg(x + dx, y + dy)) d++;
    return d;
  };
  const used = new Set<number>();
  const edgeKey = (ax: number, ay: number, bx: number, by: number): number => {
    const a = ay * P + ax, b = by * P + bx;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return lo * P * Q + hi;
  };

  const walk = (sx: number, sy: number): Point[] => {
    const pts: Point[] = [{ x: sx, y: sy }];
    let cx = sx, cy = sy;
    for (;;) {
      let next: [number, number, number] | null = null;
      for (const [dx, dy] of NBRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!fg(nx, ny)) continue;
        const key = edgeKey(cx, cy, nx, ny);
        if (used.has(key)) continue;
        next = [nx, ny, key];
        break;
      }
      if (!next) break;
      used.add(next[2]);
      cx = next[0]; cy = next[1];
      pts.push({ x: cx, y: cy });
      if (degree(cx, cy) !== 2) break; // stop at an endpoint or junction
    }
    return pts;
  };

  const out: Point[][] = [];
  const hasUnusedEdge = (x: number, y: number): boolean => {
    for (const [dx, dy] of NBRS) {
      const nx = x + dx, ny = y + dy;
      if (fg(nx, ny) && !used.has(edgeKey(x, y, nx, ny))) return true;
    }
    return false;
  };

  // Endpoints and junctions first, so lines split cleanly at branch points.
  for (let y = 1; y < Q - 1; y++) {
    for (let x = 1; x < P - 1; x++) {
      if (!fg(x, y)) continue;
      const d = degree(x, y);
      if (d === 2) continue;
      while (hasUnusedEdge(x, y)) {
        const poly = walk(x, y);
        if (poly.length >= 2) out.push(poly);
      }
    }
  }
  // Remaining edges belong to pure loops (every pixel degree 2).
  for (let y = 1; y < Q - 1; y++) {
    for (let x = 1; x < P - 1; x++) {
      if (fg(x, y) && hasUnusedEdge(x, y)) {
        const poly = walk(x, y);
        if (poly.length >= 2) out.push(poly);
      }
    }
  }
  return out;
}

/** Douglas–Peucker simplification of an open polyline. */
function simplify(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1, worstDist = eps;
    const ax = pts[first].x, ay = pts[first].y;
    const bx = pts[last].x, by = pts[last].y;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    for (let i = first + 1; i < last; i++) {
      const dist = len === 0
        ? Math.hypot(pts[i].x - ax, pts[i].y - ay)
        : Math.abs(dy * pts[i].x - dx * pts[i].y + bx * ay - by * ax) / len;
      if (dist > worstDist) { worstDist = dist; worst = i; }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function polylineLength(pts: Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}
