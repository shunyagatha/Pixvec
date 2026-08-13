import { describe, expect, it } from 'vitest';
import { traceGeometry, toDxf, toEps, toPdf, toGcode } from '../src/io/export/index.js';
import { createImage, setPixel, flatArtwork } from './fixtures.js';
import type { Point, RasterImage } from '../src/types.js';

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

/** A filled axis-aligned ellipse — for the ELLIPSE entity path. */
function ellipseImg(w: number, h: number): RasterImage {
  const img = createImage(w, h);
  const cx = w / 2, cy = h / 2, rx = w * 0.38, ry = h * 0.24;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
      setPixel(img, x, y, inside ? 30 : 250, inside ? 80 : 250, inside ? 200 : 250);
    }
  return img;
}

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

  it('emits a true CIRCLE entity for a disc, not a faceted polyline', () => {
    const dxf = toDxf(traceGeometry(disc(120), { colors: 2 }));
    expect(dxf).toContain('\nCIRCLE\n');
    // Pull the CIRCLE's centre (10/20) and radius (40) and sanity-check them.
    const m = dxf.match(/\nCIRCLE\n[\s\S]*?\n10\n([\d.]+)\n20\n([\d.]+)\n40\n([\d.]+)\n/);
    expect(m).not.toBeNull();
    const [cx, cy, r] = [Number(m![1]), Number(m![2]), Number(m![3])];
    // Contour vertices sit on pixel corners, so the fitted centre is ~60.5.
    expect(Math.abs(cx - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(cy - 60)).toBeLessThanOrEqual(1); // Y-flipped, but symmetric here
    expect(Math.abs(r - 120 * 0.4)).toBeLessThanOrEqual(1);
  });

  it('is smaller than the flattened polyline it replaces', () => {
    const withArc = toDxf(traceGeometry(disc(120), { colors: 2 }));
    const flattened = toDxf(traceGeometry(disc(120), { colors: 2, primitives: false }));
    expect(withArc).toContain('\nCIRCLE\n');
    expect(flattened).not.toContain('\nCIRCLE\n');
    expect(flattened).toContain('\nLWPOLYLINE\n');
    expect(withArc.length).toBeLessThan(flattened.length);
  });

  it('emits an ELLIPSE entity with a correct axis ratio', () => {
    const dxf = toDxf(traceGeometry(ellipseImg(140, 100), { colors: 2 }));
    expect(dxf).toContain('\nELLIPSE\n');
    // ratio (group 40) is minor/major ≈ (h*0.24)/(w*0.38) = 24/53.2 ≈ 0.45
    const m = dxf.match(/\nELLIPSE\n[\s\S]*?\n40\n([\d.]+)\n/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo((100 * 0.24) / (140 * 0.38), 1);
  });

  it('respects primitives:false (raw polylines only)', () => {
    const dxf = toDxf(traceGeometry(disc(120), { colors: 2, primitives: false }));
    expect(dxf).not.toContain('\nCIRCLE\n');
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

describe('G-code export', () => {
  const square: Point[][] = [[{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }]];

  it('emits a valid GRBL-style laser program', () => {
    const g = toGcode(square, { mode: 'laser', height: 30, feed: 800, power: 900 });
    expect(g).toContain('G21'); // mm
    expect(g).toContain('G90'); // absolute
    expect(g).toContain('M3 S900'); // laser on at power
    expect(g).toContain('M5'); // laser off
    expect(g).toMatch(/G1 X\d.* Y\d.* F800/); // cut at feed
    expect(g.trimEnd().endsWith('M2')).toBe(true); // program end
  });

  it('uses Z moves in pen mode and flips Y to bed space', () => {
    const g = toGcode(square, { mode: 'pen', height: 30, penUp: 5, penDown: 0 });
    expect(g).toContain('G0 Z5'); // pen up
    expect(g).toContain('G1 Z0'); // pen down
    // y=10 with height 30 → Y = 20 (origin bottom-left)
    expect(g).toContain('Y20');
    expect(g).not.toContain('M3'); // no laser commands in pen mode
  });

  it('honours units and scale', () => {
    const g = toGcode(square, { units: 'in', scale: 0.1, height: 30 });
    expect(g).toContain('G20'); // inches
    expect(g).toMatch(/X1 /); // 10px × 0.1 = 1
  });
});
