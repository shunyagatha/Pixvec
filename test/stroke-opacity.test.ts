import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * The seam-hiding stroke has to carry the region's alpha as well as its colour.
 *
 * `fill-opacity` does not apply to strokes, so emitting the fill colour with a
 * `stroke-width` and no `stroke-opacity` drew a fully opaque outline around a
 * translucent region — a hard ring in the region's own hue, at exactly the edge
 * the stroke exists to make invisible. The fill said 50% and the border said
 * 100%.
 */

/** Two vertical bands, the left one translucent. */
function bands(leftAlpha: number): RasterImage {
  const img = createImage(40, 40);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      if (x < 20) setPixel(img, x, y, 220, 40, 40, leftAlpha);
      else setPixel(img, x, y, 40, 80, 220, 255);
    }
  }
  return img;
}

/** Every `<path>` that carries a stroke, with its fill/stroke opacity pair. */
function strokedPaths(svg: string): { fillOpacity?: string; strokeOpacity?: string }[] {
  return (svg.match(/<path[^>]*>/g) ?? [])
    .filter((p) => / stroke="/.test(p))
    .map((p) => ({
      fillOpacity: (p.match(/fill-opacity="([^"]*)"/) ?? [])[1],
      strokeOpacity: (p.match(/stroke-opacity="([^"]*)"/) ?? [])[1],
    }));
}

describe('stroke opacity', () => {
  it('gives a translucent region a stroke at the same opacity as its fill', () => {
    const { svg } = trace(bands(128), { strokeWidth: 1, colors: 4 });
    const stroked = strokedPaths(svg);
    expect(stroked.length).toBeGreaterThan(0);

    const translucent = stroked.filter((p) => p.fillOpacity !== undefined);
    expect(translucent.length).toBeGreaterThan(0);
    for (const p of translucent) {
      expect(p.strokeOpacity).toBe(p.fillOpacity);
    }
  });

  it('omits stroke-opacity entirely when the region is opaque', () => {
    // The attribute defaults to 1, so emitting it on an opaque path would be
    // bytes with no effect.
    const { svg } = trace(bands(255), { strokeWidth: 1, colors: 4 });
    for (const p of strokedPaths(svg)) {
      expect(p.fillOpacity).toBeUndefined();
      expect(p.strokeOpacity).toBeUndefined();
    }
  });

  it('emits no stroke at all when strokeWidth is 0', () => {
    const { svg } = trace(bands(128), { strokeWidth: 0, colors: 4 });
    expect(strokedPaths(svg)).toHaveLength(0);
  });
});
