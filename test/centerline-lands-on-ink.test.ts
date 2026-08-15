import { describe, expect, it } from 'vitest';
import { centerlinePolylines } from '../src/vectorize/centerline.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * A centreline skeleton has to lie on the ink.
 *
 * That sounds too obvious to test, which is exactly why nothing tested it. The
 * Figma plugin shipped centreline with `adaptive: true`, reasoning about
 * photographs of paper, and on flat artwork it skeletonised the *background* —
 * 56.3% of the skeleton's vertices landed on empty canvas, drawing a wandering
 * outline around the negative space. Every existing check still passed: the call
 * returned polylines, the SVG was well formed, the count was plausible. Nothing
 * asked where the strokes were.
 *
 * Bradley-Roth marks a pixel as ink when it sits below its own neighbourhood
 * mean. Inside a large uniform area — a flat fill, or a flat background — a
 * pixel is its own neighbourhood, so the comparison decides nothing and the mask
 * breaks up along noise. It is the right tool for a photograph with a lighting
 * gradient and the wrong one for vector artwork, which is what a design tool
 * mostly holds.
 *
 * The metric here is the one that catches it: what fraction of skeleton vertices
 * sit on a pixel that is actually ink.
 */

/** Ink is the minority class, counting only opaque pixels. */
function inkIsDark(img: RasterImage): boolean {
  let dark = 0;
  let light = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    const y = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    if (y < 128) dark++;
    else light++;
  }
  return dark <= light;
}

function fractionOnInk(img: RasterImage, polylines: { x: number; y: number }[][]): number {
  const dark = inkIsDark(img);
  let hit = 0;
  let total = 0;
  for (const line of polylines) {
    for (const p of line) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
      total++;
      if (dark ? lum < 128 : lum >= 128) hit++;
    }
  }
  return total === 0 ? 0 : hit / total;
}

/** A thick diagonal band — a filled shape with large uniform interiors. */
function diagonalBand(light: boolean): RasterImage {
  const W = 240, H = 240, HALF = 16;
  const img = createImage(W, H);
  const ink = light ? 230 : 30;
  const ground = light ? 30 : 230;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onBand = Math.abs(x - y) <= HALF;
      const v = onBand ? ink : ground;
      setPixel(img, x, y, v, v, v);
    }
  }
  return img;
}

/**
 * A diagonal bar with mitred 45° ends that sit INSIDE the frame — a rotated
 * rectangle, which is what an arrow shaft or any tilted stroke is.
 *
 * This is the shape that exposed the thinning bug, and the flat-ended
 * `diagonalBand` above does not: `diagonalBand` runs off the image edge, so its
 * ends are clipped square and the thinner never sees a diagonal tip to peel
 * from. A bar whose ends terminate within the frame does, and Zhang–Suen ate it
 * from both ends down to a two-pixel dot. The band runs from near one corner to
 * near the opposite one along y = x, half-width HALF, cut off past `margin`.
 */
function diagonalBar(HALF: number): RasterImage {
  const W = 240, H = 240, margin = 40;
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const across = Math.abs(x - y) <= HALF;
      const within = x >= margin && x <= W - margin && y >= margin && y <= H - margin;
      const v = across && within ? 30 : 230;
      setPixel(img, x, y, v, v, v);
    }
  }
  return img;
}

describe('centerline skeletons land on the ink', () => {
  for (const light of [false, true]) {
    const what = light ? 'light artwork on a dark ground' : 'dark artwork on a light ground';

    it(`stays on the stroke for ${what}`, () => {
      const img = diagonalBand(light);
      const polylines = centerlinePolylines(img, { blackOnWhite: inkIsDark(img) });
      expect(polylines.length).toBeGreaterThan(0);
      expect(fractionOnInk(img, polylines)).toBeGreaterThan(0.95);
    });

    it(`runs down the middle of the band for ${what}`, () => {
      // A skeleton is not just "on the ink" — for a band of constant width it
      // should be near its centre line, which here is x === y.
      const img = diagonalBand(light);
      const polylines = centerlinePolylines(img, { blackOnWhite: inkIsDark(img) });
      const offsets = polylines.flat().map((p) => Math.abs(p.x - p.y));
      const median = offsets.sort((a, b) => a - b)[Math.floor(offsets.length / 2)]!;
      expect(median).toBeLessThan(4);
    });
  }

  it('emits a straight skeleton for a straight shape', () => {
    // A band whose true centre line is dead straight should come back as one
    // segment, not as a polyline tracing the pixel grid's own jitter. Thinning
    // leaves roughly 0.6px of that jitter, so a Douglas-Peucker tolerance below
    // it preserves noise as geometry.
    const img = diagonalBand(false);
    const polylines = centerlinePolylines(img, { blackOnWhite: true, simplify: 4 });
    const longest = polylines.reduce((a, b) => (b.length > a.length ? b : a));

    // Straightness measured the way a reader would judge it: a path that is
    // longer than the straight line between its endpoints is bent.
    let length = 0;
    for (let i = 1; i < longest.length; i++) {
      length += Math.hypot(longest[i]!.x - longest[i - 1]!.x, longest[i]!.y - longest[i - 1]!.y);
    }
    const chord = Math.hypot(
      longest.at(-1)!.x - longest[0]!.x,
      longest.at(-1)!.y - longest[0]!.y,
    );
    expect(length / chord).toBeLessThan(1.005);
  });

  for (const HALF of [2, 6, 14]) {
    it(`recovers the full length of a ${HALF * 2}px-wide diagonal bar with mitred ends`, () => {
      // The thinning-erosion regression. A diagonal bar that ends inside the
      // frame used to thin down to a two-pixel dot that the length filter then
      // deleted, so the tracer returned nothing at all for a rotated stroke.
      // The bar here spans ~160px along its axis; a correct skeleton is most of
      // that, inset a little at each mitred end. Anything under a third of the
      // length means the ends are being eaten.
      const img = diagonalBar(HALF);
      const polylines = centerlinePolylines(img, { blackOnWhite: true, simplify: 4 });

      expect(polylines.length).toBeGreaterThan(0);
      const total = polylines.reduce((sum, line) => {
        let len = 0;
        for (let i = 1; i < line.length; i++) {
          len += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y);
        }
        return sum + len;
      }, 0);
      expect(total).toBeGreaterThan(120);
      expect(fractionOnInk(img, polylines)).toBeGreaterThan(0.95);
    });
  }

  it('does not wander onto the background when the ink polarity is right', () => {
    // The plugin's failing case in miniature: light shapes, dark ground, large
    // uniform regions either side of the edge.
    const img = diagonalBand(true);
    const polylines = centerlinePolylines(img, { blackOnWhite: false });
    expect(fractionOnInk(img, polylines)).toBe(1);
  });
});
