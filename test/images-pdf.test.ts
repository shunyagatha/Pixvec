import { describe, expect, it } from 'vitest';
import { assembleImagePdf, imagesToPdf } from '../src/io/images-pdf.js';
import { isPdf, renderPdfPages, countPdfPages } from '../src/io/pdf.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

let mupdfOk = true;
try { await import('mupdf' as string); } catch { mupdfOk = false; }

function solid(w: number, h: number, r: number, g: number, b: number): RasterImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, r, g, b);
  return img;
}

describe('assembleImagePdf (pure)', () => {
  it('emits a valid PDF skeleton with an image XObject per page', () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI+EOI marker bytes
    const pdf = assembleImagePdf([
      { jpeg: fakeJpeg, width: 100, height: 50 },
      { jpeg: fakeJpeg, width: 40, height: 40 },
    ]);
    expect(isPdf(pdf)).toBe(true);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Count 2');
    expect((text.match(/\/Subtype \/Image/g) ?? [])).toHaveLength(2);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('startxref');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('throws on no pages', () => {
    expect(() => assembleImagePdf([])).toThrow(/at least one/);
  });

  it('rejects a non-positive or non-finite dpi (would corrupt the MediaBox)', () => {
    const jp = { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 10 };
    expect(() => assembleImagePdf([jp], { dpi: 0 })).toThrow(/dpi/);
    expect(() => assembleImagePdf([jp], { dpi: -5 })).toThrow(/dpi/);
    expect(() => assembleImagePdf([jp], { dpi: NaN })).toThrow(/dpi/);
    expect(() => assembleImagePdf([jp], { dpi: Infinity })).toThrow(/dpi/);
  });
});

describe.skipIf(!mupdfOk)('imagesToPdf round-trip (needs mupdf)', () => {
  it('stitches images into one page each, upright, at the requested dpi', async () => {
    const a = solid(96, 48, 220, 30, 30); // red, 96×48
    const b = solid(48, 96, 30, 60, 220); // blue, 48×96
    const pdf = await imagesToPdf([a, b], { dpi: 96 });
    expect(isPdf(pdf)).toBe(true);
    expect(await countPdfPages(pdf)).toBe(2);

    // Built at 96 dpi (96px → 72pt page); render back at 96 dpi to recover px.
    const rendered = await renderPdfPages(pdf, { dpi: 96 });
    expect(rendered).toHaveLength(2);
    expect(Math.abs(rendered[0].width - 96)).toBeLessThanOrEqual(2);
    expect(Math.abs(rendered[0].height - 48)).toBeLessThanOrEqual(2);
    // Colours survive (JPEG is lossy, so allow slack) and are on the right page.
    const centre = (img: RasterImage) => {
      const o = (Math.floor(img.height / 2) * img.width + Math.floor(img.width / 2)) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2]];
    };
    const [r0] = [centre(rendered[0])];
    expect(r0[0]).toBeGreaterThan(160); // page 0 is red
    expect(r0[2]).toBeLessThan(90);
    const r1 = centre(rendered[1]);
    expect(r1[2]).toBeGreaterThan(160); // page 1 is blue
    expect(r1[0]).toBeLessThan(90);
  });

  it('flattens alpha over the page background instead of going black', async () => {
    const img = createImage(32, 32);
    for (let i = 0; i < 32 * 32; i++) setPixel(img, i % 32, (i / 32) | 0, 0, 0, 0, 0); // fully transparent
    const pdf = await imagesToPdf([img], { background: { r: 255, g: 255, b: 255 } });
    const [page] = await renderPdfPages(pdf, { scale: 1 });
    const o = (16 * page.width + 16) * 4;
    expect(page.data[o]).toBeGreaterThan(240); // white, not black
  });
});
