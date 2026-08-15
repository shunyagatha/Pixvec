import { describe, expect, it } from 'vitest';
import { compareImages } from '../src/metrics/index.js';
import { severity, compositeScore } from '../src/metrics/severity.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * The claim this file defends: a global average cannot tell a harmless dusting of
 * antialiasing apart from one solid wrong region, and severity can. Every test
 * here compares two candidates that are deliberately equal on pixel count and
 * differ only in how that error is arranged.
 */

const W = 120, H = 120;

function flat(r: number, g: number, b: number): RasterImage {
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, r, g, b);
  return img;
}

/** N wrong pixels scattered so no two touch — the antialiasing case. */
function scattered(base: RasterImage, n: number): RasterImage {
  const out: RasterImage = { width: W, height: H, data: new Uint8ClampedArray(base.data) };
  let placed = 0;
  for (let y = 1; y < H && placed < n; y += 3) {
    for (let x = 1; x < W && placed < n; x += 3) {
      setPixel(out, x, y, 255, 0, 0);
      placed++;
    }
  }
  return out;
}

/** The same number of wrong pixels, in one solid block — the visible case. */
function blob(base: RasterImage, n: number): RasterImage {
  const out: RasterImage = { width: W, height: H, data: new Uint8ClampedArray(base.data) };
  const side = Math.floor(Math.sqrt(n));
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) setPixel(out, 10 + x, 10 + y, 255, 0, 0);
  return out;
}

describe('severity', () => {
  it('separates scattered error from a coherent region of the same size', () => {
    const base = flat(200, 200, 200);
    const n = 900;
    const a = compareImages(base, scattered(base, n), { severity: true });
    const b = compareImages(base, blob(base, n), { severity: true });

    // Both candidates are wrong in a comparable number of places...
    expect(a.severity!.differing).toBeGreaterThan(0);
    expect(b.severity!.differing).toBeGreaterThan(0);
    // ...but only the blob survives the open as coherent error. This is the whole
    // point: it is the axis that answers "is the error in one place?".
    expect(a.severity!.coherent).toBe(0);
    expect(a.severity!.score).toBe(1);
    expect(b.severity!.coherent).toBeGreaterThan(500);
    expect(b.severity!.largestCluster).toBeGreaterThan(500);
    expect(b.severity!.score).toBeLessThan(1);

    // Note what this deliberately does NOT assert: that the blob's *composite* is
    // worse. It is not, and pretending otherwise would be a lie about our own
    // metric. SSIM is structure-sensitive and already punishes salt-and-pepper
    // noise hard — measured here, scattered composite 0.54 against the blob's
    // 0.75. Severity adds an axis the aggregates lack; it does not overrule them.
  });

  it('is 1.0 and costs nothing extra on a bit-exact result', () => {
    const base = flat(120, 60, 180);
    const q = compareImages(base, base, { severity: true });
    expect(q.lossless).toBe(true);
    expect(q.severity!.score).toBe(1);
    expect(q.severity!.clusters).toBe(0);
    expect(q.composite).toBe(1);
  });

  it('is absent unless asked for, so the default path is unchanged', () => {
    const base = flat(10, 20, 30);
    const q = compareImages(base, blob(base, 400));
    expect(q.severity).toBeUndefined();
    expect(q.composite).toBeUndefined();
  });

  it('clusters are 4-connected and counted separately', () => {
    const base = flat(255, 255, 255);
    const two: RasterImage = { width: W, height: H, data: new Uint8ClampedArray(base.data) };
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      setPixel(two, 5 + x, 5 + y, 0, 0, 0);        // block one
      setPixel(two, 80 + x, 80 + y, 0, 0, 0);      // block two, far away
    }
    const q = compareImages(base, two, { severity: true });
    expect(q.severity!.clusters).toBe(2);
  });
});

describe('compositeScore', () => {
  it('is a geometric mean, so one collapsed axis drags the whole score', () => {
    // Strong on two axes, collapsed on the third: an arithmetic mean would still
    // read well. The geometric mean must not.
    const withHole = compositeScore(40, 0.99, 0.05);
    const evenlyMediocre = compositeScore(24, 0.75, 0.75);
    expect(withHole).toBeLessThan(evenlyMediocre);
  });

  it('returns 1 only when every axis is perfect', () => {
    expect(compositeScore(Infinity, 1, 1)).toBe(1);
    expect(compositeScore(40, 1, 1)).toBe(1);
    expect(compositeScore(39, 1, 1)).toBeLessThan(1);
  });

  it('never exceeds 1 or drops below 0 for out-of-range inputs', () => {
    expect(compositeScore(1e9, 2, 5)).toBeLessThanOrEqual(1);
    expect(compositeScore(-5, -1, -1)).toBeGreaterThanOrEqual(0);
  });
});

describe('severity() directly', () => {
  it('removes single-pixel filaments but keeps regions', () => {
    const n = W * H;
    const field = new Float64Array(n);
    // A one-pixel-wide diagonal line: every pixel is a filament.
    for (let i = 0; i < 100; i++) field[i * W + i] = 10;
    expect(severity(field, W, H).coherent).toBe(0);

    // A solid square of the same total area survives intact.
    const field2 = new Float64Array(n);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) field2[(20 + y) * W + (20 + x)] = 10;
    expect(severity(field2, W, H).coherent).toBeGreaterThan(50);
  });
});
