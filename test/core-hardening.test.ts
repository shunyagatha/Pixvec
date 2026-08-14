import { describe, expect, it } from 'vitest';
import { fitLoop } from '../src/vectorize/fit.js';
import { quantize } from '../src/vectorize/quantize.js';
import { createImage, setPixel } from './fixtures.js';

/**
 * Edge-case hardening surfaced by the core-pipeline audit. These are not happy
 * paths — they are the degenerate inputs that quietly crash or poison output.
 */

describe('Douglas–Peucker (via fitLoop) is iterative, not stack-bound', () => {
  it('simplifies a huge monotone-deviation loop without overflowing the stack', () => {
    // Perpendicular deviations decrease hyperbolically along the chain, the
    // arrangement that makes recursive DP left-comb to depth O(n). With ~40k
    // vertices the recursive form throws RangeError; the iterative form must not.
    const n = 40_000;
    const pts = new Int32Array(n * 4);
    let k = 0;
    for (let i = 0; i < n; i++) { pts[k++] = i; pts[k++] = Math.round(100_000 / (i + 1)); }
    for (let i = n - 1; i >= 0; i--) { pts[k++] = i; pts[k++] = -Math.round(100_000 / (i + 1)); }
    expect(() => fitLoop(pts, { tolerance: 0.5, fitError: 0.5 })).not.toThrow();
  });
});

describe('quantize fixedPalette tolerates a malformed channel', () => {
  it('does not let a NaN channel poison the palette into NaN Oklab', () => {
    const img = createImage(8, 8);
    for (let i = 0; i < 64; i++) setPixel(img, i % 8, (i / 8) | 0, 10, 200, 40);
    const pal = quantize(img, 4, {
      // A caller passing a bad channel (NaN) must not corrupt the whole palette.
      fixedPalette: [
        { r: NaN, g: 0, b: 0, a: 255 },
        { r: 10, g: 200, b: 40, a: 255 },
      ],
    });
    expect([...pal.lab].some(Number.isNaN)).toBe(false);
    expect([...pal.rgb].some(Number.isNaN)).toBe(false);
  });
});
