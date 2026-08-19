/**
 * EPS / PostScript export — the print/prepress interchange format.
 *
 * PostScript has native cubic curves, so any fitted Bézier maps straight to
 * `curveto` with no flattening. Note that at the default `tolerance` the fitter
 * currently produces none — every segment arrives as a line — so a file written
 * without an explicit `tolerance`/`fitError` is polygons. Raising them fires the
 * fitter and, measured on a 96px disc, cuts 4754 bytes to 900. Y is flipped to PostScript's up-is-up page
 * space, colours are emitted as `setrgbcolor` (or CMYK `setcmykcolor` for
 * prepress), and each colour's contours fill with the even-odd rule to match the
 * SVG output's holes. Pure text.
 */

import type { TraceGeometry } from './geometry.js';
import { rgbToCmyk, n, elevateQuad } from './shared.js';

export interface EpsOptions {
  /** Emit CMYK colours (prepress) instead of RGB. */
  cmyk?: boolean;
}

/** Serialise trace geometry to an Encapsulated PostScript document. */
export function toEps(geometry: TraceGeometry, opts: EpsOptions = {}): string {
  const { width, height } = geometry;
  const fy = (y: number): number => height - y;

  const out: string[] = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}`,
    '%%Creator: vecline',
    '%%EndComments',
  ];

  for (const path of geometry.paths) {
    const { r, g, b } = path.color;
    out.push(opts.cmyk
      ? `${rgbToCmyk(r, g, b).map((v) => n(v)).join(' ')} setcmykcolor`
      : `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} setrgbcolor`);
    out.push('newpath');
    path.subpaths.forEach((sub, i) => {
      // A recognised circle is drawn with the operator PostScript has for it.
      // `traceGeometry` already knows the subpath is round; emitting the fitted
      // polygon instead spends hundreds of `lineto`s describing a shape the
      // language can express in one word, and hands a cutter or an illustrator
      // a many-sided polygon where an arc was meant.
      const prim = path.primitives?.[i];
      if (prim?.kind === 'circle') {
        // The `moveto` is not optional. `arc` appends a line from the current
        // point when the path is non-empty, and a colour's subpath list is
        // routinely rect-then-hole, so the hole is rarely first. Starting at the
        // 0-radian point makes that implicit line zero-length by construction.
        out.push(`${n(prim.cx + prim.r)} ${n(fy(prim.cy))} moveto`);
        // Angles run counter-clockwise in PostScript's up-is-up space, which is
        // the mirror of the screen-space sweep — irrelevant here: a full circle
        // covers the same set either way, and `eofill` below ignores winding, so
        // `arcn` buys nothing.
        out.push(`${n(prim.cx)} ${n(fy(prim.cy))} ${n(prim.r)} 0 360 arc`);
        out.push('closepath');
        return;
      }

      out.push(`${n(sub.start.x)} ${n(fy(sub.start.y))} moveto`);
      // The current point, tracked because PostScript has no quadratic operator
      // and elevating one to a cubic needs the segment's start.
      let cur = { x: sub.start.x, y: sub.start.y };
      for (const seg of sub.segments) {
        if (seg.kind === 'line') {
          out.push(`${n(seg.x)} ${n(fy(seg.y))} lineto`);
        } else if (seg.kind === 'quad') {
          const { c1, c2 } = elevateQuad(cur, { x: seg.x1, y: seg.y1 }, { x: seg.x, y: seg.y });
          out.push(
            `${n(c1.x)} ${n(fy(c1.y))} ${n(c2.x)} ${n(fy(c2.y))} ${n(seg.x)} ${n(fy(seg.y))} curveto`,
          );
        } else {
          out.push(
            `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} curveto`,
          );
        }
        cur = { x: seg.x, y: seg.y };
      }
      out.push('closepath');
    });
    out.push('eofill');
  }

  out.push('%%EOF');
  return out.join('\n') + '\n';
}
