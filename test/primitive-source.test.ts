import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../src/types.js';
import { trace } from '../src/vectorize/trace.js';
import { flattenPath } from '../src/vectorize/fit.js';
import { createImage, setPixel } from './fixtures.js';

/**
 * Primitive recognition judges the curve that will be EMITTED, not the lattice.
 *
 * The distinction is not cosmetic. Crack-following stores a straight run as its
 * two endpoints however long it is, so a disc with a flat chord sliced off keeps
 * both chord ENDPOINTS exactly on the circle and loses every vertex in between.
 * A per-vertex residual therefore scores that shape as a *perfect* circle —
 * measured at 0.643 px on the loop below, against 0.645 for an intact disc of the
 * same radius. No budget can separate those. Sampling the emitted path instead
 * puts points along the middle of the chord, where the shape actually is.
 */

const FG: [number, number, number] = [40, 90, 200];

function blank(size: number): RasterImage {
  const img = createImage(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = 255;
  }
  return img;
}

/** A disc, optionally with `frac` of its diameter sliced off the right side. */
function disc(size: number, r: number, frac = 0): RasterImage {
  const img = blank(size);
  const c = size / 2;
  const cut = c + r - 2 * r * frac;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 > r * r) continue;
      if (frac > 0 && x + 0.5 > cut) continue;
      setPixel(img, x, y, ...FG);
    }
  }
  return img;
}

/** A centred filled square of side `side`. Fits a `<rect>` exactly at any size. */
function square(size: number, side: number): RasterImage {
  const img = blank(size);
  const x0 = (size - side) >> 1;
  for (let y = x0; y < x0 + side; y++) {
    for (let x = x0; x < x0 + side; x++) setPixel(img, x, y, ...FG);
  }
  return img;
}

const OPTS = { colors: 2, primitives: true } as const;
const circles = (svg: string): number => (svg.match(/<circle\b/g) ?? []).length;
const rects = (svg: string): number => (svg.match(/<rect[\s/>]/g) ?? []).length;

describe('primitive recognition reads the emitted curve, not the lattice', () => {
  it('still promotes an intact disc', () => {
    // The canvas is deliberately generous: the largest class is treated as the
    // background and skipped, so a disc filling its canvas is never a candidate.
    expect(circles(trace(disc(200, 40), OPTS).svg)).toBe(1);
  });

  it('refuses a disc with a flat chord, which the lattice cannot tell from a circle', () => {
    for (const frac of [0.06, 0.12, 0.2]) {
      expect(circles(trace(disc(200, 40, frac), OPTS).svg)).toBe(0);
    }
  });

  it('samples the interior of a straight segment, not only its endpoint', () => {
    // The chord test above is only as good as this: a flattener that emitted a
    // line's endpoint alone would reproduce the lattice's blindness exactly.
    const pts = flattenPath(
      { start: { x: 0, y: 0 }, segments: [{ kind: 'line', x: 40, y: 0 }] },
      1,
    );
    const xs = Array.from({ length: pts.length >> 1 }, (_, i) => pts[i * 2]);
    expect(xs.filter((x) => x > 1 && x < 39).length).toBeGreaterThan(30);
  });

  it('keeps a shape below primitiveMinExtent inside the shared path', () => {
    // A square fits EXACTLY at any size, so this isolates the size floor from
    // the residual: whatever these shapes are refused for, it is not accuracy.
    // `background: false` so the only <rect> in the document is the promotion,
    // and `minArea: 0` so the small ones are not despeckled away first.
    const opts = { ...OPTS, background: false, minArea: 0 };
    // Below the shipped floor of 12: stays in the shared path.
    expect(rects(trace(square(200, 8), opts).svg)).toBe(0);
    expect(rects(trace(square(200, 10), opts).svg)).toBe(0);
    // Above it: promoted.
    expect(rects(trace(square(200, 14), opts).svg)).toBe(1);
    expect(rects(trace(square(200, 20), opts).svg)).toBe(1);
    // And the floor is the thing doing it, not the fitter.
    expect(rects(trace(square(200, 8), { ...opts, primitiveMinExtent: 4 }).svg)).toBe(1);
    expect(rects(trace(square(200, 20), { ...opts, primitiveMinExtent: 40 }).svg)).toBe(0);
  });
});
