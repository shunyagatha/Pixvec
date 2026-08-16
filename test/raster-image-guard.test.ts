import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { centerlineTrace, centerlinePolylines } from '../src/vectorize/centerline.js';
import { vectorizeExact, vectorizeExactContours } from '../src/vectorize/exact.js';
import type { RasterImage } from '../src/types.js';

/**
 * The tracers take a decoded `RasterImage`, but nothing used to stop a caller
 * handing them something else. Because every stage reads `width`/`height`
 * arithmetically and never re-reads them, a missing dimension did not throw —
 * it flowed through as `undefined` and came out the far end as
 * `<svg width="undefined" viewBox="0 0 undefined undefined">`: a document that
 * renders as nothing, returned from a call that reported success.
 *
 * Passing file bytes straight in is the natural version of this mistake, since
 * the CLI takes exactly that. These cases pin the boundary shut, and the last
 * one pins the thing that actually matters — that valid input is unchanged.
 */

const solid = (w: number, h: number): RasterImage => ({
  width: w,
  height: h,
  data: new Uint8ClampedArray(w * h * 4).fill(255),
});

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mP8z8BQz0AEYBxVSF+FAAdWAQ3qHtwZAAAAAElFTkSuQmCC',
  'base64',
);

const entries: [string, (v: unknown) => unknown][] = [
  ['trace', (v) => trace(v as RasterImage)],
  ['centerlineTrace', (v) => centerlineTrace(v as RasterImage)],
  ['centerlinePolylines', (v) => centerlinePolylines(v as RasterImage)],
  ['vectorizeExact', (v) => vectorizeExact(v as RasterImage)],
  ['vectorizeExactContours', (v) => vectorizeExactContours(v as RasterImage)],
];

describe('raster image guard', () => {
  describe.each(entries)('%s', (name, call) => {
    it('rejects encoded file bytes instead of tracing them into an undefined-sized SVG', () => {
      expect(() => call(PNG_BYTES)).toThrow(TypeError);
      // The message has to name the fix, not just the fault: the whole reason
      // this bug survived is that the failure was silent and unexplained.
      expect(() => call(PNG_BYTES)).toThrow(/decoded RasterImage/);
      expect(() => call(PNG_BYTES)).toThrow(new RegExp(`^${name}\\(\\)`));
    });

    it('rejects null and undefined', () => {
      expect(() => call(null)).toThrow(TypeError);
      expect(() => call(undefined)).toThrow(TypeError);
    });

    it('rejects dimensions that are absent, fractional, or non-positive', () => {
      expect(() => call({ width: 4, height: 4 })).toThrow(/data/);
      expect(() => call({ width: 4.5, height: 4, data: new Uint8ClampedArray(72) })).toThrow(/integers/);
      expect(() => call({ width: 0, height: 4, data: new Uint8ClampedArray(0) })).toThrow(/positive/);
    });

    it('rejects a data buffer whose length contradicts the dimensions', () => {
      // Short buffers are the dangerous case: the loops read past the end as
      // zeroes and silently trace a partly-black image rather than failing.
      expect(() => call({ width: 4, height: 4, data: new Uint8ClampedArray(10) })).toThrow(/exactly width\*height\*4 = 64/);
      expect(() => call({ width: 4, height: 4, data: new Uint8ClampedArray(128) })).toThrow(/64/);
    });
  });

  it('leaves valid input completely alone', () => {
    const svg = trace(solid(8, 6)).svg;
    expect(svg).toMatch(/width="8"/);
    expect(svg).toMatch(/height="6"/);
    expect(svg).toMatch(/viewBox="0 0 8 6"/);
    expect(svg).not.toMatch(/undefined/);
  });

  it('accepts a correctly-sized view into a larger buffer, as the animation path produces', () => {
    // Frames are handed over as subarrays of one decoded strip; byteLength, not
    // buffer size, is what has to match.
    const pool = new Uint8ClampedArray(8 * 6 * 4 * 3).fill(200);
    const frame = new Uint8ClampedArray(pool.buffer, 8 * 6 * 4, 8 * 6 * 4);
    expect(() => trace({ width: 8, height: 6, data: frame })).not.toThrow();
  });
});
