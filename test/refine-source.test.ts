import { describe, expect, it } from 'vitest';
import { boundaryBand, bilateralForMeasurement, refineSourceFor } from '../src/vectorize/refine-source.js';
import { MAX_PLATEAU_REACH } from '../src/vectorize/subpixel.js';
import type { RasterImage } from '../src/types.js';

/**
 * Band-limited bilateral denoise for sub-pixel measurement.
 *
 * The claim under test is narrow: the filter must touch pixels within
 * `MAX_PLATEAU_REACH` of a region-label boundary and leave everything else a
 * byte-for-byte copy of the source. That is what makes this "band-limited"
 * rather than a whole-raster blur wearing a smaller radius — a version that
 * silently filtered everywhere would pass every OTHER test in this file
 * (the near-boundary denoising still happens) while failing the far-field one
 * below, which is the point of writing it as a separate assertion.
 */

function solidImage(w: number, h: number, v: number, a = 255): RasterImage {
  const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = a;
  }
  return img;
}

describe('boundaryBand', () => {
  it('marks a boundary and its dilation, nothing further out', () => {
    const w = 60, h = 10;
    const labels = new Int32Array(w * h);
    // A vertical boundary at x = 30: label 0 left, label 1 right.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) labels[y * w + x] = x < 30 ? 0 : 1;
    }
    const band = boundaryBand(labels, w, h, MAX_PLATEAU_REACH);

    // Right at the boundary: always in band. Both x=29 (label 0, neighbours
    // label 1) and x=30 (label 1, neighbours label 0) are boundary-adjacent
    // seeds, so they are each other's nearest seed at distance 0.
    expect(band[5 * w + 29]).toBe(1);
    expect(band[5 * w + 30]).toBe(1);
    // Exactly MAX_PLATEAU_REACH steps from the nearest seed (29 or 30): still
    // in band — the dilation radius is inclusive, and this is the boundary
    // pixel an off-by-one in the dilation comparison would misclassify.
    expect(band[5 * w + (29 - MAX_PLATEAU_REACH)]).toBe(1);
    expect(band[5 * w + (30 + MAX_PLATEAU_REACH)]).toBe(1);
    // One further than the dilation radius: out of band.
    expect(band[5 * w + (29 - MAX_PLATEAU_REACH - 1)]).toBe(0);
    expect(band[5 * w + (30 + MAX_PLATEAU_REACH + 1)]).toBe(0);
  });

  it('marks nothing when the whole image is one label', () => {
    const w = 40, h = 40;
    const labels = new Int32Array(w * h).fill(7);
    const band = boundaryBand(labels, w, h);
    expect(band.some((b) => b !== 0)).toBe(false);
  });
});

describe('bilateralForMeasurement', () => {
  /**
   * The load-bearing property. A ringing pixel identical in every way except
   * its distance from the nearest region boundary must be denoised near the
   * boundary and left byte-identical far from it — proving the "band-limited"
   * claim rather than assuming it from the doc comment.
   *
   * MUTATION CHECK (performed by hand, not shipped): replacing the `band`
   * passed to `bilateralForMeasurement` with an all-ones array of the same
   * length made the far-field assertion fail (the far pixel got smoothed like
   * the near one) while the near-field assertion kept passing — confirming
   * this test actually discriminates band-limiting from a whole-image filter,
   * not just presence of denoising. Restored afterward.
   */
  it('denoises inside the band and leaves far-field pixels untouched', () => {
    const w = 80, h = 20;
    const labels = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) labels[y * w + x] = x < 10 ? 0 : 1;
    }
    const img = solidImage(w, h, 200);

    // A ringing pixel near the boundary (inside the band): x=12.
    const nearX = 12;
    const nearOff = (5 * w + nearX) * 4;
    img.data[nearOff] = 230; img.data[nearOff + 1] = 230; img.data[nearOff + 2] = 230;

    // The identical perturbation, far from any boundary (outside the band,
    // since MAX_PLATEAU_REACH is 12 and this sits at x=60).
    const farX = 60;
    const farOff = (5 * w + farX) * 4;
    img.data[farOff] = 230; img.data[farOff + 1] = 230; img.data[farOff + 2] = 230;

    const band = boundaryBand(labels, w, h);
    expect(band[5 * w + nearX]).toBe(1);
    expect(band[5 * w + farX]).toBe(0);

    const out = bilateralForMeasurement(img, band);

    // Near: pulled toward its neighbours (200), so no longer exactly 230.
    expect(out.data[nearOff]).not.toBe(230);
    expect(out.data[nearOff]).toBeLessThan(230);

    // Far: byte-for-byte identical to the source — the filter never ran there.
    expect(out.data[farOff]).toBe(230);
    expect(out.data[farOff + 1]).toBe(230);
    expect(out.data[farOff + 2]).toBe(230);
    expect(out.data[farOff + 3]).toBe(255);
  });

  it('leaves a genuine hard region boundary alone (range term rejects it)', () => {
    const w = 40, h = 10;
    const labels = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) labels[y * w + x] = x < 20 ? 0 : 1;
    }
    const img = solidImage(w, h, 0);
    // Hard right half is pure white — a real edge, hundreds of levels apart.
    for (let y = 0; y < h; y++) {
      for (let x = 20; x < w; x++) {
        const o = (y * w + x) * 4;
        img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255;
      }
    }
    const band = boundaryBand(labels, w, h);
    const out = bilateralForMeasurement(img, band);
    // Both plateaus survive essentially unchanged — the range term collapses
    // the cross-edge weight to ~0, so each side is dominated by its own kind.
    const leftOff = (5 * w + 15) * 4; // inside the band (boundary at x=20)
    const rightOff = (5 * w + 25) * 4;
    expect(out.data[leftOff]).toBeLessThan(5);
    expect(out.data[rightOff]).toBeGreaterThan(250);
  });

  it('does not touch alpha differently from colour', () => {
    const w = 30, h = 10;
    const labels = new Int32Array(w * h).fill(0);
    for (let y = 0; y < h; y++) for (let x = 15; x < w; x++) labels[y * w + x] = 1;
    const img = solidImage(w, h, 128, 255);
    const noisyOff = (5 * w + 16) * 4;
    img.data[noisyOff + 3] = 200; // an alpha ringing pixel near the boundary
    const band = boundaryBand(labels, w, h);
    const out = bilateralForMeasurement(img, band);
    expect(out.data[noisyOff + 3]).not.toBe(200);
    expect(out.data[noisyOff + 3]).toBeGreaterThan(200);
  });
});

describe('refineSourceFor', () => {
  it('composes boundaryBand and bilateralForMeasurement identically to calling them separately', () => {
    const w = 50, h = 12;
    const labels = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = x < 25 ? 0 : 1;
    const img = solidImage(w, h, 180);
    const noisyOff = (5 * w + 27) * 4;
    img.data[noisyOff] = 210;

    const combined = refineSourceFor(img, labels);
    const band = boundaryBand(labels, w, h);
    const separate = bilateralForMeasurement(img, band);
    expect(Array.from(combined.data)).toEqual(Array.from(separate.data));
  });
});
