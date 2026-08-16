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

import { otsuThreshold, bradleyMask } from './threshold.js';
import { luma709 } from '../color.js';
import { SvgDoc } from '../svg/build.js';
import { PathBuilder } from '../svg/path.js';
import { assertRasterImage, type Point, type RasterImage } from '../types.js';

export interface CenterlineOptions {
  /** Binarisation cutoff, 0–255, or `'auto'` (Otsu). Default `'auto'`. */
  threshold?: number | 'auto';
  /** Dark pixels are the line on a light ground. Default true. */
  blackOnWhite?: boolean;
  /**
   * Binarise against each pixel's own neighbourhood (Bradley–Roth) rather than
   * one cutoff for the frame. This is the mode that matters most here: a
   * centerline trace is usually fed a phone photo of paper, where one corner is
   * in shadow and a global cutoff either loses the writing there or floods the
   * lit half with ink.
   */
  adaptive?: boolean;
  /** Neighbourhood side for {@link adaptive}; 0 (default) = an eighth of the shorter side. */
  adaptiveWindow?: number;
  /** Percent below the local mean that counts as ink for {@link adaptive}. Default 15. */
  adaptiveT?: number;
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
  /** Total length of all skeleton polylines, in pixels. */
  length: number;
  /** Foreground (ink) pixel count the skeleton was thinned from. */
  inkPixels: number;
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
  assertRasterImage(image, 'centerlinePolylines');
  return centerlineSkeleton(image, opts).polylines;
}

/** The polylines plus the ink-pixel count they were thinned from. */
function centerlineSkeleton(
  image: RasterImage,
  opts: CenterlineOptions,
): { polylines: Point[][]; inkPixels: number } {
  const { width, height } = image;
  const auto = opts.threshold === undefined || opts.threshold === 'auto';
  const cutoff: number = auto ? otsuThreshold(image) : (opts.threshold as number);
  const blackOnWhite = opts.blackOnWhite ?? true;
  const local = opts.adaptive
    ? bradleyMask(image, opts.adaptiveWindow ?? 0, opts.adaptiveT ?? 15)
    : null;

  // Decide whether the strokes are carried by ALPHA rather than by luminance.
  //
  // A shape exported from a design tool — which is most of what this traces —
  // arrives as opaque ink on a transparent ground, and the ink is whatever
  // colour the artwork is. A luminance split then has nothing to separate:
  // every opaque pixel is the same colour, so Otsu returns a meaningless cutoff
  // and a polarity guess sends the mask either to the whole shape or to nothing.
  // In practice it sent it to nothing — a black icon exported transparent traced
  // to an empty result, and the plugin scored that empty result a perfect SSIM
  // because premultiplied RGB cannot see the alpha it dropped. When alpha
  // carries the shape, every opaque pixel is a stroke and polarity is moot.
  //
  // Detected, not assumed, and only in the default auto/non-adaptive case: an
  // explicit threshold or the adaptive mode is a deliberate luminance decision.
  const opaqueIsInk = auto && !local && alphaCarriesShape(image, cutoff);

  // Binarise into a 1-pixel-padded mask so strokes touching the edge still thin.
  const P = width + 2, Q = height + 2;
  const mask = new Uint8Array(P * Q);
  let inkPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (image.data[o + 3] < 8) continue;
      let fg: boolean;
      if (opaqueIsInk) {
        fg = true;
      } else {
        // round(luma), not the raw float, against a cutoff that was itself binned
        // from round(luma). Comparing the float dropped any ink colour whose
        // luminance landed on the cutoff's fractional edge — e.g. #334155 at
        // 63.47 against a cutoff of 63 — which silently lost about half of all
        // flat fill colours even on an opaque ground.
        const lum = luma709(image.data[o], image.data[o + 1], image.data[o + 2]);
        const dark = local ? local[y * width + x] === 1 : Math.round(lum) <= cutoff;
        fg = blackOnWhite ? dark : !dark;
      }
      if (fg) { mask[(y + 1) * P + (x + 1)] = 1; inkPixels++; }
    }
  }

  guoHallThin(mask, P, Q);
  const raw = walkSkeleton(mask, P, Q);

  const minLength = opts.minLength ?? 3;
  const eps = opts.simplify ?? 1;
  const polylines: Point[][] = [];
  for (const poly of raw) {
    const shifted = poly.map((p) => ({ x: p.x - 1, y: p.y - 1 }));
    const simplified = eps > 0 ? simplify(shifted, eps) : shifted;
    if (simplified.length < 2 || polylineLength(simplified) < minLength) continue;
    polylines.push(simplified);
  }
  return { polylines, inkPixels };
}

/**
 * True when the opaque pixels ARE the shape, so luminance polarity is moot.
 *
 * Two regimes want this. Either the image carries real transparency — a
 * design-tool export is ink on nothing — or its opaque pixels are a single
 * luminance population that Otsu cannot split into ink and paper, such as a
 * tight-cropped fill with no background at all. In both, every opaque pixel is
 * a stroke.
 *
 * The single-population test compares the MEANS of Otsu's two classes rather
 * than their sizes: a genuine ink-on-paper image separates into two clusters
 * whose means sit far apart even when the ink is sparse, whereas one colour
 * splits into two arbitrary halves whose means are almost together. That keeps
 * sparse line art (means ~200 apart) on the luminance path while catching a
 * flat fill (means within a pixel or two).
 */
function alphaCarriesShape(image: RasterImage, cutoff: number): boolean {
  const { data, width, height } = image;
  const n = width * height;
  let transparent = 0;
  let loN = 0, loSum = 0, hiN = 0, hiSum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (data[o + 3] < 8) { transparent++; continue; }
    const l = luma709(data[o], data[o + 1], data[o + 2]);
    if (Math.round(l) <= cutoff) { loN++; loSum += l; } else { hiN++; hiSum += l; }
  }
  if (transparent / n > 0.01) return true;
  const separation = loN > 0 && hiN > 0 ? Math.abs(hiSum / hiN - loSum / loN) : 0;
  return separation < 24;
}

/** Trace an image to single-stroke centreline geometry (SVG). */
export function centerlineTrace(image: RasterImage, opts: CenterlineOptions = {}): CenterlineOutput {
  assertRasterImage(image, 'centerlineTrace');
  const { width, height } = image;
  const { polylines, inkPixels } = centerlineSkeleton(image, opts);

  const doc = new SvgDoc({ width, height, generator: opts.generator, title: opts.title });
  const stroke = opts.stroke ?? '#000';
  const strokeWidth = opts.strokeWidth ?? 1;

  let length = 0;
  for (const poly of polylines) {
    length += polylineLength(poly);
    const path = new PathBuilder(opts.precision ?? 2);
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
    doc.add(
      `<path fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ` +
      `stroke-linecap="round" stroke-linejoin="round" d="${path.toString()}"/>`,
    );
  }

  return { svg: doc.toString(), paths: polylines.length, length, inkPixels };
}

/**
 * Guo–Hall thinning, in place — two parallel sub-iterations repeated until no
 * foreground pixel can be removed, leaving a 1-pixel skeleton.
 *
 * This used to be Zhang–Suen, and Zhang–Suen has a failure mode that made this
 * tracer return *nothing* for the single most common thing a design tool holds:
 * a diagonal filled shape. Once such a shape thins down to a two-pixel-wide
 * diagonal staircase, every pixel along it has exactly two neighbours, so the
 * classic algorithm's only endpoint guard — a neighbour count of at least two —
 * fails to fire, and the line is eaten one pixel from each end per pass until
 * two pixels remain. Traced live, a 2,000-pixel arrow shaft became a 2-pixel
 * dot that the length filter then dropped, so a designer got an empty frame. A
 * rotated rectangle survived only because its rasterised staircase was
 * irregular enough to break the symmetry — which is why the bug hid.
 *
 * Guo & Hall (1989) close it. Their connectivity number C(P) and the guard
 * counts N1/N2 are computed over neighbour *pairs* rather than single pixels, so
 * a two-pixel diagonal is recognised as a line to be thinned across its width
 * rather than a pair of removable ends. Measured on the shape battery, the
 * failing diagonals go from a 2-pixel stub to a full-length connected skeleton,
 * and the cases Zhang–Suen already handled (axis-aligned bars, hairlines, loops,
 * bent strokes) are within a pixel or two of before. Same structure, same cost,
 * same in-place two-pass loop.
 *
 * Neighbour names follow the paper: p2..p9 clockwise from north.
 */
function guoHallThin(m: Uint8Array, P: number, Q: number): void {
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

          // C(P): connectivity over the four diagonal-anchored neighbour pairs.
          // Exactly 1 means removing P keeps the local region connected.
          const c = (p2 === 0 && (p3 === 1 || p4 === 1) ? 1 : 0)
            + (p4 === 0 && (p5 === 1 || p6 === 1) ? 1 : 0)
            + (p6 === 0 && (p7 === 1 || p8 === 1) ? 1 : 0)
            + (p8 === 0 && (p9 === 1 || p2 === 1) ? 1 : 0);
          if (c !== 1) continue;

          // N1/N2: two partitions of the ring into overlapping pairs. min(N1,N2)
          // in [2,3] is the Guo–Hall count condition — the pair-based analogue
          // of Zhang–Suen's 2..6, and the part that spares a 2px diagonal.
          const n1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
          const n2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
          const n = n1 < n2 ? n1 : n2;
          if (n < 2 || n > 3) continue;

          // Directional condition, alternating by sub-iteration.
          const cond = step === 0
            ? ((p6 | p7 | (p9 ^ 1)) & p8)
            : ((p2 | p3 | (p5 ^ 1)) & p4);
          if (cond !== 0) continue;

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

// The 8 neighbours in clockwise ring order (N, NE, E, SE, S, SW, W, NW), for the
// crossing number.
const RING_CW: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

/** Walk a 1-pixel skeleton into open polylines, splitting only at real junctions. */
function walkSkeleton(m: Uint8Array, P: number, Q: number): Point[][] {
  const fg = (x: number, y: number): boolean => m[y * P + x] === 1;
  // The crossing number — 0→1 transitions around the neighbour ring — classifies
  // a skeleton pixel: 1 = endpoint, 2 = pass-through (INCLUDING a right-angle
  // corner, even when the corner forms an 8-clique that inflates the raw degree),
  // ≥3 = a genuine branch. Using this instead of the raw neighbour count is what
  // keeps a bent stroke or a rectangle outline one continuous path.
  const crossing = (x: number, y: number): number => {
    let c = 0;
    for (let k = 0; k < 8; k++) {
      const a = fg(x + RING_CW[k][0], y + RING_CW[k][1]) ? 1 : 0;
      const b = fg(x + RING_CW[(k + 1) % 8][0], y + RING_CW[(k + 1) % 8][1]) ? 1 : 0;
      if (a === 0 && b === 1) c++;
    }
    return c;
  };
  const used = new Set<number>();
  const edgeKey = (ax: number, ay: number, bx: number, by: number): number => {
    const a = ay * P + ax, b = by * P + bx;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return lo * P * Q + hi;
  };
  // A diagonal edge whose orthogonal "shoulder" is also foreground is the
  // hypotenuse of a filled right-angle corner — a shortcut that would let the
  // walk cut across the corner and orphan an arm. Drop it; the orthogonal path
  // through the corner keeps the stroke connected. A genuine 1-px diagonal line
  // has empty shoulders and is kept.
  const allowed = (ax: number, ay: number, bx: number, by: number): boolean => {
    if (Math.abs(ax - bx) === 1 && Math.abs(ay - by) === 1) {
      return !(fg(ax, by) || fg(bx, ay));
    }
    return true;
  };

  const walk = (sx: number, sy: number): Point[] => {
    const pts: Point[] = [{ x: sx, y: sy }];
    let cx = sx, cy = sy;
    for (;;) {
      let next: [number, number, number] | null = null;
      for (const [dx, dy] of NBRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!fg(nx, ny) || !allowed(cx, cy, nx, ny)) continue;
        const key = edgeKey(cx, cy, nx, ny);
        if (used.has(key)) continue;
        next = [nx, ny, key];
        break;
      }
      if (!next) break;
      used.add(next[2]);
      cx = next[0]; cy = next[1];
      pts.push({ x: cx, y: cy });
      if (crossing(cx, cy) !== 2) break; // stop at an endpoint or junction, pass through corners
    }
    return pts;
  };

  const out: Point[][] = [];
  const hasUnusedEdge = (x: number, y: number): boolean => {
    for (const [dx, dy] of NBRS) {
      const nx = x + dx, ny = y + dy;
      if (fg(nx, ny) && allowed(x, y, nx, ny) && !used.has(edgeKey(x, y, nx, ny))) return true;
    }
    return false;
  };

  // Endpoints and junctions first, so lines split cleanly at branch points.
  for (let y = 1; y < Q - 1; y++) {
    for (let x = 1; x < P - 1; x++) {
      if (!fg(x, y)) continue;
      if (crossing(x, y) === 2) continue; // pass-through/corner — walked, not a start
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
