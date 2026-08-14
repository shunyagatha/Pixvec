/**
 * EPS / PostScript export — the print/prepress interchange format.
 *
 * PostScript has native cubic curves, so the fitted Béziers map straight to
 * `curveto` with no flattening. Y is flipped to PostScript's up-is-up page
 * space, colours are emitted as `setrgbcolor` (or CMYK `setcmykcolor` for
 * prepress), and each colour's contours fill with the even-odd rule to match the
 * SVG output's holes. Pure text.
 */

import type { TraceGeometry } from './geometry.js';
import { rgbToCmyk, n } from './shared.js';

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
    for (const sub of path.subpaths) {
      out.push(`${n(sub.start.x)} ${n(fy(sub.start.y))} moveto`);
      let cx = sub.start.x, cy = sub.start.y;
      for (const seg of sub.segments) {
        if (seg.kind === 'line') {
          out.push(`${n(seg.x)} ${n(fy(seg.y))} lineto`);
          cx = seg.x; cy = seg.y;
        } else {
          out.push(
            `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} curveto`,
          );
          cx = seg.x; cy = seg.y;
        }
      }
      void cx; void cy;
      out.push('closepath');
    }
    out.push('eofill');
  }

  out.push('%%EOF');
  return out.join('\n') + '\n';
}
