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

/** Physical units a DXF can declare, and their `$INSUNITS` codes. */
export const DXF_UNITS = { none: 0, in: 1, mm: 4, cm: 5, m: 6 } as const;
export type DxfUnit = keyof typeof DXF_UNITS;

export interface DxfOptions {
  /** Samples per Bézier when flattening to polyline vertices. Default 12. */
  curveSteps?: number;
  /**
   * Physical unit to declare in the file header. Default `none`, which is what
   * every DXF this exporter has ever written said — silently.
   */
  units?: DxfUnit;
  /**
   * How many source pixels make one {@link units}. Given this, coordinates are
   * emitted at real physical size instead of in pixels.
   *
   * This is the difference between a drawing and a part. Without it the
   * receiving program has to guess a scale, and the guess is usually wrong —
   * which a maker discovers after the cut, in material.
   */
  pixelsPerUnit?: number;
}

/** Serialise trace geometry to an ASCII DXF document. */
export function toDxf(geometry: TraceGeometry, opts: DxfOptions = {}): string {
  const steps = opts.curveSteps ?? 12;
  const H = geometry.height;
  const units = opts.units ?? 'none';

  // A scale without a unit is the failure this file's own comment warns about,
  // arriving through the door it left open. `pixelsPerUnit` divides every
  // coordinate, but the HEADER that says what the resulting numbers *mean* is
  // written only when `units` is set — so `{ pixelsPerUnit: 12 }` alone emits a
  // drawing spanning 8.00 of something, with no $INSUNITS, and the receiving
  // program guesses. The maker finds out after the cut, in material.
  //
  // The CLI already refuses the mirror case (`--physical-width` without
  // `--units`); the library API had no equivalent.
  if (opts.pixelsPerUnit !== undefined && units === 'none') {
    throw new Error(
      'toDxf: `pixelsPerUnit` scales the drawing but `units` says what the numbers mean, ' +
        'so passing one without the other emits a file whose size the importer has to guess — ' +
        "and it usually guesses wrong. Pass `units: 'mm'` (or 'in', 'cm') alongside it, or drop " +
        '`pixelsPerUnit` to emit unscaled pixel coordinates.',
    );
  }

  // Guard against 0 and negatives as well as undefined: a scale of zero would
  // collapse every coordinate to the origin and emit a valid-looking file
  // containing nothing, which is worse than refusing.
  const per = opts.pixelsPerUnit && opts.pixelsPerUnit > 0 ? opts.pixelsPerUnit : 1;
  const s = (v: number): number => v / per;
  const fy = (y: number): number => s(H - y); // DXF Y is up
  const sx = (x: number): number => s(x);

  const lines: string[] = [];

  // A HEADER declaring $INSUNITS. Without it the file says nothing about scale,
  // and LightBurn, LibreCAD and Fusion each apply their own default — so the
  // same file cuts at three different sizes depending on what opened it.
  if (units !== 'none') {
    lines.push(
      '0', 'SECTION', '2', 'HEADER',
      '9', '$INSUNITS', '70', String(DXF_UNITS[units]),
      // $MEASUREMENT picks the drawing's unit *system* (0 imperial, 1 metric),
      // which some importers consult instead of $INSUNITS.
      '9', '$MEASUREMENT', '70', units === 'in' ? '0' : '1',
      '0', 'ENDSEC',
    );
  }

  lines.push('0', 'SECTION', '2', 'ENTITIES');

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
          '10', n(sx(prim.cx)), '20', n(fy(prim.cy)), '40', n(s(prim.r)),
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
          '10', n(sx(prim.cx)), '20', n(fy(prim.cy)), '30', '0',
          '11', n(s(majorX)), '21', n(s(-majorY)), '31', '0',
          // End parameter at full precision: n()'s 3-place rounding of 2π would
          // leave a sub-pixel hairline gap instead of a closed ellipse.
          '40', n(ratio), '41', '0', '42', String(2 * Math.PI),
        );
        return;
      }

      // A pie slice or donut segment becomes real ARC entities.
      //
      // This is the shape the `--primitives` help text promises "a real arc for
      // CAD" for, and until now no exporter handled `sector` at all — DXF took
      // circles and ellipses, EPS and PDF only circles, and every detected sector
      // fell through to a flattened polyline. So a chart traced for cutting
      // arrived as chords, and the claim was untrue for exactly the shape it named.
      //
      // A sector is up to four entities: the outer arc, the inner arc when it is a
      // donut segment rather than a pie slice, and the two radial edges that close
      // it. DXF angles are degrees, counter-clockwise from +X — and because this
      // writer flips Y (DXF is Y-up, the raster is Y-down), the sweep direction
      // flips with it, so the stored angles are negated and swapped.
      if (prim?.kind === 'sector') {
        const deg = (rad: number): number => (-rad * 180) / Math.PI;
        // Negating swaps which end is "start" for a counter-clockwise arc.
        const start = deg(prim.a1);
        const end = deg(prim.a0);
        const cx = sx(prim.cx);
        const cy = fy(prim.cy);
        const arc = (r: number): void => {
          lines.push(
            '0', 'ARC', '8', layer, '62', aci, '420', String(trueColor),
            '10', n(cx), '20', n(cy), '30', '0',
            '40', n(s(r)),
            '50', n(start), '51', n(end),
          );
        };
        arc(prim.r1);
        if (prim.r0 > 0) arc(prim.r0);
        // The two radial edges. A full-turn sector is a ring or disc and has
        // none — its arcs already close it.
        if (Math.abs(prim.a1 - prim.a0) < Math.PI * 2 - 1e-9) {
          for (const a of [prim.a0, prim.a1]) {
            lines.push(
              '0', 'LINE', '8', layer, '62', aci, '420', String(trueColor),
              '10', n(sx(prim.cx + prim.r0 * Math.cos(a))), '20', n(fy(prim.cy + prim.r0 * Math.sin(a))), '30', '0',
              '11', n(sx(prim.cx + prim.r1 * Math.cos(a))), '21', n(fy(prim.cy + prim.r1 * Math.sin(a))), '31', '0',
            );
          }
        }
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
      for (const v of verts) lines.push('10', n(sx(v.x)), '20', n(fy(v.y)));
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
