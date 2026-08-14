import { describe, expect, it } from 'vitest';
import { faviconSet } from '../src/pipelines/favicon.js';
import { responsiveSet } from '../src/pipelines/responsive.js';
import { blurHash, lqipSvg } from '../src/placeholder/index.js';
import { extractPalette, paletteToCssVars } from '../src/vectorize/quantize.js';
import { flatArtwork, photoLike } from './fixtures.js';

/**
 * The asset pipelines: favicon/PWA sets, responsive variants, lazy placeholders,
 * palette extraction. These are orchestration over primitives graver already
 * tests, so the checks are on the shape of what they produce.
 */

describe('faviconSet', () => {
  it('produces the ico, PNG icons and a valid manifest', async () => {
    const set = await faviconSet(flatArtwork(256, 256), { name: 'My App' });
    const names = set.files.map((f) => f.name);
    expect(names).toContain('favicon.ico');
    expect(names).toContain('apple-touch-icon.png');
    expect(names).toContain('icon-192.png');
    expect(names).toContain('icon-512.png');
    expect(names).toContain('manifest.webmanifest');

    // The .ico carries the ICO signature (reserved=0, type=1).
    const ico = set.files.find((f) => f.name === 'favicon.ico')!.bytes;
    expect([ico[0], ico[1], ico[2], ico[3]]).toEqual([0, 0, 1, 0]);

    expect(set.manifest.name).toBe('My App');
    expect(Array.isArray(set.manifest.icons)).toBe(true);
    expect(set.html).toContain('rel="manifest"');
    expect(set.html).toContain('apple-touch-icon');
  });
});

describe('responsiveSet', () => {
  it('emits a variant per width×format, never upscaling, with <picture> markup', async () => {
    const set = await responsiveSet(flatArtwork(800, 600), {
      widths: [320, 640, 1280], formats: ['webp', 'jpeg'], name: 'hero', alt: 'A hero',
    });
    // 1280 > 800 is dropped; 320 and 640 remain × 2 formats = 4 variants.
    expect(set.variants.length).toBe(4);
    expect(set.variants.every((v) => v.width <= 800)).toBe(true);
    expect(set.html).toContain('<picture>');
    expect(set.html).toContain('type="image/webp"');
    expect(set.html).toContain('srcset=');
    expect(set.html).toContain('alt="A hero"');
  });
});

describe('blurHash', () => {
  it('encodes to a spec-length string', () => {
    const hash = blurHash(photoLike(64, 48), 4, 3);
    // length = 1 (size) + 1 (max) + 4 (dc) + 2·(cx·cy − 1) AC = 28 for 4×3
    expect(hash).toHaveLength(28);
    // every char is base83
    expect(hash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/);
  });

  it('varies with content', () => {
    expect(blurHash(photoLike(32, 32, 1))).not.toEqual(blurHash(flatArtwork(32, 32)));
  });
});

describe('lqipSvg', () => {
  it('produces a tiny self-contained SVG', () => {
    const svg = lqipSvg(photoLike(200, 150));
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg.length).toBeLessThan(4000); // a placeholder, not a full trace
  });
});

describe('extractPalette', () => {
  it('returns weighted, hex-formatted entries most-used first', () => {
    const palette = extractPalette(flatArtwork(120, 90), 5);
    expect(palette.length).toBeGreaterThan(0);
    expect(palette.length).toBeLessThanOrEqual(5);
    for (const e of palette) expect(e.hex).toMatch(/^#[0-9a-f]{3,6}$/);
    // sorted descending by weight
    for (let i = 1; i < palette.length; i++) {
      expect(palette[i - 1].weight).toBeGreaterThanOrEqual(palette[i].weight);
    }
    const total = palette.reduce((s, e) => s + e.weight, 0);
    expect(total).toBeGreaterThan(0.99);
    expect(total).toBeLessThan(1.01);
  });

  it('renders CSS custom properties', () => {
    const css = paletteToCssVars(extractPalette(flatArtwork(60, 40), 3));
    expect(css).toContain(':root {');
    expect(css).toContain('--color-1:');
  });
});
