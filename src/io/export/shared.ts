/** Helpers shared by the DXF/EPS/PDF writers. */

import type { FittedPath } from '../../vectorize/fit.js';

export interface Pt { x: number; y: number; }

/** Sample a cubic Bézier into `steps` line segments (endpoints inclusive of p3). */
export function sampleCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    out.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    });
  }
  return out;
}

/** Flatten a fitted path to a closed polyline (curves sampled), for formats without curves. */
export function flatten(path: FittedPath, steps = 10): Pt[] {
  const pts: Pt[] = [{ x: path.start.x, y: path.start.y }];
  let cur: Pt = { x: path.start.x, y: path.start.y };
  for (const seg of path.segments) {
    if (seg.kind === 'line') {
      cur = { x: seg.x, y: seg.y };
      pts.push(cur);
    } else {
      const sampled = sampleCubic(cur, { x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, { x: seg.x, y: seg.y }, steps);
      for (const p of sampled) pts.push(p);
      cur = { x: seg.x, y: seg.y };
    }
  }
  return pts;
}

/** Naive RGB→CMYK (0–1), for print exporters that ask for it. */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const k = 1 - Math.max(rf, gf, bf);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - rf - k) / (1 - k), (1 - gf - k) / (1 - k), (1 - bf - k) / (1 - k), k];
}

/** Trim a float to a compact fixed-precision string. */
export function n(v: number, places = 3): string {
  return (Math.round(v * 10 ** places) / 10 ** places).toString();
}
