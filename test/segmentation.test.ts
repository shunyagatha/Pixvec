import { describe, expect, it } from 'vitest';
import { segmentPixels, flattenToSegments } from '../src/vectorize/merge.js';
import type { RasterImage } from '../src/types.js';

/**
 * Region segmentation, and the one rule that makes it non-destructive.
 *
 * The interesting assertions here are not "does it segment" — they are the two
 * failure modes it was built to avoid, both of which shipped once. Absorbing
 * every small region eroded a logo's silhouette; merging on colour alone could
 * not tell a one-pixel fragment from a feature.
 */

function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function regionCount(labels: Int32Array): number {
  let n = 0;
  for (const v of labels) if (v + 1 > n) n = v + 1;
  return n;
}

describe('segmentPixels', () => {
  it('finds one region per flat area, not one per pixel', () => {
    // Two halves, hard edge down the middle.
    const img = image(40, 40, (x) => (x < 20 ? [220, 40, 40] : [40, 80, 220]));
    expect(regionCount(segmentPixels(img, 0.02, 0))).toBe(2);
  });

  it('does not merge across a strong boundary however cheap the surroundings are', () => {
    // A dark bar through a light field: cheap merges everywhere except the bar.
    const img = image(40, 40, (x, y) => (y >= 18 && y <= 21 ? [10, 10, 10] : [230, 230, 230]));
    expect(regionCount(segmentPixels(img, 0.02, 0))).toBe(3); // above, bar, below
  });

  it('absorbs a speck that sits INSIDE a region', () => {
    const img = image(30, 30, (x, y) => (x === 15 && y === 15 ? [10, 200, 10] : [200, 200, 200]));
    // Without the cleanup the speck is its own region; with it, it is absorbed.
    expect(regionCount(segmentPixels(img, 0.02, 0))).toBe(2);
    expect(regionCount(segmentPixels(img, 0.02, 8))).toBe(1);
  });

  it('decides a runt by WHERE it sits, not how small it is', () => {
    // The regression that matters, and the fixture is built so one assertion pins
    // the rule from both sides: two runts of identical size and identical colour,
    // one inside a region and one straddling the boundary between two.
    //
    // An earlier version of this test used a 40-pixel fringe, which is larger than
    // `minRegion` and so was never a candidate for absorption at all. It passed
    // with the rule deleted. A runt has to actually be a runt to test the rule.
    const scene = (fringeAt: (x: number, y: number) => boolean) => image(40, 40, (x, y) =>
      fringeAt(x, y) ? [128, 128, 128] : x < 20 ? [235, 235, 235] : [20, 20, 20]);

    const labelOf = (labels: Int32Array, x: number, y: number) => labels[y * 40 + x];
    const verdict = (fringeAt: (x: number, y: number) => boolean, x: number, y: number) => {
      const img = scene(fringeAt);
      // Without the size pass the speck is always its own region — otherwise the
      // test below would be measuring segmentation, not the cleanup.
      const loose = segmentPixels(img, 0.02, 0);
      expect(labelOf(loose, x, y)).not.toBe(labelOf(loose, 2, 2));
      expect(labelOf(loose, x, y)).not.toBe(labelOf(loose, 37, 37));

      const tight = segmentPixels(img, 0.02, 8);
      const own = labelOf(tight, x, y);
      return own !== labelOf(tight, 2, 2) && own !== labelOf(tight, 37, 37);
    };

    // Inside the light region: grain, and free to absorb.
    expect(verdict((x, y) => x === 10 && y === 10, 10, 10)).toBe(false);

    // On the boundary: anti-aliasing fringe. It carries the sub-pixel position of
    // that edge, and absorbing it drags the edge — which is what eroded a logo's
    // silhouette when the cleanup took everything small.
    expect(verdict((x, y) => x === 19 && y === 10, 19, 10)).toBe(true);
  });

  it('is deterministic', () => {
    const img = image(32, 32, (x, y) => [(x * 7) % 256, (y * 11) % 256, ((x + y) * 5) % 256]);
    expect([...segmentPixels(img, 0.02, 4)]).toEqual([...segmentPixels(img, 0.02, 4)]);
  });
});

describe('alpha is part of the segmentation, not an afterthought', () => {
  /** Half opaque, half transparent, ONE rgb colour — so alpha is the only signal. */
  const alphaEdge = (): RasterImage => {
    const data = new Uint8ClampedArray(40 * 40 * 4);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const o = (y * 40 + x) * 4;
        data[o] = 180; data[o + 1] = 60; data[o + 2] = 40;
        data[o + 3] = x < 20 ? 255 : 0;
      }
    }
    return { width: 40, height: 40, data };
  };

  it('keeps a transparency edge apart when the colours either side are identical', () => {
    expect(regionCount(segmentPixels(alphaEdge(), 0.02, 0))).toBe(2);
  });

  it('does not average a hard alpha edge into a uniform wash', () => {
    // The failure this guards: with alpha outside the edge weight the two halves
    // are zero distance apart, merge into one region, and come back at alpha 128
    // each — the opaque half turned translucent and the invisible half visible.
    const out = flattenToSegments(alphaEdge(), 0.02, 0);
    const alphaAt = (x: number, y: number) => out.data[(y * 40 + x) * 4 + 3];
    expect(alphaAt(2, 20)).toBe(255);
    expect(alphaAt(37, 20)).toBe(0);
  });

  it('weighs a transparency step the same as a lightness step of equal size', () => {
    // Presence is not enough: the two tests above still pass with alpha weighted at
    // a ten-thousandth, because on regions this size the k/size threshold decides
    // everything and any non-zero weight separates them. This pins the WEIGHT.
    //
    // Two pixels and one edge, so the merge threshold is exactly k and a bisection
    // on k reads the edge weight directly off the algorithm.
    const pair = (a: number[], b: number[]): RasterImage =>
      ({ width: 2, height: 1, data: new Uint8ClampedArray([...a, ...b]) });
    const mergeThreshold = (img: RasterImage) => {
      let lo = 0, hi = 2;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const labels = segmentPixels(img, mid, 0);
        if (labels[0] === labels[1]) hi = mid; else lo = mid;
      }
      return lo;
    };

    // Half transparency against the lightness step that measures the same in Oklab.
    const byAlpha = mergeThreshold(pair([180, 60, 40, 255], [180, 60, 40, 128]));
    const byLightness = mergeThreshold(pair([255, 255, 255, 255], [100, 100, 100, 255]));
    expect(byAlpha).toBeGreaterThan(0.4);
    expect(Math.abs(byAlpha - byLightness)).toBeLessThan(0.02);
  });

  it('leaves a fully opaque image alone, so the alpha term costs opaque art nothing', () => {
    const opaque = image(40, 40, (x) => (x < 20 ? [200, 40, 40] : [40, 40, 200]));
    expect(regionCount(segmentPixels(opaque, 0.02, 0))).toBe(2);
  });
});

describe('flattenToSegments', () => {
  it('keeps the frame and paints each region one colour', () => {
    const img = image(24, 24, (x) => (x < 12 ? [200, 30, 30] : [30, 30, 200]));
    const out = flattenToSegments(img, 0.02, 0);
    expect([out.width, out.height]).toEqual([24, 24]);
    // Both halves are already flat, so flattening must be a no-op on their colour.
    const at = (x: number, y: number) => {
      const o = (y * 24 + x) * 4;
      return [out.data[o], out.data[o + 1], out.data[o + 2]];
    };
    expect(at(3, 3)).toEqual([200, 30, 30]);
    expect(at(20, 3)).toEqual([30, 30, 200]);
  });

  it('collapses grain to a flat colour without moving the edge', () => {
    // Uniform halves plus per-pixel noise: flattening should recover the halves.
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 17) - 8;
    const img = image(40, 40, (x) => (x < 20
      ? [200 + rand(), 60 + rand(), 60 + rand()]
      : [60 + rand(), 60 + rand(), 200 + rand()]));
    // k=0.2 is the amplitude this grain needs bridged; 0.05 leaves it fragmented,
    // which is the knob behaving as documented rather than a tuning accident.
    const out = flattenToSegments(img, 0.2, 4);
    const at = (x: number, y: number) => out.data[(y * 40 + x) * 4];
    // Every pixel well inside a half now shares that half's colour exactly.
    const left = at(4, 4);
    for (let y = 2; y < 38; y += 5) for (let x = 2; x < 16; x += 3) expect(at(x, y)).toBe(left);
    // And the edge did not move: column 19 is still the light half.
    expect(at(19, 20)).toBe(left);
  });
});
