import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../src/types.js';
import { detectPrimitive } from '../src/vectorize/primitives.js';
import { trace } from '../src/vectorize/trace.js';
import { quantize, quantizeAlpha, NearestColor } from '../src/vectorize/quantize.js';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents } from '../src/vectorize/contour.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { createImage, setPixel } from './fixtures.js';

const FG: [number, number, number] = [40, 90, 200];

function blank(size: number): RasterImage {
  const img = createImage(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = 255;
  }
  return img;
}

function disc(size: number, cx: number, cy: number, r: number): RasterImage {
  const img = blank(size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) setPixel(img, x, y, ...FG);
  return img;
}

function rect(size: number, x0: number, y0: number, w: number, h: number): RasterImage {
  const img = blank(size);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) setPixel(img, x, y, ...FG);
  return img;
}

function ellipse(size: number, cx: number, cy: number, rx: number, ry: number): RasterImage {
  const img = blank(size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) setPixel(img, x, y, ...FG);
  return img;
}

function roundRect(size: number, x0: number, y0: number, w: number, h: number, r: number): RasterImage {
  const img = blank(size);
  const ix0 = x0 + r, ix1 = x0 + w - r, iy0 = y0 + r, iy1 = y0 + h - r;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (cx < x0 || cx > x0 + w || cy < y0 || cy > y0 + h) continue;
      const qx = Math.max(ix0 - cx, cx - ix1, 0);
      const qy = Math.max(iy0 - cy, cy - iy1, 0);
      if (Math.hypot(qx, qy) <= r) setPixel(img, x, y, ...FG);
    }
  return img;
}

const traceOpts = { colors: 2, primitives: true } as const;

const PIE: [number, number, number][] = [
  [214, 69, 65], [32, 96, 160], [40, 150, 110], [235, 180, 40],
];

/**
 * A pie or donut chart. `cuts` are the upper angular bounds of each slice, and
 * `r0 > 0` makes it a ring. `legend` paints a swatch of every slice colour off
 * to the side, which is what a real chart looks like and what stops each colour
 * from being a single isolated region.
 */
function chart(
  size: number,
  r0: number,
  r1: number,
  cuts: number[],
  legend = false,
): RasterImage {
  const img = blank(size);
  const c = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hit = -1;
      // Swatches sized like a real chart legend — 18px squares, well clear of
      // the despeckle threshold. An earlier 10x8 swatch was small enough that
      // adaptive despeckling absorbed it, which is a fixture flaw, not a sector
      // bug: a legend nobody could read is not the case this test is about.
      if (legend && x > size - 26 && x < size - 8 && y > 8 && y < 8 + 22 * cuts.length) {
        hit = Math.floor((y - 8) / 22);
      } else {
        const d = Math.hypot(x - c, y - c);
        if (d <= r1 && d >= r0) {
          let a = Math.atan2(y - c, x - c);
          if (a < 0) a += 2 * Math.PI;
          hit = cuts.findIndex((t) => a <= t);
          if (hit < 0) hit = cuts.length - 1;
        }
      }
      if (hit >= 0) setPixel(img, x, y, ...PIE[hit % PIE.length]);
    }
  return img;
}

/** `<path>` elements whose `d` is real arc commands, not a flattened polygon. */
const arcPaths = (svg: string): number => (svg.match(/<path d="M[^"]*A[^"]*"/g) ?? []).length;

describe('detectPrimitive (unit)', () => {
  it('reads a rectangle contour exactly', () => {
    // A clean axis-aligned box: 4 integer corners.
    const p = detectPrimitive(new Int32Array([2, 2, 10, 2, 10, 8, 2, 8]), { maxError: 0.5 });
    expect(p?.kind).toBe('rect');
    if (p?.kind === 'rect') {
      expect([p.x, p.y, p.w, p.h]).toEqual([2, 2, 8, 6]);
    }
  });

  it('rejects an L-shape that only touches the bounding box', () => {
    // Fills half the box — must not masquerade as a rectangle.
    const L = new Int32Array([0, 0, 4, 0, 4, 8, 12, 8, 12, 12, 0, 12]);
    const p = detectPrimitive(L, { maxError: 1 });
    expect(p).toBeNull();
  });

  it('returns null for too few vertices', () => {
    expect(detectPrimitive(new Int32Array([0, 0, 1, 0, 1, 1]), {})).toBeNull();
  });

  it('rejects a slotted rectangle whose notch barely dents the area', () => {
    // A 100×100 square with a 2-wide, 60-deep slot cut into the top edge:
    // <5% of the bbox area is missing, so an area-only gate would wave it
    // through, but a boundary vertex sits 60px off the rectangle outline.
    const slotted = new Int32Array([
      0, 0, 49, 0, 49, 60, 51, 60, 51, 0, 100, 0, 100, 100, 0, 100,
    ]);
    expect(detectPrimitive(slotted, { maxError: 1 })).toBeNull();
  });
});

describe('trace --primitives', () => {
  it('emits a <circle> for a disc that traces the source as faithfully as the path', async () => {
    const source = disc(80, 40, 40, 30);
    const withPrim = trace(source, traceOpts);
    const withPath = trace(source, { colors: 2 });

    expect(withPrim.svg).toContain('<circle');
    expect(withPath.svg).not.toContain('<circle');

    // Measure both against the ground-truth raster, not against each other: the
    // <circle> must be a faithful trace of the disc, and no meaningfully worse
    // than the Bézier outline it replaces.
    const primR = await rasterizeSvg(withPrim.svg, { width: 80 });
    const pathR = await rasterizeSvg(withPath.svg, { width: 80 });
    const primSsim = compareImages(source, primR.image).ssim;
    const pathSsim = compareImages(source, pathR.image).ssim;
    // The circle is a faithful trace (most of the residual is boundary
    // antialiasing of a hard-edged raster), and stays within a small margin of
    // the Bézier outline — which can be pixel-perfect on a synthetic disc.
    expect(primSsim).toBeGreaterThan(0.98);
    expect(primSsim).toBeGreaterThan(pathSsim - 0.02);
  });

  it('emits a <rect> for a filled rectangle', async () => {
    const img = rect(80, 15, 20, 50, 35);
    const out = trace(img, traceOpts);
    expect(out.svg).toContain('<rect');
    // width/height carried through (the fill rect, not the canvas frame).
    expect(out.svg).toMatch(/<rect x="15" y="20" width="50" height="35"/);

    const ref = await rasterizeSvg(trace(img, { colors: 2 }).svg, { width: 80 });
    const got = await rasterizeSvg(out.svg, { width: 80 });
    expect(compareImages(ref.image, got.image).ssim).toBeGreaterThan(0.99);
  });

  it('emits an <ellipse> for a non-circular ellipse', async () => {
    const img = ellipse(90, 45, 45, 38, 22);
    const out = trace(img, traceOpts);
    expect(out.svg).toContain('<ellipse');

    const ref = await rasterizeSvg(trace(img, { colors: 2 }).svg, { width: 90 });
    const got = await rasterizeSvg(out.svg, { width: 90 });
    expect(compareImages(ref.image, got.image).ssim).toBeGreaterThan(0.985);
  });

  it('emits a rounded <rect rx> for a rounded rectangle', async () => {
    const img = roundRect(100, 15, 25, 70, 50, 14);
    const out = trace(img, traceOpts);
    expect(out.svg).toMatch(/<rect [^>]*rx="1[0-9](\.\d+)?"/); // radius ≈ 14
    expect(out.svg).toContain('<rect');

    const ref = await rasterizeSvg(trace(img, { colors: 2 }).svg, { width: 100 });
    const got = await rasterizeSvg(out.svg, { width: 100 });
    expect(compareImages(ref.image, got.image).ssim).toBeGreaterThan(0.98);
  });

  it('keeps a sharp rectangle sharp (no spurious rx)', () => {
    const img = rect(80, 15, 20, 50, 35);
    const out = trace(img, traceOpts);
    expect(out.svg).toContain('<rect');
    expect(out.svg).not.toContain('rx=');
  });

  it('does not mistake a disc for a rounded rect', () => {
    const out = trace(disc(80, 40, 40, 30), traceOpts);
    expect(out.svg).toContain('<circle');
    expect(out.svg).not.toContain('rx=');
  });

  it('leaves an organic blob as a path (no false primitive)', () => {
    // A lopsided pear shape: two offset discs merged — not any single primitive.
    const img = blank(80);
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 80; x++) {
        const inA = (x - 30) ** 2 + (y - 34) ** 2 <= 20 ** 2;
        const inB = (x - 48) ** 2 + (y - 50) ** 2 <= 14 ** 2;
        if (inA || inB) setPixel(img, x, y, ...FG);
      }
    const out = trace(img, traceOpts);
    expect(out.svg).not.toContain('<circle');
    expect(out.svg).not.toContain('<ellipse');
    expect(out.svg).toContain('<path');
  });

  it('is off by default', () => {
    const img = disc(80, 40, 40, 30);
    expect(trace(img, { colors: 2 }).svg).not.toContain('<circle');
  });

  it('shrinks the file: a <circle> beats a four-curve outline', () => {
    // Keep the disc a clear minority colour so it stays a foreground shape
    // rather than being collapsed into the background rectangle.
    const img = disc(140, 70, 70, 40);
    const prim = trace(img, traceOpts).svg;
    const path = trace(img, { colors: 2 }).svg;
    expect(prim).toContain('<circle');
    expect(prim.length).toBeLessThan(path.length);
  });
});

describe('sectors: pie slices and ring segments', () => {
  it('reads a pie slice back at its true centre, radius and sweep', () => {
    const img = chart(240, 0, 100, [1.7, 3.4, 5.1, 2 * Math.PI]);
    const loops = soleLoops(img, 5);
    // Four slices, and every one of them recognised.
    expect(loops.length).toBe(4);
    for (const pts of loops) {
      const p = detectPrimitive(pts, { maxError: 1 });
      expect(p?.kind).toBe('sector');
      if (p?.kind !== 'sector') continue;
      // The mask is tested at pixel indices, so in the contour's corner-lattice
      // coordinates the true centre is half a pixel along each axis.
      expect(Math.hypot(p.cx - 120.5, p.cy - 120.5)).toBeLessThan(1);
      expect(p.r0).toBe(0);
      expect(p.r1).toBeGreaterThan(99);
      expect(p.r1).toBeLessThan(101);
    }
    // The four sweeps must tile the full turn: 1.7 + 1.7 + 1.7 + 1.183.
    const total = loops
      .map((pts) => detectPrimitive(pts, { maxError: 1 }))
      .reduce((s, p) => s + (p?.kind === 'sector' ? p.a1 - p.a0 : 0), 0);
    expect(total).toBeGreaterThan(2 * Math.PI - 0.06);
    expect(total).toBeLessThan(2 * Math.PI + 0.06);
  });

  it('reads a ring segment back with its inner radius', () => {
    const img = chart(240, 55, 100, [2.0, 4.0, 2 * Math.PI]);
    const loops = soleLoops(img, 4);
    expect(loops.length).toBe(3);
    for (const pts of loops) {
      const p = detectPrimitive(pts, { maxError: 1 });
      expect(p?.kind).toBe('sector');
      if (p?.kind !== 'sector') continue;
      expect(p.r0).toBeGreaterThan(54);
      expect(p.r0).toBeLessThan(56);
      expect(p.r1).toBeGreaterThan(99);
      expect(p.r1).toBeLessThan(101);
    }
  });

  it('emits real arc commands, not a flattened polygon', () => {
    const img = chart(240, 0, 100, [1.7, 3.4, 5.1, 2 * Math.PI]);
    const out = trace(img, { colors: 5, primitives: true });
    expect(arcPaths(out.svg)).toBe(4);
    // An elliptical-arc command with the sector's radius, twice per slice for a
    // ring and once for a pie.
    expect(out.svg).toMatch(/A100(\.\d+)? 100(\.\d+)? 0 [01] 1 /);
  });

  it('shrinks a pie chart and a donut chart', () => {
    for (const [r0, cuts, colors] of [
      [0, [1.7, 3.4, 5.1, 2 * Math.PI], 5],
      [55, [2.0, 4.0, 2 * Math.PI], 4],
    ] as const) {
      const img = chart(240, r0, 100, [...cuts]);
      const on = trace(img, { colors, primitives: true });
      const off = trace(img, { colors });
      expect(arcPaths(on.svg)).toBe(cuts.length);
      expect(arcPaths(off.svg)).toBe(0);
      expect(on.svg.length).toBeLessThan(off.svg.length / 2);
    }
  });

  it('still fires when a colour also appears in a legend', () => {
    // The case that matters and that a per-class test never reaches: each slice
    // colour is used twice, so no colour is a single isolated region.
    const img = chart(240, 0, 95, [1.7, 3.4, 5.1, 2 * Math.PI], true);
    const out = trace(img, { colors: 5, primitives: true });
    expect(arcPaths(out.svg)).toBe(4);
    // The swatches are rectangles, and they are still emitted as such.
    expect(out.svg).toContain('<rect');
  });

  it('renders the chart as faithfully as the Bézier outline it replaces', async () => {
    const img = chart(240, 55, 100, [2.0, 4.0, 2 * Math.PI]);
    const on = await rasterizeSvg(trace(img, { colors: 4, primitives: true }).svg, { width: 240 });
    const off = await rasterizeSvg(trace(img, { colors: 4 }).svg, { width: 240 });
    const onSsim = compareImages(img, on.image).ssim;
    const offSsim = compareImages(img, off.image).ssim;
    expect(onSsim).toBeGreaterThan(0.98);
    // The same trade the accepted <circle> makes: an ideal outline cannot follow
    // a pixel staircase exactly, and gives up a little SSIM to say what it is.
    expect(onSsim).toBeGreaterThan(offSsim - 0.03);
  });

  it('refuses a triangle, whose "arc" is a straight edge', () => {
    // A wedge with the same apex and the same two radial edges as a pie slice,
    // closed by a chord instead of an arc. Its sagitta is zero.
    const img = blank(200);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) {
        const dx = x - 100, dy = y - 100;
        if (dy < 0 || dy > 80) continue;
        if (Math.abs(dx) <= dy * 0.7) setPixel(img, x, y, ...FG);
      }
    const out = trace(img, traceOpts);
    expect(arcPaths(out.svg)).toBe(0);
  });

  it('refuses a photograph', () => {
    const size = 120;
    const img = createImage(size, size);
    let s = 7;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        setPixel(img, x, y,
          40 + 180 * (x / size) + rnd() * 30,
          30 + 150 * (y / size) + rnd() * 30,
          200 - (120 * (x * y)) / (size * size) + rnd() * 30);
    expect(arcPaths(trace(img, { colors: 12, primitives: true }).svg)).toBe(0);
  });

  it('leaves a full disc and a full annulus to the circle fitter', () => {
    expect(arcPaths(trace(disc(80, 40, 40, 30), traceOpts).svg)).toBe(0);
    const ring = blank(200);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) {
        const d = Math.hypot(x - 100, y - 100);
        if (d <= 80 && d >= 45) setPixel(ring, x, y, ...FG);
      }
    expect(arcPaths(trace(ring, traceOpts).svg)).toBe(0);
  });

  it('is off by default', () => {
    const img = chart(240, 0, 100, [1.7, 3.4, 5.1, 2 * Math.PI]);
    expect(arcPaths(trace(img, { colors: 5 }).svg)).toBe(0);
  });
});

/**
 * The solid boundary loops of every colour except the largest, taken off the
 * real quantise → segment → contour chain. A unit test that fed `detectPrimitive`
 * a hand-written polygon would be testing an idealised input; these are the
 * exact staircases {@link trace} hands it.
 */
function soleLoops(img: RasterImage, colors: number): Int32Array[] {
  const n = img.width * img.height;
  const levels = quantizeAlpha(img, 8);
  const palette = quantize(img, colors, { refineIterations: 4 });
  const nearest = new NearestColor(palette, n);
  const classes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    classes[i] = nearest.index(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]) * levels.length;
  }
  const comps = connectedComponents(classes, img.width, img.height, -1);
  const groups = traceComponents(comps.labels, img.width, img.height, comps.count, 'left');

  const areaOf = new Map<number, number>();
  for (let c = 0; c < comps.count; c++) {
    areaOf.set(comps.classes[c], (areaOf.get(comps.classes[c]) ?? 0) + comps.areas[c]);
  }
  const background = [...areaOf.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const out: Int32Array[] = [];
  for (let c = 0; c < comps.count; c++) {
    if (comps.classes[c] === background) continue;
    for (const loop of groups[c]) if (loop.signedArea > 0) out.push(loop.pts);
  }
  return out;
}
