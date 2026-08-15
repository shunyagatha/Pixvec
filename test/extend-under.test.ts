/**
 * Extend-under: a region's fill runs on beneath the regions painted after it,
 * instead of stopping at their shared edge.
 *
 * The whole justification is that the render does not change — the later region
 * repaints those pixels — so that is what these tests assert, by rendering both
 * outputs and comparing them. Everything else about the feature is a size and
 * seam trade, and a trade is only worth making if the picture is untouched.
 */

import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { flatArtwork, photoLike } from './fixtures.js';

const WHITE = { r: 255, g: 255, b: 255, a: 255 } as const;

async function render(svg: string, width: number) {
  const { image } = await rasterizeSvg(svg, { width, background: WHITE });
  return image;
}

describe('extend-under renders identically', () => {
  it('leaves flat artwork pixel-for-pixel unchanged', async () => {
    const source = flatArtwork(240, 180);
    const plain = trace(source, { colors: 5 });
    const under = trace(source, { colors: 5, extendUnder: true });

    const a = await render(plain.svg, source.width);
    const b = await render(under.svg, source.width);
    const q = compareImages(a, b);

    // Not "close" — the same picture. Anything less and the optimisation is
    // changing the output, which is the one thing it promises not to do.
    expect(q.lossless).toBe(true);
    expect(q.ssim).toBe(1);
  }, 60_000);

  it('leaves a photograph unchanged too, where the geometry is far messier', async () => {
    const source = photoLike(160, 120);
    const plain = trace(source, { colors: 12 });
    const under = trace(source, { colors: 12, extendUnder: true });

    const a = await render(plain.svg, source.width);
    const b = await render(under.svg, source.width);
    const q = compareImages(a, b);

    expect(q.ssim).toBeGreaterThan(0.9999);
    expect(q.deltaE.mean).toBeLessThan(0.01);
  }, 60_000);

  it('scores the same against the *source*, not merely against itself', async () => {
    // The stronger form: both outputs must sit the same distance from the
    // original. Two identically-wrong renders would pass the tests above.
    const source = flatArtwork(200, 150);
    const plain = trace(source, { colors: 5 });
    const under = trace(source, { colors: 5, extendUnder: true });

    const qa = compareImages(source, await render(plain.svg, source.width));
    const qb = compareImages(source, await render(under.svg, source.width));

    expect(qb.ssim).toBeCloseTo(qa.ssim, 6);
    expect(qb.deltaE.mean).toBeCloseTo(qa.deltaE.mean, 6);
  }, 60_000);

  it('is off unless asked for', () => {
    const source = flatArtwork(120, 90);
    expect(trace(source, { colors: 4 }).svg)
      .toBe(trace(source, { colors: 4, extendUnder: false }).svg);
  });

  it('does not disturb transparency', async () => {
    // Void pixels must stay void: a union that swallowed them would fill
    // transparent areas with the colour beneath, which no repaint undoes.
    const w = 80, h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const solid = x > 20 && x < 60 && y > 15 && y < 45;
        data[i] = 214; data[i + 1] = 69; data[i + 2] = 65;
        data[i + 3] = solid ? 255 : 0;
      }
    }
    const source = { width: w, height: h, data };
    const under = trace(source, { colors: 3, extendUnder: true });
    const rendered = await render(under.svg, w);

    // The corner was transparent and must have stayed that way.
    expect(rendered.data[3]).toBe(255); // rendered onto white
    const q = compareImages(await render(trace(source, { colors: 3 }).svg, w), rendered);
    expect(q.ssim).toBeGreaterThan(0.999);
  }, 60_000);
});
