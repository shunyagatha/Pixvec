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
import { rgbToCmyk, n } from './shared.js';

export interface PdfOptions {
  /** Emit CMYK colours (print) instead of RGB. */
  cmyk?: boolean;
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
    for (const sub of path.subpaths) {
      ops.push(`${n(sub.start.x)} ${n(fy(sub.start.y))} m`);
      for (const seg of sub.segments) {
        ops.push(seg.kind === 'line'
          ? `${n(seg.x)} ${n(fy(seg.y))} l`
          : `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} c`);
      }
      ops.push('h');
    }
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
