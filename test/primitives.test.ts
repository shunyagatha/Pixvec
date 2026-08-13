import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../src/types.js';
import { detectPrimitive } from '../src/vectorize/primitives.js';
import { trace } from '../src/vectorize/trace.js';
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

const traceOpts = { colors: 2, primitives: true } as const;

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
