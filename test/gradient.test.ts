import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { detectGradients, GRAD_BASE } from '../src/vectorize/gradient.js';
import { quantize, quantizeAlpha, NearestColor } from '../src/vectorize/quantize.js';
import { createImage, setPixel, flatArtwork, pixelArt } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * Gradient output has two contracts that matter more than any quality number:
 * it must be byte-for-byte invisible on flat art, and it must never emit a
 * dangling reference. The quality win itself is measured by the benchmark, not
 * asserted here.
 */

/** A clean horizontal ramp — the case a gradient should reconstruct. */
function ramp(w: number, h: number): RasterImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      setPixel(img, x, y, Math.round(20 + 200 * t), Math.round(60 + 120 * t), Math.round(200 - 160 * t));
    }
  }
  return img;
}

/** Every `url(#id)` fill must resolve to a gradient defined in `<defs>`. */
function referencesResolve(svg: string): boolean {
  const ids = new Set(Array.from(svg.matchAll(/<linearGradient id="([^"]+)"/g), (m) => m[1]));
  const refs = Array.from(svg.matchAll(/fill="url\(#([^)]+)\)"/g), (m) => m[1]);
  return refs.length > 0 && refs.every((r) => ids.has(r));
}

describe('gradient output', () => {
  it('is off by default', () => {
    expect(trace(ramp(80, 40), { colors: 16 }).svg).not.toContain('<linearGradient');
  });

  it('reconstructs a smooth ramp as a linear gradient', () => {
    const svg = trace(ramp(80, 40), { colors: 16, gradients: true }).svg;
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('gradientUnits="userSpaceOnUse"');
    expect((svg.match(/<stop /g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('never emits a gradient reference without its definition', () => {
    const svg = trace(ramp(80, 40), { colors: 16, gradients: true }).svg;
    expect(referencesResolve(svg)).toBe(true);
  });

  it('emits <defs> only when a gradient is present', () => {
    expect(trace(ramp(80, 40), { colors: 16, gradients: true }).svg).toContain('<defs>');
    expect(trace(pixelArt(4), { colors: 16, gradients: true }).svg).not.toContain('<defs>');
  });

  // The load-bearing safety property: on flat art, where no gradient can beat a
  // near-zero flat error, the output is byte-for-byte the flat tracer's.
  it.each([
    ['pixel art', () => pixelArt(4)],
    ['flat artwork', () => flatArtwork(80, 60)],
  ])('is byte-identical to the flat tracer on %s', (_name, make) => {
    const src = make();
    expect(trace(src, { colors: 16, gradients: true }).svg).toEqual(trace(src, { colors: 16 }).svg);
  });

  it('leaves a single flat colour completely untouched', () => {
    const solid = createImage(40, 40);
    for (let i = 0; i < 40 * 40; i++) setPixel(solid, i % 40, (i / 40) | 0, 120, 60, 180);
    expect(trace(solid, { colors: 16, gradients: true }).svg).toEqual(trace(solid, { colors: 16 }).svg);
  });
});

describe('detectGradients', () => {
  function classify(img: RasterImage): {
    classes: Int32Array; palette: ReturnType<typeof quantize>; alphaLevels: Uint8Array; levelCount: number;
  } {
    const n = img.width * img.height;
    const alphaLevels = quantizeAlpha(img, 8);
    const palette = quantize(img, 16, {});
    const nearest = new NearestColor(palette, n);
    const levelCount = alphaLevels.length;
    const classes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const aIdx = alphaLevels.length - 1;
      classes[i] = nearest.index(img.data[o], img.data[o + 1], img.data[o + 2]) * levelCount + aIdx;
    }
    return { classes, palette, alphaLevels, levelCount };
  }

  it('accepts a ramp and rewrites its pixels to one synthetic class', () => {
    const img = ramp(80, 40);
    const { classes, palette, alphaLevels, levelCount } = classify(img);
    const before = new Set(classes);
    const g = detectGradients(img, classes, palette, alphaLevels, levelCount, img.width, img.height, {
      gradients: true, gradientMinArea: 0, gradientStepMax: 0.15,
      gradientMargin: 0.1, gradientMaxError: 0.1, gradientStops: 16,
    });
    expect(g.paints.size).toBeGreaterThan(0);
    // The synthetic class is present in the rewritten map and is >= GRAD_BASE.
    const synthetic = [...g.classes].filter((c) => c >= GRAD_BASE);
    expect(synthetic.length).toBeGreaterThan(0);
    // Original flat classes had no synthetic ids.
    expect([...before].some((c) => c >= GRAD_BASE)).toBe(false);
  });

  it('returns the class map unchanged when gradients are off', () => {
    const img = ramp(40, 20);
    const { classes, palette, alphaLevels, levelCount } = classify(img);
    const g = detectGradients(img, classes, palette, alphaLevels, levelCount, img.width, img.height, {
      gradients: false, gradientMinArea: 0, gradientStepMax: 0.08,
      gradientMargin: 0.1, gradientMaxError: 0.1, gradientStops: 16,
    });
    expect(g.classes).toBe(classes);
    expect(g.paints.size).toBe(0);
  });
});
