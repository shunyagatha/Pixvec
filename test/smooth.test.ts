import { describe, expect, it } from 'vitest';
import { smoothPreservingEdges, iterationsFor, interiorNoiseOf } from '../src/vectorize/smooth.js';
import { vectorize, PRESETS } from '../src/api.js';
import { createImage, mulberry32, setPixel } from './fixtures.js';

/** Two flat halves with a hard edge, plus optional per-pixel grain. */
function halves(grain: number) {
  const img = createImage(48, 48);
  const rand = mulberry32(9);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const base = x < 24 ? 70 : 200;
      const n = grain === 0 ? 0 : Math.round((rand() * 2 - 1) * grain);
      setPixel(img, x, y, base + n, base + n, base + n, 255);
    }
  }
  return img;
}
const at = (img: ReturnType<typeof halves>, x: number, y: number) => img.data[(y * img.width + x) * 4];

describe('smoothPreservingEdges', () => {
  it('flattens a grainy interior', () => {
    const noisy = halves(30);
    const out = smoothPreservingEdges(noisy, 1, { iterations: 20 });
    // Spread within one flat half collapses.
    const spread = (img: typeof noisy) => {
      let lo = 255, hi = 0;
      for (let y = 8; y < 40; y++) for (let x = 4; x < 20; x++) { const v = at(img, x, y); if (v < lo) lo = v; if (v > hi) hi = v; }
      return hi - lo;
    };
    expect(spread(out)).toBeLessThan(spread(noisy) / 2);
  });

  it('does not walk the edge across the boundary', () => {
    // The whole point: a Gaussian would bleed the two halves together. Column 23
    // must stay dark and column 24 light.
    const out = smoothPreservingEdges(halves(30), 1, { iterations: 20 });
    expect(at(out, 20, 24)).toBeLessThan(110);
    expect(at(out, 27, 24)).toBeGreaterThan(160);
  });

  it('returns the input untouched at strength 0', () => {
    const img = halves(30);
    expect(smoothPreservingEdges(img, 0)).toBe(img);
  });

  // Asserts the PROPERTY, not the line that appears to implement it: the `c < 3`
  // bound in the diffusion loop is what enforces this, and the explicit alpha copy
  // below it is redundant. Mutation-testing that copy produced no failure, which is
  // the honest reason this comment exists.
  it('never diffuses alpha, because that would move the silhouette', () => {
    const img = createImage(32, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const inside = (x - 16) ** 2 + (y - 16) ** 2 < 100;
      setPixel(img, x, y, 200, 30, 30, inside ? 255 : 0);
    }
    const out = smoothPreservingEdges(img, 1, { iterations: 12 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(img.data[i]);
  });
});

describe('iterationsFor scales the work by measured noise', () => {
  it('spends nothing on a clean image', () => {
    // A clean source has nothing to remove, so smoothing it only eats real detail:
    // logo-tux measured 0.77x bytes for -0.09 SSIM when forced. See smooth.ts.
    expect(iterationsFor(interiorNoiseOf(halves(0)), 1)).toBe(0);
    expect(iterationsFor(0.2, 1)).toBe(0);
  });

  it('spends more as noise rises, and saturates', () => {
    const a = iterationsFor(0.6, 1);
    const b = iterationsFor(1.5, 1);
    const c = iterationsFor(5.0, 1);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThanOrEqual(b);
    expect(c).toBeLessThanOrEqual(24);
  });

  it('is zero at strength 0 however noisy the source', () => {
    expect(iterationsFor(5.0, 0)).toBe(0);
  });
});

describe('the refinement noise gate reaches explicitly chosen presets', () => {
  /**
   * `autoTracePreset` both picks a palette and decides whether the source is clean
   * enough to refine. Choosing any explicit preset replaced the whole thing, so
   * `--preset poster` on a noisy source got refinement the measurement exists to
   * prevent — and `latticeSimplify` defaults to `!subpixel`, so it got simplification
   * too. On the reported sticker that was 28,136 bytes against 8,797.
   */
  const noisy = () => {
    const img = createImage(64, 64);
    const rand = mulberry32(3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const base = (x - 32) ** 2 + (y - 32) ** 2 < 400 ? 60 : 210;
      const n = Math.round((rand() * 2 - 1) * 40);
      setPixel(img, x, y, base + n, base + n, base + n, 255);
    }
    return img;
  };

  it('a preset with no opinion on subpixel gets the measured answer', async () => {
    const img = noisy();
    const gated = await vectorize({ image: img }, { mode: 'trace', preset: 'poster', noGenerator: true });
    const forced = await vectorize(
      { image: img },
      { mode: 'trace', preset: 'poster', trace: { subpixel: true }, noGenerator: true },
    );
    // Refinement on a noisy source costs geometry; the gate is what avoids it.
    expect(gated.svg.length).toBeLessThan(forced.svg.length);
  });

  it('a preset that states an opinion still wins', () => {
    // `logo` and `lineart` set subpixel deliberately and must not be overridden.
    expect(PRESETS.logo.subpixel).toBe(true);
    expect(PRESETS.lineart.subpixel).toBe(true);
  });

  it('clean carries no fit-tolerance overrides', () => {
    // Setting them produced 547 curves that speckled every boundary, at 3.2x the
    // bytes. Recorded as a test so it is not "tidied" back in.
    expect(PRESETS.clean.tolerance).toBeUndefined();
    expect(PRESETS.clean.fitError).toBeUndefined();
    expect(PRESETS.clean.cornerAngle).toBeUndefined();
    expect(PRESETS.clean.smooth).toBe(1);
  });
});
