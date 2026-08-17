import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { detectGradients, GRAD_BASE } from '../src/vectorize/gradient.js';
import { quantize, quantizeAlpha, NearestColor, type Palette } from '../src/vectorize/quantize.js';
import { createImage, setPixel, flatArtwork, pixelArt } from './fixtures.js';
import { srgbToOklab } from '../src/color.js';
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

/**
 * The impossibility bound.
 *
 * A rendered gradient's colour at a pixel is a function of its position along
 * the ramp and nothing else, so two pixels at the same offset are painted the
 * same colour whatever stops are chosen. The error of *any* stop list is
 * therefore bounded below by how much the source colours themselves disagree at
 * equal offset — the conditional mean is the best a function of the offset can
 * do, and its error is the within-bin variance.
 *
 * When that bound already exceeds `gradientMaxError`, no stop list can bring
 * the region under the ceiling, so the module stops before rendering and
 * scoring every pixel twice. These tests pin both directions, because a bound
 * that is merely fast is worthless: it has to reject exactly what the gate
 * would have rejected and nothing else.
 */
describe('gradient impossibility bound', () => {
  const ramp = (w: number, h: number, noise = 0): RasterImage => {
    const img = createImage(w, h);
    let s = 1;
    const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = y / h;
        const n = noise ? (rnd() - 0.5) * noise : 0;
        setPixel(img, x, y,
          Math.max(0, Math.min(255, Math.round(30 + 150 * t + n))),
          Math.max(0, Math.min(255, Math.round(90 + 120 * t + n))),
          Math.max(0, Math.min(255, Math.round(200 - 30 * t + n))));
      }
    }
    return img;
  };

  /** Colour noise with no ramp structure at all — the photograph analogue. */
  const noiseField = (w: number, h: number): RasterImage => {
    const img = createImage(w, h);
    let s = 7;
    const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        setPixel(img, x, y, Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256));
      }
    }
    return img;
  };

  const gradientsIn = (svg: string): number => (svg.match(/<(linear|radial)Gradient/g) ?? []).length;

  it('still finds a ramp that a gradient genuinely fits', () => {
    // The bound must not cost the feature its purpose. This is the case the
    // module exists for.
    const out = trace(ramp(160, 120), { colors: 32, gradients: true });
    expect(gradientsIn(out.svg)).toBeGreaterThan(0);
  });

  it('still finds a ramp carrying noise', () => {
    // Near the ceiling rather than far from it — the case where a bound that
    // was slightly too eager would silently start rejecting real gradients.
    const out = trace(ramp(160, 120, 10), { colors: 32, gradients: true });
    expect(gradientsIn(out.svg)).toBeGreaterThan(0);
  });

  it('emits nothing for a region no ramp can model', () => {
    const out = trace(noiseField(120, 90), { colors: 32, gradients: true });
    expect(gradientsIn(out.svg)).toBe(0);
  });

  it('is byte-identical to the flat tracer when nothing is accepted', () => {
    // The property the module has always promised, and the one the bound must
    // not quietly break: refusing earlier must produce the same file as
    // refusing later.
    const img = noiseField(120, 90);
    const withGradients = trace(img, { colors: 32, gradients: true });
    const flat = trace(img, { colors: 32, gradients: false });
    expect(withGradients.svg).toBe(flat.svg);
  });
});

describe('NearestColor direct-indexed table', () => {
  /** A palette of exactly `count` distinct colours, spread over the cube. */
  function paletteOf(count: number): Palette {
    const rgb = new Uint8Array(count * 3);
    const lab = new Float64Array(count * 3);
    const scratch = new Float64Array(3);
    for (let c = 0; c < count; c++) {
      // Bit-reversed spread so consecutive indices are far apart perceptually,
      // which stops the "nearest" answer being trivially the previous index.
      const v = ((c * 2654435761) >>> 0) % 0xffffff;
      const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
      rgb[c * 3] = r; rgb[c * 3 + 1] = g; rgb[c * 3 + 2] = b;
      srgbToOklab(r, g, b, scratch);
      lab[c * 3] = scratch[0]; lab[c * 3 + 1] = scratch[1]; lab[c * 3 + 2] = scratch[2];
    }
    return { rgb, lab, count };
  }

  // Above the 250 000-pixel threshold, so the table is used rather than the Map.
  const BIG = 300_000;

  // 255 takes the byte table; 256 is the boundary that forces the 16-bit one,
  // because a byte has no value left over for "unresolved" once every index is
  // in use. Both widths must answer identically.
  for (const count of [2, 16, 255, 256]) {
    it(`agrees with a linear scan at ${count} colours, on both miss and hit`, () => {
      const palette = paletteOf(count);
      const near = new NearestColor(palette, BIG);
      const scratch = new Float64Array(3);

      const brute = (r: number, g: number, b: number): number => {
        srgbToOklab(r, g, b, scratch);
        let best = 0, bestD = Infinity;
        for (let c = 0; c < count; c++) {
          const dL = scratch[0] - palette.lab[c * 3];
          const dA = scratch[1] - palette.lab[c * 3 + 1];
          const dB = scratch[2] - palette.lab[c * 3 + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bestD) { bestD = d; best = c; }
        }
        return best;
      };

      const seen = new Set<number>();
      for (let i = 0; i < 4096; i++) {
        const v = ((i * 2246822519) >>> 0) % 0xffffff;
        const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
        const first = near.index(r, g, b);   // cache miss: computes and stores
        const second = near.index(r, g, b);  // cache hit: reads back what it stored
        expect(first).toBe(brute(r, g, b));
        // The encoding's real failure mode is silent: a sentinel that collides
        // with a valid index makes the stored value unreadable, so the hit path
        // disagrees with the miss path. Every index must survive the round trip.
        expect(second).toBe(first);
        seen.add(first);
      }
      // Guard the guard: a palette this size must actually exercise a spread of
      // indices, or the round-trip assertion above proves very little.
      expect(seen.size).toBeGreaterThan(Math.min(count, 8) / 2);
    });
  }

  it('caches the top palette index, which a byte-wide table could not', () => {
    // The failure this guards against is invisible through the return value. If
    // the sentinel collided with a real index, that entry would read back as
    // "unresolved" and quietly re-run the linear scan on every pixel of that
    // colour — the right answer, at 256x the cost. So assert cacheability, not
    // correctness: `search()` is the only thing that reads `palette.count`, so
    // counting reads of it counts scans.
    let scans = 0;
    const base = paletteOf(256);
    const probe: Palette = {
      rgb: base.rgb,
      lab: base.lab,
      get count(): number { scans++; return base.count; },
    };
    const near = new NearestColor(probe, BIG);

    // 255 is the highest index a 256-entry palette can return, and the exact
    // value a byte table would have to spend on its sentinel.
    const r = base.rgb[255 * 3], g = base.rgb[255 * 3 + 1], b = base.rgb[255 * 3 + 2];
    expect(near.index(r, g, b)).toBe(255);

    scans = 0;
    expect(near.index(r, g, b)).toBe(255);
    expect(scans).toBe(0); // a second look must be a table read, not a rescan
  });
});
