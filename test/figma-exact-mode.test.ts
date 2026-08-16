import { describe, expect, it } from 'vitest';
import { vectorizeExact } from '../src/vectorize/exact.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * The Figma plugin's Pixel-exact mode promises bit-identical vectors, or an
 * honest refusal. This locks the promise: whatever the plugin would ACCEPT
 * (below its shape/byte cap) must render back bit-exact, and whatever it would
 * REFUSE must genuinely be over the cap. The one thing that must never happen is
 * a result presented as lossless that is not — so every accepted case is
 * rendered and checked for zero error.
 *
 * These are the plugin's own constants and gate, from extensions/figma/src/ui.ts.
 */
const EXACT_MAX_SHAPES = 8000;
const EXACT_MAX_BYTES = 2_000_000;

interface Decision { refuse: boolean; svg: string; shapes: number }
function exactMode(img: RasterImage): Decision {
  const out = vectorizeExact(img);
  if (out.shapes > EXACT_MAX_SHAPES || out.svg.length > EXACT_MAX_BYTES) {
    return { refuse: true, svg: '', shapes: out.shapes };
  }
  return { refuse: false, svg: out.svg, shapes: out.shapes };
}

async function isBitExact(svg: string, source: RasterImage): Promise<boolean> {
  const { image } = await rasterizeSvg(svg, { width: source.width, height: source.height });
  const q = compareImages(source, image);
  // Bit-identical shows as infinite PSNR (zero mean-squared error).
  return !isFinite(q.psnr);
}

/* --- fixtures spanning what the plugin admits and what it declines --- */

function filledRect(hex: [number, number, number]): RasterImage {
  const img = createImage(160, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 160; x++) setPixel(img, x, y, hex[0], hex[1], hex[2]);
  return img;
}
function twoTone(): RasterImage {
  const img = createImage(160, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 160; x++) {
    const on = x > 30 && x < 130 && y > 20 && y < 80;
    if (on) setPixel(img, x, y, 0x33, 0x41, 0x55);
    else setPixel(img, x, y, 255, 255, 255);
  }
  return img;
}
function transparentIcon(): RasterImage {
  const img = createImage(160, 100); // transparent ground
  for (let y = 20; y < 80; y++) for (let x = 30; x < 130; x++) {
    const border = x < 34 || x >= 126 || y < 24 || y >= 76;
    if (border) setPixel(img, x, y, 0x12, 0xb8, 0x86);
  }
  return img;
}
/** Full-spectrum per-pixel noise — the exploding case the plugin must decline. */
function noise(): RasterImage {
  const img = createImage(200, 200);
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    setPixel(img, x, y, (rnd() * 256) | 0, (rnd() * 256) | 0, (rnd() * 256) | 0);
  }
  return img;
}

describe('figma pixel-exact mode: lossless or an honest refusal', () => {
  const flat: [string, RasterImage][] = [
    ['solid black fill', filledRect([0, 0, 0])],
    ['solid slate fill (fractional luma)', filledRect([0x33, 0x41, 0x55])],
    ['two-tone shape on white', twoTone()],
    ['transparent-ground icon outline', transparentIcon()],
  ];

  for (const [label, img] of flat) {
    it(`accepts ${label} and renders it back bit-exact`, async () => {
      const d = exactMode(img);
      expect(d.refuse, 'flat art must not be refused').toBe(false);
      expect(await isBitExact(d.svg, img), 'accepted result must be bit-identical').toBe(true);
    });
  }

  it('refuses full-spectrum noise rather than emitting a giant rect-soup', () => {
    const d = exactMode(noise());
    expect(d.refuse).toBe(true);
    expect(d.shapes).toBeGreaterThan(EXACT_MAX_SHAPES);
  });

  it('never presents a non-bit-exact result as lossless', async () => {
    // The invariant across everything: if the mode would ACCEPT it, it is exact.
    for (const [, img] of flat) {
      const d = exactMode(img);
      if (!d.refuse) expect(await isBitExact(d.svg, img)).toBe(true);
    }
  });
});
