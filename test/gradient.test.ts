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

/** A radial vignette — bright centre to dark edge, the case a radial gradient
 * should reconstruct. Few colours so the flat bands are visibly coarse. */
function vignette(s: number): RasterImage {
  const img = createImage(s, s);
  const c = (s - 1) / 2;
  const rMax = Math.hypot(c, c);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t = Math.min(1, Math.hypot(x - c, y - c) / rMax);
      setPixel(img, x, y, Math.round(250 - 210 * t), Math.round(240 - 200 * t), Math.round(255 - 120 * t));
    }
  }
  return img;
}

/** Every `url(#id)` fill must resolve to a gradient (linear or radial) in `<defs>`. */
function referencesResolve(svg: string): boolean {
  const ids = new Set(Array.from(svg.matchAll(/<(?:linear|radial)Gradient id="([^"]+)"/g), (m) => m[1]));
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

  it('reconstructs a vignette as a radial gradient, not a linear one', async () => {
    const img = vignette(90);
    const out = trace(img, { colors: 8, gradients: true });
    expect(out.svg).toContain('<radialGradient');
    expect(out.svg).not.toContain('<linearGradient'); // a symmetric ramp is not linear
    expect(out.svg).toContain('gradientUnits="userSpaceOnUse"');
    expect(referencesResolve(out.svg)).toBe(true);
  });

  it('the radial gradient beats the flat bands it replaces, and is far smaller', async () => {
    const { rasterizeSvg } = await import('../src/io/rasterize.js');
    const { compareImages } = await import('../src/metrics/index.js');
    const img = vignette(90);
    const grad = trace(img, { colors: 8, gradients: true });
    const flat = trace(img, { colors: 8 });
    const g = await rasterizeSvg(grad.svg, { width: 90 });
    const f = await rasterizeSvg(flat.svg, { width: 90 });
    expect(compareImages(img, g.image).ssim).toBeGreaterThan(compareImages(img, f.image).ssim);
    expect(grad.svg.length).toBeLessThan(flat.svg.length / 2);
  });

  // The bug this guards: acceptance used to compare the gradient's error against
  // the flat bands' error directly. A ramp cut into many bands is a far richer
  // model than one linear gradient, so the bands essentially always won and the
  // ramp shipped as dozens of slivers. The comparison is now size-aware, so a
  // ramp is still recognised as a ramp when the palette is large.
  it('reconstructs a ramp even when the flat alternative has many bands', () => {
    const img = ramp(120, 60);
    const many = trace(img, { colors: 48, gradients: true });
    expect(many.svg).toContain('<linearGradient');
    expect(referencesResolve(many.svg)).toBe(true);
    // The win is structural: one paint instead of a stack of bands.
    const flat = trace(img, { colors: 48 });
    const fills = (s: string) => new Set(s.match(/fill="#[0-9a-f]{3,6}"/g) ?? []).size;
    expect(fills(many.svg)).toBeLessThan(fills(flat.svg));
    expect(many.svg.length).toBeLessThan(flat.svg.length);
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
