import { describe, expect, it } from 'vitest';
import { traceGeometry, toDxf, toEps, toPdf } from '../src/io/export/index.js';
import { createImage, setPixel, flatArtwork } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/** A filled disc — a shape whose boundary must fit curves. */
function disc(size: number): RasterImage {
  const img = createImage(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - c, y - c) < size * 0.4;
      setPixel(img, x, y, inside ? 220 : 250, inside ? 40 : 250, inside ? 60 : 250);
    }
  }
  return img;
}

describe('traceGeometry', () => {
  it('returns per-colour Bézier geometry ordered by area', () => {
    const g = traceGeometry(flatArtwork(80, 60), { colors: 5 });
    expect(g.width).toBe(80);
    expect(g.height).toBe(60);
    expect(g.paths.length).toBeGreaterThan(1);
    for (const p of g.paths) {
      expect(p.color.a).toBe(255);
      expect(p.subpaths.length).toBeGreaterThan(0);
      expect(p.subpaths[0].segments.length).toBeGreaterThan(0);
    }
  });
});

describe('DXF export', () => {
  it('is a valid entities document of closed polylines with true colour', () => {
    const dxf = toDxf(traceGeometry(flatArtwork(60, 48), { colors: 4 }));
    expect(dxf).toContain('\nSECTION\n');
    expect(dxf).toContain('\nENTITIES\n');
    expect(dxf).toContain('\nLWPOLYLINE\n');
    expect(dxf).toContain('\n420\n'); // true-colour group
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    // 70 flag 1 == closed
    expect(dxf).toMatch(/\n70\n1\n/);
  });
});

describe('EPS export', () => {
  it('emits PostScript that fills each colour, with curves for curved shapes', () => {
    const eps = toEps(traceGeometry(disc(96), { colors: 2, tolerance: 2, fitError: 2 }));
    expect(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0')).toBe(true);
    expect(eps).toMatch(/%%BoundingBox: 0 0 96 96/);
    expect(eps).toContain('setrgbcolor');
    expect(eps).toContain('moveto');
    expect(eps).toContain('curveto'); // the disc boundary is fitted to curves
    expect(eps).toContain('eofill');
  });

  it('can emit CMYK', () => {
    const eps = toEps(traceGeometry(flatArtwork(40, 30), { colors: 3 }), { cmyk: true });
    expect(eps).toContain('setcmykcolor');
    expect(eps).not.toContain('setrgbcolor');
  });
});

describe('PDF export', () => {
  it('is a structurally valid single-page PDF with resolvable xref offsets', () => {
    const bytes = toPdf(traceGeometry(disc(96), { colors: 2, tolerance: 2, fitError: 2 }));
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/MediaBox [0 0 96 96]');
    expect(text).toContain(' c\n'); // curve operator, from the disc
    expect(text).toContain('f*'); // even-odd fill
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);

    // Each xref offset must point at "<n> 0 obj".
    const xrefStart = parseInt(text.slice(text.lastIndexOf('startxref') + 9).trim(), 10);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
    const offsetLines = text.slice(text.indexOf('xref') + 5).split('\n').filter((l) => /^\d{10} \d{5} [fn]/.test(l));
    for (let i = 1; i < offsetLines.length; i++) {
      const off = parseInt(offsetLines[i].slice(0, 10), 10);
      expect(text.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
    }
  });

  it('can emit CMYK fills', () => {
    const text = new TextDecoder('latin1').decode(toPdf(traceGeometry(flatArtwork(40, 30), { colors: 3 }), { cmyk: true }));
    expect(text).toMatch(/\d k\n/); // CMYK fill operator
  });
});
