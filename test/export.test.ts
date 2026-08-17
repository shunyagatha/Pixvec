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

/**
 * A pie slice — the shape every chart is made of, and the one `--primitives`
 * names when it promises a real arc for CAD.
 */
function pieSlice(size: number, a0: number, a1: number): RasterImage {
  const img = createImage(size, size);
  const c = size / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += Math.PI * 2;
      const inside = dx * dx + dy * dy <= r * r && a >= a0 && a <= a1;
      setPixel(img, x, y, inside ? 30 : 250, inside ? 80 : 250, inside ? 200 : 250);
    }
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

  /**
   * A sector reached no exporter at all before this. DXF handled circle and
   * ellipse, EPS and PDF only circle, and every detected sector fell through to a
   * flattened polyline — so a chart traced for cutting arrived as chords, while
   * `--primitives` promised "a real arc for CAD" in its own help text. Untrue for
   * exactly the shape it named.
   */
  it('emits real ARC entities for a pie slice, not chords', () => {
    const dxf = toDxf(traceGeometry(pieSlice(160, 0.2, 1.6), { colors: 2 }));
    expect(dxf).toContain('\nARC\n');

    // Presence is not correctness. DXF is Y-up where the raster is Y-down, so the
    // centre's Y is flipped and the sweep direction flips with it.
    const m = dxf.match(/\nARC\n[\s\S]*?\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0\n40\n([\d.]+)\n/);
    expect(m, 'ARC carried no centre/radius').not.toBeNull();
    const [cx, cy, r] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(Math.abs(cx - 80)).toBeLessThanOrEqual(2);
    expect(Math.abs(cy - 80)).toBeLessThanOrEqual(2);
    expect(Math.abs(r - 160 * 0.42)).toBeLessThanOrEqual(2);

    // A slice is closed by its two radial edges.
    expect(dxf).toContain('\nLINE\n');
  });

  it('replaces the sector polyline rather than adding to it', () => {
    const img = pieSlice(160, 0.2, 1.6);
    const withArc = toDxf(traceGeometry(img, { colors: 2 }));
    const flattened = toDxf(traceGeometry(img, { colors: 2, primitives: false }));
    expect(withArc).toContain('\nARC\n');
    expect(flattened).not.toContain('\nARC\n');
    expect(flattened).toContain('\nLWPOLYLINE\n');
    // The whole point for a cutter: one arc move instead of a ring of chords.
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
  it('emits PostScript that fills each colour, with an arc for a recognised circle', () => {
    // This fixture IS a circle, so with primitives on it now leaves as a single
    // `arc` rather than a fitted curve. The curve path is still real and is
    // covered by the case below; splitting the two keeps both branches asserted
    // instead of quietly losing one.
    const eps = toEps(traceGeometry(disc(96), { colors: 2, tolerance: 2, fitError: 2 }));
    expect(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0')).toBe(true);
    expect(eps).toMatch(/%%BoundingBox: 0 0 96 96/);
    expect(eps).toContain('setrgbcolor');
    expect(eps).toContain('moveto');
    expect(eps).toMatch(/ 0 360 arc/);
    expect(eps).toContain('eofill');
  });

  it('still fits curves when primitive recognition is off', () => {
    const eps = toEps(traceGeometry(disc(96), { colors: 2, tolerance: 2, fitError: 2, primitives: false }));
    expect(eps).toContain('curveto'); // the disc boundary is fitted to curves
    expect(eps).not.toMatch(/ 0 360 arc/);
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

/**
 * PDF circles.
 *
 * `traceGeometry` recognises a circle and annotates the subpath. DXF has read
 * that annotation since it landed; PDF ignored it and emitted the fitted
 * polygon, which for a large disc is hundreds of `l` operators standing in for
 * a shape the code already knew was round.
 *
 * PDF has no arc operator, so a recognised circle becomes the four-cubic kappa
 * construction — but only when that is actually shorter. Below roughly ten
 * pixels of radius the polygon wins, and an unguarded change would make
 * ordinary files bigger while claiming to make them smaller.
 */
describe('PDF circles', () => {
  const disc = (size: number, radius: number): RasterImage => {
    const img = createImage(size, size);
    const c = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x - c, y - c) < radius;
        setPixel(img, x, y, inside ? 20 : 255, inside ? 20 : 255, inside ? 20 : 255);
      }
    }
    return img;
  };

  const pdfText = (img: RasterImage, primitives: boolean): string =>
    new TextDecoder('latin1').decode(toPdf(traceGeometry(img, { primitives })));

  it('draws a large circle as four cubics instead of a polygon', () => {
    const text = pdfText(disc(200, 90), true);
    const curves = (text.match(/ c\n/g) ?? []).length;
    const lines = (text.match(/ l\n/g) ?? []).length;
    // Four per circle. The fixture has the disc plus the background's own
    // subpath, so this is "a handful", not "hundreds".
    expect(curves).toBeGreaterThanOrEqual(4);
    expect(lines).toBeLessThan(curves * 2);
  });

  it('is dramatically smaller for a shape that is genuinely round', () => {
    const withArcs = toPdf(traceGeometry(disc(200, 90), { primitives: true })).length;
    const polygon = toPdf(traceGeometry(disc(200, 90), { primitives: false })).length;
    expect(withArcs).toBeLessThan(polygon / 2);
  });

  it('keeps the polygon when the circle is too small for arcs to pay', () => {
    // The guard is the whole reason this change is safe to ship. Without it the
    // four-cubic form is emitted at every size and small primitives — which are
    // the common case in real artwork — get bigger.
    const withArcs = toPdf(traceGeometry(disc(16, 4), { primitives: true })).length;
    const polygon = toPdf(traceGeometry(disc(16, 4), { primitives: false })).length;
    expect(withArcs).toBe(polygon);
  });

  it('never emits the larger of the two forms, at any radius', () => {
    for (const r of [4, 8, 16, 40, 90]) {
      const size = r * 2 + 8;
      const withArcs = toPdf(traceGeometry(disc(size, r), { primitives: true })).length;
      const polygon = toPdf(traceGeometry(disc(size, r), { primitives: false })).length;
      expect(withArcs, `radius ${r} regressed`).toBeLessThanOrEqual(polygon);
    }
  });
});

/**
 * EPS circles.
 *
 * PostScript has an `arc` operator, and `traceGeometry` already knows when a
 * subpath is round. The exporter emitted the fitted polygon anyway — hundreds
 * of `lineto`s describing a shape the language says in one word, and a
 * many-sided polygon where a cutter or an illustrator expected an arc.
 *
 * Verified against Ghostscript 10.07.1 rather than reasoned about: the arc and
 * polygon forms were rasterised at 288-576 dpi and compared, scoring SSIM
 * 0.9981-0.9996 at 99.97%+ pixels exact across every radius the detector fires
 * at. These tests pin the structure that produced that result; they cannot run
 * an interpreter, so what they guard is the operator sequence the render
 * validated.
 */
describe('EPS circles', () => {
  const disc = (size: number, radius: number): RasterImage => {
    const img = createImage(size, size);
    const c = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x - c, y - c) < radius;
        setPixel(img, x, y, inside ? 20 : 255, inside ? 20 : 255, inside ? 20 : 255);
      }
    }
    return img;
  };

  const epsOf = (img: RasterImage, primitives: boolean): string =>
    toEps(traceGeometry(img, { primitives }));

  it('emits a real arc instead of a polygon', () => {
    const eps = epsOf(disc(200, 90), true);
    expect(eps).toMatch(/ 0 360 arc/);
  });

  it('starts the arc at the 0-radian point', () => {
    // Not cosmetic. `arc` appends a line from the current point when the path is
    // non-empty, and a colour's subpaths are routinely rect-then-hole, so the
    // circle is rarely first. Beginning at (cx + r, cy) makes that implicit line
    // zero-length; beginning anywhere else draws a visible spike.
    const eps = epsOf(disc(200, 90), true);
    const line = eps.split('\n').find((l) => / 0 360 arc$/.test(l))!;
    const [cx, cy, r] = line.split(/\s+/).map(Number);
    const moveto = eps.split('\n')[eps.split('\n').indexOf(line) - 1];
    const [mx, my] = moveto.split(/\s+/).map(Number);
    expect(mx).toBeCloseTo(cx + r, 3);
    expect(my).toBeCloseTo(cy, 3);
  });

  it('replaces the linetos rather than adding to them', () => {
    const withArc = epsOf(disc(200, 90), true);
    const polygon = epsOf(disc(200, 90), false);
    const count = (s: string): number => (s.match(/lineto/g) ?? []).length;
    // Only the background rectangle's four corners should remain.
    expect(count(withArc)).toBeLessThan(10);
    expect(count(polygon)).toBeGreaterThan(50);
  });

  it('is dramatically smaller for a shape that is genuinely round', () => {
    expect(epsOf(disc(200, 90), true).length).toBeLessThan(epsOf(disc(200, 90), false).length / 4);
  });

  it('never emits the larger form, at any radius', () => {
    // Below roughly ten pixels the detector does not recognise a circle at all
    // and the polygon is emitted unchanged, so there is nothing to guard — but
    // that is a property worth pinning rather than assuming.
    for (const r of [4, 8, 16, 40, 90]) {
      const size = r * 2 + 8;
      expect(epsOf(disc(size, r), true).length, `radius ${r} regressed`)
        .toBeLessThanOrEqual(epsOf(disc(size, r), false).length);
    }
  });
});
