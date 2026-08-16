import { describe, expect, it } from 'vitest';
import { optimizeSvg } from '../src/svg/optimize.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';

const MESSY =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generator: Some Tool -->\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">\n' +
  '    <path fill="#e4002b" fill-opacity="1" fill-rule="nonzero" d="M10.123456 20.987654 L80.111111 20.5 L80.0 80.999 Z"/>\n' +
  '    <circle cx="50.5000" cy="50.25" r="10.333333" fill="#3060a0"/>\n' +
  '</svg>';

describe('optimizeSvg', () => {
  it('strips prologue, comments and default attributes', () => {
    const out = optimizeSvg(MESSY);
    expect(out).not.toContain('<?xml');
    expect(out).not.toContain('Generator');
    expect(out).not.toContain('fill-opacity="1"');
    expect(out).not.toContain('fill-rule="nonzero"');
  });

  it('collapses inter-tag whitespace and rounds coordinates to precision', () => {
    const out = optimizeSvg(MESSY, { precision: 2 });
    expect(out).toContain('10.12'); // 10.123456 → 10.12
    expect(out).not.toContain('10.123456');
    expect(out).not.toMatch(/>\s+</); // no whitespace between tags
  });

  it('shrinks the file substantially', () => {
    const out = optimizeSvg(MESSY);
    expect(out.length).toBeLessThan(MESSY.length * 0.75);
  });

  it('is render-preserving', async () => {
    const before = await rasterizeSvg(MESSY, { width: 100 });
    const after = await rasterizeSvg(optimizeSvg(MESSY), { width: 100 });
    expect(compareImages(before.image, after.image).ssim).toBeGreaterThan(0.999);
  });

  it('is idempotent', () => {
    const once = optimizeSvg(MESSY);
    expect(optimizeSvg(once)).toEqual(once);
  });

  it('preserves gradient defs (linear and radial) render-identically', async () => {
    const withGrad =
      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">' +
      '<defs>' +
      '<linearGradient id="a" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="60" y2="0">' +
      '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
      '<radialGradient id="b" gradientUnits="userSpaceOnUse" cx="30" cy="30" r="30">' +
      '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#123"/></radialGradient>' +
      '</defs>' +
      '<rect width="30" height="60" fill="url(#a)"/><rect x="30" width="30" height="60" fill="url(#b)"/></svg>';
    const out = optimizeSvg(withGrad);
    expect(out).toContain('<radialGradient');
    expect(out).toContain('<linearGradient');
    expect((out.match(/<stop/g) ?? [])).toHaveLength(4);
    const before = await rasterizeSvg(withGrad, { width: 60 });
    const after = await rasterizeSvg(out, { width: 60 });
    expect(compareImages(before.image, after.image).ssim).toBeGreaterThan(0.999);
  });

  /**
   * Path data may omit the delimiter between two numbers whenever the second
   * cannot be read as part of the first, so `l12.004.513` is two numbers. The
   * minifier used to round every decimal with a context-free regex, which
   * turned `12.004` into `12` and destroyed the `.` that was doing the
   * separating — leaving `12` and `0.51` fused into `120.51`. The result was
   * still well-formed XML describing a completely different path, which is why
   * nothing downstream ever objected.
   */
  describe('implicit separators in path data', () => {
    it('keeps two abutting numbers apart when rounding removes the separator', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
        '<path d="M1 1l12.004.513z"/></svg>';
      const d = optimizeSvg(svg).match(/d="([^"]*)"/)![1];

      // The old output was "M1 1l120.51z" — one number where there were two.
      expect(d).not.toContain('120.51');
      const nums = d.match(/-?(?:\d+\.?\d*|\.\d+)/g)!.map(Number);
      expect(nums).toEqual([1, 1, 12, 0.51]);
    });

    it('does not waste a separator before a negative number', () => {
      // A leading '-' delimits by itself, so compactness must not regress.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
        '<path d="M0 0l-1.005-2.5.75z"/></svg>';
      const d = optimizeSvg(svg).match(/d="([^"]*)"/)![1];
      expect(d).toContain('-1-2.5');
      expect(d.match(/-?(?:\d+\.?\d*|\.\d+)/g)!.map(Number)).toEqual([0, 0, -1, -2.5, 0.75]);
    });

    it('renders identically to the source, which is the whole promise', async () => {
      // Chained compact pairs, at a size where a fused coordinate would throw
      // the geometry far enough off to show up in the comparison.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
        '<path d="M2 2l30.004.513-8.75 30.125-20.5-4.004z" fill="#2b7"/></svg>';
      const out = optimizeSvg(svg);
      const before = await rasterizeSvg(svg, { width: 40 });
      const after = await rasterizeSvg(out, { width: 40 });
      expect(compareImages(before.image, after.image).ssim).toBeGreaterThan(0.999);
    });

    it('rounds numbers inside transform and viewBox without fusing them', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12.004 8.006" width="20" height="20">' +
        '<g transform="translate(3.004.517)"><path d="M0 0h1z"/></g></svg>';
      const out = optimizeSvg(svg);
      expect(out).toMatch(/viewBox="0 0 12 8\.01"/);
      const t = out.match(/transform="([^"]*)"/)![1];
      expect(t.match(/-?(?:\d+\.?\d*|\.\d+)/g)!.map(Number)).toEqual([3, 0.52]);
    });
  });
});
