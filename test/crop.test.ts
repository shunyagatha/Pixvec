import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../src/types.js';
import { smartCrop, cropImage } from '../src/crop.js';
import { createImage, setPixel } from './fixtures.js';

/** Flat grey field with a high-frequency, saturated blob at a chosen box. */
function sceneWithBlob(w: number, h: number, bx: number, by: number, bw: number, bh: number): RasterImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) setPixel(img, x, y, 128, 128, 128);
  // Checkerboard of saturated red/blue → strong edges and saturation.
  for (let y = by; y < by + bh; y++)
    for (let x = bx; x < bx + bw; x++) {
      const on = (x + y) & 1;
      setPixel(img, x, y, on ? 230 : 10, 20, on ? 20 : 220);
    }
  return img;
}

describe('smartCrop', () => {
  it('follows the subject instead of taking the centre', () => {
    // Blob sits on the LEFT of a wide frame; a naive centre square would miss it.
    const img = sceneWithBlob(200, 100, 20, 30, 40, 40);
    const rect = smartCrop(img, { aspect: 1 });

    const blobCx = 40, blobCy = 50;
    // The crop contains the subject…
    expect(rect.x).toBeLessThanOrEqual(blobCx);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(blobCx);
    expect(rect.y).toBeLessThanOrEqual(blobCy);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(blobCy);
    // …and it is genuinely off-centre (a centre square would start near x=50).
    expect(rect.x).toBeLessThan(40);
  });

  it('respects the requested aspect ratio', () => {
    const img = sceneWithBlob(300, 200, 120, 80, 40, 40);
    for (const [aw, ah] of [[1, 1], [16, 9], [4, 5]] as const) {
      const r = smartCrop(img, { aspect: [aw, ah] });
      expect(r.width / r.height).toBeCloseTo(aw / ah, 1);
      // Never overhangs the source.
      expect(r.x + r.width).toBeLessThanOrEqual(img.width);
      expect(r.y + r.height).toBeLessThanOrEqual(img.height);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('never overhangs and stays valid on a flat image', () => {
    const img = createImage(120, 80);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 200; img.data[i + 3] = 255;
    }
    const r = smartCrop(img, { aspect: [1, 1] });
    expect(r.width).toBe(r.height); // square fit into 80-tall image → 80×80
    expect(r.height).toBe(80);
    expect(r.x + r.width).toBeLessThanOrEqual(120);
  });

  it('handles a portrait target inside a landscape image', () => {
    const img = sceneWithBlob(240, 160, 20, 20, 60, 60);
    const r = smartCrop(img, { aspect: [3, 4] });
    expect(r.width).toBeLessThan(r.height); // portrait window
    expect(r.width / r.height).toBeCloseTo(0.75, 1);
  });
});

describe('cropImage', () => {
  it('extracts the exact sub-rectangle', () => {
    const img = createImage(10, 10);
    // Encode each pixel's coordinates in R/G so we can verify placement.
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) setPixel(img, x, y, x * 10, y * 10, 0);

    const out = cropImage(img, { x: 3, y: 4, width: 5, height: 2 });
    expect([out.width, out.height]).toEqual([5, 2]);
    // Top-left of the crop is source pixel (3,4).
    expect([out.data[0], out.data[1]]).toEqual([30, 40]);
    // Bottom-right of the crop is source pixel (7,5).
    const last = (1 * 5 + 4) * 4;
    expect([out.data[last], out.data[last + 1]]).toEqual([70, 50]);
  });

  it('clamps a rectangle that runs past the edge', () => {
    const img = createImage(8, 8);
    const out = cropImage(img, { x: 6, y: 6, width: 10, height: 10 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });
});
