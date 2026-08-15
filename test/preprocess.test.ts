import { describe, expect, it } from 'vitest';
import { selectiveBlur } from '../src/preprocess.js';
import { applyThreshold, otsuThreshold } from '../src/vectorize/threshold.js';
import { trace } from '../src/vectorize/trace.js';
import { compareImages } from '../src/metrics/index.js';
import { createImage, mulberry32, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/** A left-to-right greyscale ramp, dark to light. */
function ramp(width: number, height = 1): RasterImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x * 255) / (width - 1));
      setPixel(img, x, y, v, v, v, 255);
    }
  }
  return img;
}

/** Two flat halves — the clean bimodal case Otsu should split exactly between. */
function bimodal(width = 40): RasterImage {
  const img = createImage(width, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? 40 : 210;
      setPixel(img, x, y, v, v, v, 255);
    }
  }
  return img;
}

describe('selectiveBlur', () => {
  it('protects a hard edge from bleeding across it', () => {
    // A wide black block meeting a wide white block. An interior pixel two away
    // from the seam sits within the blur radius of the seam; edge preservation
    // must keep it pure rather than let white bleed in.
    const w = 20;
    const img = createImage(w, 1);
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 0 : 255;
      setPixel(img, x, 0, v, v, v, 255);
    }
    const out = selectiveBlur(img, { radius: 2, delta: 20 });
    // Deep inside each block, the value is untouched.
    expect(out.data[0]).toBe(0);
    expect(out.data[(w - 1) * 4]).toBe(255);
  });

  it('smooths a noisy flat field toward its mean', () => {
    const size = 32;
    const img = createImage(size, size);
    const rand = mulberry32(3);
    for (let i = 0; i < size * size; i++) {
      // 128 +/- small noise: a flat grey the blur should calm.
      const v = 128 + Math.round((rand() - 0.5) * 30);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    const out = selectiveBlur(img, { radius: 3, delta: 40 });

    // Variance must drop: the blurred field is closer to uniform than the input.
    const variance = (im: RasterImage) => {
      let mean = 0;
      for (let i = 0; i < size * size; i++) mean += im.data[i * 4];
      mean /= size * size;
      let v = 0;
      for (let i = 0; i < size * size; i++) v += (im.data[i * 4] - mean) ** 2;
      return v / (size * size);
    };
    expect(variance(out)).toBeLessThan(variance(img));
  });

  it('is a no-op below radius 1', () => {
    const img = ramp(10);
    const out = selectiveBlur(img, { radius: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });

  it('returns a fresh buffer, never mutating the input', () => {
    const img = createImage(8, 8);
    for (let i = 0; i < 64; i++) img.data[i * 4 + 3] = 255;
    const before = Array.from(img.data);
    selectiveBlur(img, { radius: 2 });
    expect(Array.from(img.data)).toEqual(before);
  });
});

describe('otsuThreshold', () => {
  it('splits a clean bimodal image between its two populations', () => {
    // Otsu returns the cutoff `t` where {v <= t} is the dark class. For
    // populations at 40 and 210 that is 40: everything <= 40 is one class,
    // everything above is the other. So 40..209 all correctly separate them.
    const t = otsuThreshold(bimodal());
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(210);
    // And it actually separates: thresholding at it yields two colours.
    const out = applyThreshold(bimodal(), { threshold: t }).image;
    expect(out.data[0]).toBe(0);                    // the 40 population → ink
    expect(out.data[(bimodal().width - 1) * 4]).toBe(255); // the 210 population → ground
  });

  it('ignores transparent pixels', () => {
    const img = bimodal();
    // Paint loud black into a transparent border; it must not drag the cutoff.
    for (let x = 0; x < img.width; x++) {
      setPixel(img, x, 0, 0, 0, 0, 0);
    }
    const t = otsuThreshold(img);
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(210);
  });
});

describe('applyThreshold', () => {
  it('makes dark pixels the ink under blackOnWhite', () => {
    const out = applyThreshold(ramp(10), { threshold: 128, blackOnWhite: true }).image;
    expect(out.data[0]).toBe(0);          // darkest → black ink
    expect(out.data[9 * 4]).toBe(255);    // lightest → white ground
  });

  /**
   * Regression: flipping blackOnWhite once swapped both the comparison and the
   * fill colours, which cancelled — a dark pixel came out black either way. The
   * flag must choose *which* pixels are ink, not recolour the ink.
   */
  it('inverts which pixels are ink, and genuinely inverts', () => {
    const bw = applyThreshold(ramp(10), { threshold: 128, blackOnWhite: true }).image;
    const wb = applyThreshold(ramp(10), { threshold: 128, blackOnWhite: false }).image;
    expect(bw.data[0]).not.toBe(wb.data[0]);
    expect(bw.data[9 * 4]).not.toBe(wb.data[9 * 4]);
    // Light pixels are the ink when blackOnWhite is false.
    expect(wb.data[9 * 4]).toBe(0);
  });

  it('produces exactly two colours', () => {
    const out = applyThreshold(ramp(50), { threshold: 'auto' }).image;
    const seen = new Set<number>();
    for (let x = 0; x < 50; x++) seen.add(out.data[x * 4]);
    expect(seen.size).toBe(2);
  });

  it('keeps transparent pixels transparent', () => {
    const img = createImage(4, 1);
    setPixel(img, 0, 0, 10, 10, 10, 0);   // transparent
    setPixel(img, 1, 0, 10, 10, 10, 255); // opaque dark
    const out = applyThreshold(img, { threshold: 128 }).image;
    expect(out.data[3]).toBe(0);          // stayed transparent
    expect(out.data[7]).toBe(255);        // stayed opaque
  });
});

describe('trace preprocessing integration', () => {
  it('produces a two-colour SVG with --threshold', () => {
    const out = trace(ramp(40, 40), { threshold: 'auto', colors: 4 });
    expect(out.colors).toBeLessThanOrEqual(2);
  });

  it('emits stroke attributes when strokeWidth is set', () => {
    const img = createImage(30, 30);
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        setPixel(img, x, y, x < 15 ? 200 : 40, 100, 150, 255);
      }
    }
    const out = trace(img, { colors: 4, strokeWidth: 1 });
    expect(out.svg).toMatch(/stroke="#[0-9a-f]/);
    expect(out.svg).toContain('stroke-width="1"');
  });

  it('blur reduces speckle regions on noisy input', () => {
    const size = 48;
    const img = createImage(size, size);
    const rand = mulberry32(7);
    for (let i = 0; i < size * size; i++) {
      const base = i % size < size / 2 ? 90 : 170;
      const v = base + Math.round((rand() - 0.5) * 50);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    const noBlur = trace(img, { colors: 8, minArea: 0 });
    const blurred = trace(img, { colors: 8, minArea: 0, blur: 3 });
    expect(blurred.regions).toBeLessThanOrEqual(noBlur.regions);
  });

  // The case a single global cutoff cannot serve: a photograph of paper where one
  // corner is in shadow. Ink is a constant fraction below its OWN local paper, so
  // shadowed ink is brighter than lit paper — and no global number separates them.
  it('adaptive thresholding recovers ink a global cutoff loses to shadow', () => {
    const W = 240, H = 160;
    const img = createImage(W, H);
    const isInk = (x: number, y: number): boolean => y % 28 < 3 && x > 20 && x < W - 20;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const light = 245 - 165 * ((x / W) * 0.45 + (y / H) * 0.55);
        const v = Math.round(isInk(x, y) ? light * 0.65 : light);
        setPixel(img, x, y, v, v, v);
      }
    }
    const recall = (out: RasterImage): number => {
      let hit = 0, total = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!isInk(x, y)) continue;
        total++;
        if (out.data[(y * W + x) * 4] < 128) hit++;
      }
      return hit / total;
    };
    const precision = (out: RasterImage): number => {
      let hit = 0, marked = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (out.data[(y * W + x) * 4] >= 128) continue;
        marked++;
        if (isInk(x, y)) hit++;
      }
      return marked === 0 ? 0 : hit / marked;
    };
    const global = applyThreshold(img, { threshold: 'auto' }).image;
    const local = applyThreshold(img, { threshold: 'auto', adaptive: true }).image;
    // The global cutoff floods the shadowed end: it marks far more than the ink.
    expect(precision(global)).toBeLessThan(0.5);
    // Adaptive finds essentially all of the ink and almost nothing else.
    expect(recall(local)).toBeGreaterThan(0.95);
    expect(precision(local)).toBeGreaterThan(0.9);
  });

  it('leaves evenly-lit art to Otsu — adaptive is opt-in', () => {
    const flat = bimodal();
    const off = applyThreshold(flat, { threshold: 'auto' }).image;
    expect(applyThreshold(flat, { threshold: 'auto' }).image.data).toEqual(off.data);
  });
});

describe('speckle scope', () => {
  it('spares antialiasing fringe and takes only isolated specks', async () => {
    const { quantize, NearestColor } = await import('../src/vectorize/quantize.js');
    const { connectedComponents, despeckle } = await import('../src/vectorize/components.js');
    const W = 90, H = 90;
    const img = createImage(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Left half dark, right half light: the vertical seam between them is
        // where fringe lives. Plus isolated specks well inside each field.
        const dark = x < W / 2;
        let v = dark ? 40 : 220;
        if (x === Math.floor(W / 2) && y % 2 === 0) v = 130;          // fringe on the seam
        if ((x === 12 || x === 70) && y % 9 === 0) v = dark ? 200 : 50; // isolated specks
        setPixel(img, x, y, v, v, v);
      }
    }
    const n = W * H;
    const pal = quantize(img, 8, {});
    const near = new NearestColor(pal, n);
    const base = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      base[i] = near.index(img.data[o], img.data[o + 1], img.data[o + 2]);
    }
    const run = (scope: 'all' | 'isolated'): number => {
      const cls = Int32Array.from(base);
      const comps = connectedComponents(cls, W, H, -1);
      return despeckle(cls, comps, W, H, 6, -1, scope);
    };
    const all = run('all');
    const isolated = run('isolated');
    // Both remove something, but `isolated` is strictly more conservative: it
    // declines the fringe components sitting between the two fields.
    expect(all).toBeGreaterThan(0);
    expect(isolated).toBeGreaterThan(0);
    expect(isolated).toBeLessThan(all);
  });

  it('defaults to `all`, so existing output is unchanged', async () => {
    const { trace } = await import('../src/vectorize/trace.js');
    const img = createImage(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) setPixel(img, x, y, x < 20 ? 30 : 220, 100, 150);
    expect(trace(img, { colors: 8, minArea: 6 }).svg)
      .toEqual(trace(img, { colors: 8, minArea: 6, speckleScope: 'all' }).svg);
  });
});
