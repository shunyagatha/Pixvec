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

describe('ssimPlane border/interior split', () => {
  /**
   * The convolution as it was written before the border and interior were
   * separated: every tap clamped, no special cases. Kept here deliberately as
   * an oracle — the split is only worth having if it computes exactly this, and
   * "exactly" is the right word, because SSIM is the number this project
   * publishes and re-measures in CI. A drift too small for `toBeCloseTo` is
   * still a drift in a printed figure.
   */
  function referenceSsim(x: Float64Array, y: Float64Array, width: number, height: number): number {
    const minDim = Math.min(width, height);
    let win = 11;
    if (minDim < win) win = minDim % 2 === 0 ? minDim - 1 : minDim;
    const radius = (win - 1) / 2;

    const kernel = new Float64Array(radius * 2 + 1);
    let ksum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * 1.5 * 1.5));
      kernel[i + radius] = v; ksum += v;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

    const n = width * height;
    const blur = (src: Float64Array): Float64Array => {
      const tmp = new Float64Array(n), dst = new Float64Array(n);
      for (let py = 0; py < height; py++) {
        const row = py * width;
        for (let px = 0; px < width; px++) {
          let acc = 0;
          for (let t = -radius; t <= radius; t++) {
            let sx = px + t;
            if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
            acc += src[row + sx] * kernel[t + radius];
          }
          tmp[row + px] = acc;
        }
      }
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          let acc = 0;
          for (let t = -radius; t <= radius; t++) {
            let sy = py + t;
            if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
            acc += tmp[sy * width + px] * kernel[t + radius];
          }
          dst[py * width + px] = acc;
        }
      }
      return dst;
    };

    const xx = new Float64Array(n), yy = new Float64Array(n), xy = new Float64Array(n);
    for (let i = 0; i < n; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
    const muX = blur(x), muY = blur(y), sXX = blur(xx), sYY = blur(yy), sXY = blur(xy);

    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let total = 0, count = 0;
    for (let py = radius; py < height - radius; py++) {
      for (let px = radius; px < width - radius; px++) {
        const i = py * width + px;
        const mx = muX[i], my = muY[i];
        const mx2 = mx * mx, my2 = my * my, mxy = mx * my;
        total += ((2 * mxy + C1) * (2 * (sXY[i] - mxy) + C2))
          / ((mx2 + my2 + C1) * ((sXX[i] - mx2) + (sYY[i] - my2) + C2));
        count++;
      }
    }
    return count > 0 ? total / count : 1;
  }

  // Shapes chosen to exercise the split from both sides: square with a large
  // interior, strips thinner than the 11-wide window in one axis (so that axis
  // is *all* border), and one small enough that the window itself shrinks.
  const SHAPES: Array<[number, number]> = [[64, 64], [97, 41], [41, 97], [8, 40], [40, 8], [5, 5], [12, 12]];

  for (const [w, h] of SHAPES) {
    it(`matches the fully clamped reference exactly at ${w}x${h}`, () => {
      const n = w * h;
      const a = new Float64Array(n), b = new Float64Array(n);
      const ra = mulberry32(w * 31 + h), rb = mulberry32(h * 17 + w);
      for (let i = 0; i < n; i++) {
        a[i] = Math.floor(ra() * 256);
        // Correlated, not independent: an SSIM near zero would pass this test
        // for the wrong reason, since both sides would agree on "no structure".
        b[i] = Math.min(255, Math.max(0, a[i] + (rb() - 0.5) * 40));
      }
      const got = ssimPlane(a, b, w, h);
      expect(got).toBe(referenceSsim(a, b, w, h));
      // Guard the guard: a degenerate score would make equality meaningless.
      expect(got).toBeGreaterThan(0.1);
      expect(got).toBeLessThan(0.999);
    });
  }
});
