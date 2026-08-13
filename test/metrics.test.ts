import { describe, expect, it } from 'vitest';
import { compareImages, ssimPlane } from '../src/metrics/index.js';
import { premultiply } from '../src/image.js';
import { createImage, mulberry32, photoLike, setPixel } from './fixtures.js';

describe('ssimPlane', () => {
  it('is exactly 1 for identical planes', () => {
    const n = 64 * 64;
    const a = new Float64Array(n);
    const rand = mulberry32(3);
    for (let i = 0; i < n; i++) a[i] = Math.floor(rand() * 256);
    expect(ssimPlane(a, a.slice(), 64, 64)).toBeCloseTo(1, 12);
  });

  it('is 1 for two constant planes of the same value', () => {
    const a = new Float64Array(32 * 32).fill(128);
    const b = new Float64Array(32 * 32).fill(128);
    expect(ssimPlane(a, b, 32, 32)).toBeCloseTo(1, 12);
  });

  it('drops sharply for uncorrelated noise', () => {
    const n = 64 * 64;
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const ra = mulberry32(1), rb = mulberry32(2);
    for (let i = 0; i < n; i++) { a[i] = ra() * 255; b[i] = rb() * 255; }
    expect(ssimPlane(a, b, 64, 64)).toBeLessThan(0.05);
  });

  it('degrades monotonically with added noise', () => {
    const n = 64 * 64;
    const base = new Float64Array(n);
    for (let i = 0; i < n; i++) base[i] = 128 + 60 * Math.sin(i / 37);

    const noisy = (amount: number) => {
      const rand = mulberry32(9);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = base[i] + (rand() - 0.5) * amount;
      return ssimPlane(base, out, 64, 64);
    };

    expect(noisy(5)).toBeGreaterThan(noisy(20));
    expect(noisy(20)).toBeGreaterThan(noisy(80));
  });

  it('handles images smaller than the default window', () => {
    const a = new Float64Array(5 * 5).fill(10);
    expect(ssimPlane(a, a.slice(), 5, 5)).toBeCloseTo(1, 10);
  });
});

describe('compareImages', () => {
  it('reports infinite PSNR and lossless for identical images', () => {
    const img = photoLike(32, 32);
    const report = compareImages(img, { ...img, data: img.data.slice() });
    expect(report.lossless).toBe(true);
    expect(report.psnr).toBe(Infinity);
    expect(report.exactRatio).toBe(1);
    expect(report.deltaE.max).toBe(0);
  });

  it('matches the closed-form PSNR for a known uniform error', () => {
    const a = createImage(16, 16);
    const b = createImage(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        setPixel(a, x, y, 100, 100, 100, 255);
        setPixel(b, x, y, 110, 110, 110, 255);
      }
    }
    // Three channels differ by 10, alpha matches: MSE = (3 * 100) / 4 = 75.
    const report = compareImages(a, b);
    expect(report.mse).toBeCloseTo(75, 10);
    expect(report.psnr).toBeCloseTo(10 * Math.log10(65025 / 75), 10);
    expect(report.maxChannelDiff).toBe(10);
  });

  /**
   * Colour stored under zero alpha is invisible, so two images that render
   * identically must measure identically. Comparing raw bytes would report a
   * large error for a difference nobody can see.
   */
  it('ignores colour beneath fully transparent pixels', () => {
    const a = createImage(8, 8);
    const b = createImage(8, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        setPixel(a, x, y, 255, 0, 0, 0);
        setPixel(b, x, y, 0, 0, 255, 0);
      }
    }
    expect(compareImages(a, b, { alphaMode: 'premultiplied' }).lossless).toBe(true);
    expect(compareImages(a, b, { alphaMode: 'straight' }).lossless).toBe(false);
  });

  it('refuses to compare mismatched sizes', () => {
    expect(() => compareImages(createImage(4, 4), createImage(4, 5))).toThrow(/different sizes/);
  });

  it('reports CIEDE2000 statistics in a sane order', () => {
    const a = photoLike(48, 48, 1);
    const b = photoLike(48, 48, 2);
    const report = compareImages(a, b);
    expect(report.deltaE.mean).toBeLessThanOrEqual(report.deltaE.p95 + 1e-9);
    expect(report.deltaE.p95).toBeLessThanOrEqual(report.deltaE.max + 1e-9);
    expect(report.deltaE.max).toBeGreaterThan(0);
  });
});

describe('premultiply', () => {
  it('zeroes colour under zero alpha and leaves opaque pixels alone', () => {
    const img = createImage(2, 1);
    setPixel(img, 0, 0, 200, 100, 50, 0);
    setPixel(img, 1, 0, 200, 100, 50, 255);
    const out = premultiply(img);
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(out.slice(4, 8))).toEqual([200, 100, 50, 255]);
  });

  it('scales colour by alpha', () => {
    const img = createImage(1, 1);
    setPixel(img, 0, 0, 200, 100, 50, 128);
    const out = premultiply(img);
    expect(out[0]).toBe(Math.round(200 * (128 / 255)));
  });
});
