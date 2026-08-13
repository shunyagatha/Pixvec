/**
 * DXF export — the CAD/CNC/laser interchange format.
 *
 * Every JS tracer stops at SVG; a DXF is what LightBurn, LibreCAD, Fusion,
 * AutoCAD and every laser/router/vinyl cutter actually import. Curves are
 * flattened to closed `LWPOLYLINE`s (the universally-read entity) with per-colour
 * layers and 24-bit true colour, and the Y axis is flipped to DXF's up-is-up
 * convention. Pure text, so it lives in the portable core.
 */

import type { TraceGeometry } from './geometry.js';
import { flatten, n } from './shared.js';

export interface DxfOptions {
  /** Samples per Bézier when flattening to polyline vertices. Default 12. */
  curveSteps?: number;
}

/** Serialise trace geometry to an ASCII DXF document. */
export function toDxf(geometry: TraceGeometry, opts: DxfOptions = {}): string {
  const steps = opts.curveSteps ?? 12;
  const H = geometry.height;
  const fy = (y: number): number => H - y; // DXF Y is up

  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];

  for (const path of geometry.paths) {
    const layer = `c_${hex(path.color.r, path.color.g, path.color.b)}`;
    const trueColor = (path.color.r << 16) | (path.color.g << 8) | path.color.b;
    const aci = String(acadColor(path.color.r, path.color.g, path.color.b));
    path.subpaths.forEach((sub, i) => {
      const prim = path.primitives?.[i];

      // A recognised circle or ellipse becomes a true CAD entity — one arc the
      // machine cuts in a single move, not a ring of short chords. Rectangles
      // fall through: a closed four-vertex LWPOLYLINE is already exact.
      if (prim?.kind === 'circle') {
        lines.push(
          '0', 'CIRCLE', '8', layer, '62', aci, '420', String(trueColor),
          '10', n(prim.cx), '20', n(fy(prim.cy)), '40', n(prim.r),
        );
        return;
      }
      if (prim?.kind === 'ellipse') {
        // Major-axis endpoint relative to centre, then minor/major ratio. The
        // Y flip negates the vector's Y (axis-aligned, so it is 0 or ±ry).
        const majorX = prim.rx >= prim.ry ? prim.rx : 0;
        const majorY = prim.rx >= prim.ry ? 0 : prim.ry;
        const ratio = prim.rx >= prim.ry ? prim.ry / prim.rx : prim.rx / prim.ry;
        lines.push(
          '0', 'ELLIPSE', '8', layer, '62', aci, '420', String(trueColor),
          '10', n(prim.cx), '20', n(fy(prim.cy)), '30', '0',
          '11', n(majorX), '21', n(-majorY), '31', '0',
          // End parameter at full precision: n()'s 3-place rounding of 2π would
          // leave a sub-pixel hairline gap instead of a closed ellipse.
          '40', n(ratio), '41', '0', '42', String(2 * Math.PI),
        );
        return;
      }

      const verts = flatten(sub, steps);
      // Drop a duplicated closing vertex; DXF closes via flag 70=1.
      if (verts.length > 1) {
        const a = verts[0], b = verts[verts.length - 1];
        if (a.x === b.x && a.y === b.y) verts.pop();
      }
      if (verts.length < 2) return;
      lines.push(
        '0', 'LWPOLYLINE', '8', layer, '62', aci,
        '420', String(trueColor), '90', String(verts.length), '70', '1',
      );
      for (const v of verts) lines.push('10', n(v.x), '20', n(fy(v.y)));
    });
  }

  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n') + '\n';
}

function hex(r: number, g: number, b: number): string {
  return [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Nearest classic AutoCAD colour index (a fallback beside the true-colour 420). */
function acadColor(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 20) return max > 200 ? 7 : max < 60 ? 250 : 8; // white/black/grey
  if (r >= g && r >= b) return g > b ? (r - g < 40 ? 2 : 1) : 1;  // red/yellow
  if (g >= r && g >= b) return 3;                                  // green
  return b > r ? 5 : 6;                                            // blue/magenta
}
