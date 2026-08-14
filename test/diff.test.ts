import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../src/types.js';
import { diffImages } from '../src/diff.js';
import { createImage, setPixel, flatArtwork } from './fixtures.js';

function solid(w: number, h: number, r: number, g: number, b: number, a = 255): RasterImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, r, g, b, a);
  return img;
}

describe('diffImages', () => {
  it('reports zero changes for identical images', () => {
    const img = flatArtwork(40, 30);
    const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
    const d = diffImages(img, copy);
    expect(d.changedPixels).toBe(0);
    expect(d.maxDeltaE).toBeCloseTo(0, 6);
    expect(d.changedFraction).toBe(0);
    // Heatmap is fully opaque and carries no highlight red.
    for (let i = 0; i < d.image.data.length; i += 4) expect(d.image.data[i + 3]).toBe(255);
  });

  it('highlights exactly the pixels that changed', () => {
    const a = solid(20, 20, 200, 200, 200);
    const b = solid(20, 20, 200, 200, 200);
    // Repaint a 5×5 block in b with a strongly different colour.
    for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) setPixel(b, x, y, 10, 220, 30);

    const d = diffImages(a, b, { threshold: 2, diffColor: { r: 255, g: 0, b: 0, a: 255 } });
    expect(d.changedPixels).toBe(25);
    // A changed pixel is painted the highlight colour…
    const on = (3 * 20 + 3) * 4;
    expect([d.image.data[on], d.image.data[on + 1], d.image.data[on + 2]]).toEqual([255, 0, 0]);
    // …an unchanged pixel is a grey backdrop, not red.
    const off = (15 * 20 + 15) * 4;
    expect(d.image.data[off]).toBe(d.image.data[off + 1]);
    expect(d.image.data[off + 1]).toBe(d.image.data[off + 2]);
    expect(d.image.data[off]).not.toBe(255 - 0); // not the red channel of a highlight
  });

  it('respects the threshold: a sub-JND wobble is not flagged', () => {
    const a = solid(16, 16, 128, 128, 128);
    const b = solid(16, 16, 129, 128, 128); // one level on one channel
    expect(diffImages(a, b, { threshold: 2 }).changedPixels).toBe(0);
    // A tiny threshold catches it.
    expect(diffImages(a, b, { threshold: 0.01 }).changedPixels).toBe(16 * 16);
  });

  it('honours includeAlpha for pixels that look identical but carry different alpha', () => {
    // Both composite to ~(200,200,200) over white, so ΔE alone sees no change —
    // but the alpha differs, a difference only visible over another background.
    const a = solid(8, 8, 200, 200, 200, 255);
    const b = solid(8, 8, 145, 145, 145, 128); // ≈ composites to 200 over white
    expect(diffImages(a, b, { threshold: 2, includeAlpha: true }).changedPixels).toBe(64);
    expect(diffImages(a, b, { threshold: 2, includeAlpha: false }).changedPixels).toBe(0);
  });

  it('does not flag invisible pixels with different-but-unseen RGB', () => {
    // Both fully transparent — they render identically (nothing), so no change.
    const a = solid(6, 6, 255, 0, 0, 0);
    const b = solid(6, 6, 0, 0, 255, 0);
    const d = diffImages(a, b, { threshold: 2 });
    expect(d.changedPixels).toBe(0);
    expect(d.maxDeltaE).toBeCloseTo(0, 6);
  });

  it('still flags a genuine appear/disappear (alpha flip)', () => {
    const a = solid(6, 6, 100, 100, 100, 255); // visible grey
    const b = solid(6, 6, 100, 100, 100, 0);   // gone
    expect(diffImages(a, b, { threshold: 2 }).changedPixels).toBe(36);
  });

  it('does not produce NaN for a zero-area image', () => {
    const empty = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    const d = diffImages(empty, empty);
    expect(d.changedFraction).toBe(0);
    expect(d.meanDeltaE).toBe(0);
    expect(d.changedPixels).toBe(0);
  });

  it('throws on a size mismatch', () => {
    expect(() => diffImages(solid(10, 10, 0, 0, 0), solid(10, 12, 0, 0, 0))).toThrow(/same size/);
  });

  it('measures worst and mean ΔE', () => {
    const a = solid(10, 10, 0, 0, 0);
    const b = solid(10, 10, 0, 0, 0);
    setPixel(b, 0, 0, 255, 255, 255); // one very different pixel
    const d = diffImages(a, b);
    expect(d.maxDeltaE).toBeGreaterThan(50); // black vs white is a huge ΔE
    expect(d.meanDeltaE).toBeGreaterThan(0);
    expect(d.meanDeltaE).toBeLessThan(d.maxDeltaE);
  });
});
