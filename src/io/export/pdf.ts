/**
 * PDF export — print-ready vector output, optionally CMYK.
 *
 * A minimal but valid PDF: one page whose content stream draws the fitted paths
 * with native cubic operators (`m`/`l`/`c` — see the note in eps.ts about when
 * `c` is actually emitted), even-odd fill (`f*`) to preserve
 * holes, Y flipped to PDF's up-is-up page space, and RGB (`rg`) or CMYK (`k`)
 * colour. CMYK is the differentiator — free/JS tools collapse everything to sRGB,
 * which a commercial printer cannot use. Pure text assembled to bytes.
 */

import type { TraceGeometry } from './geometry.js';
import { rgbToCmyk, n, elevateQuad } from './shared.js';

export interface PdfOptions {
  /** Emit CMYK colours (print) instead of RGB. */
  cmyk?: boolean;
}

/**
 * The circle constant for cubic Bézier approximation.
 *
 * Control points at `r * KAPPA` from each quadrant endpoint put the curve within
 * about 0.02% of the true radius — below a rounding step at any size these
 * exports are used at, and the construction every drawing program uses because
 * PDF, unlike PostScript, has no arc operator to fall back on.
 */
const KAPPA = 0.5522847498307936;

/** The four cubics that draw a circle, in PDF page space. */
function circleOps(
  prim: { cx: number; cy: number; r: number },
  fy: (y: number) => number,
): string[] {
  const { cx, cy, r } = prim;
  const k = r * KAPPA;
  const x = (v: number): string => n(v);
  const y = (v: number): string => n(fy(v));
  return [
    `${x(cx + r)} ${y(cy)} m`,
    `${x(cx + r)} ${y(cy + k)} ${x(cx + k)} ${y(cy + r)} ${x(cx)} ${y(cy + r)} c`,
    `${x(cx - k)} ${y(cy + r)} ${x(cx - r)} ${y(cy + k)} ${x(cx - r)} ${y(cy)} c`,
    `${x(cx - r)} ${y(cy - k)} ${x(cx - k)} ${y(cy - r)} ${x(cx)} ${y(cy - r)} c`,
    `${x(cx + k)} ${y(cy - r)} ${x(cx + r)} ${y(cy - k)} ${x(cx + r)} ${y(cy)} c`,
    'h',
  ];
}

/** Whichever serialisation is fewer bytes on the wire. */
function shorter(a: string[], b: string[]): string[] {
  return b.join('\n').length < a.join('\n').length ? b : a;
}

/** Serialise trace geometry to a single-page PDF document. */
export function toPdf(geometry: TraceGeometry, opts: PdfOptions = {}): Uint8Array {
  const w = Math.ceil(geometry.width);
  const h = Math.ceil(geometry.height);
  const fy = (y: number): number => geometry.height - y;

  const ops: string[] = [];
  for (const path of geometry.paths) {
    const { r, g, b } = path.color;
    ops.push(opts.cmyk
      ? `${rgbToCmyk(r, g, b).map((v) => n(v)).join(' ')} k`
      : `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} rg`);
    path.subpaths.forEach((sub, i) => {
      const flattened: string[] = [`${n(sub.start.x)} ${n(fy(sub.start.y))} m`];
      // PDF's `v` takes the current point as its first control point, which is
      // NOT what a quadratic means; there is no quadratic operator at all. So a
      // `q` segment is elevated to the cubic that draws the identical curve,
      // which needs the segment's start point tracked.
      let cur = { x: sub.start.x, y: sub.start.y };
      for (const seg of sub.segments) {
        if (seg.kind === 'line') {
          flattened.push(`${n(seg.x)} ${n(fy(seg.y))} l`);
        } else if (seg.kind === 'quad') {
          const { c1, c2 } = elevateQuad(cur, { x: seg.x1, y: seg.y1 }, { x: seg.x, y: seg.y });
          flattened.push(
            `${n(c1.x)} ${n(fy(c1.y))} ${n(c2.x)} ${n(fy(c2.y))} ${n(seg.x)} ${n(fy(seg.y))} c`,
          );
        } else {
          flattened.push(
            `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} c`,
          );
        }
        cur = { x: seg.x, y: seg.y };
      }
      flattened.push('h');

      // A recognised circle can be drawn as four cubics instead of the polygon
      // the fitter produced. PDF has no arc operator at all, so this is the
      // standard kappa construction — the control-point offset that makes a
      // cubic match a quarter circle to within 0.02% of the radius.
      //
      // Guarded by length rather than by a radius rule, because the polygon is
      // genuinely smaller below roughly twenty segments and most recognised
      // primitives in real artwork are small. Serialising both and keeping the
      // shorter is exact, cheap, and needs no threshold anyone has to justify —
      // and without it this change makes ordinary files bigger, not smaller.
      const prim = path.primitives?.[i];
      const chosen = prim?.kind === 'circle' ? shorter(flattened, circleOps(prim, fy)) : flattened;
      ops.push(...chosen);
    });
    ops.push('f*');
  }
  const content = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}
