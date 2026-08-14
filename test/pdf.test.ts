import { describe, expect, it } from 'vitest';
import { traceGeometry, toPdf } from '../src/io/export/index.js';
import { isPdf, renderPdfPages, countPdfPages, resolvePageIndices } from '../src/io/pdf.js';
import { createImage, setPixel } from './fixtures.js';

/**
 * PDF rendering is bring-your-own: it needs the optional `mupdf` package. It is a
 * devDependency here so these run in CI; if it is ever absent the render tests
 * skip rather than fail, but the signature detection still runs.
 */
let mupdfOk = true;
try {
  await import('mupdf' as string);
} catch {
  mupdfOk = false;
}

/** A one-page PDF of a red disc, built with graver's own toPdf. */
function discPdf(): Uint8Array {
  const s = 100;
  const img = createImage(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const inside = (x - 50) ** 2 + (y - 50) ** 2 <= 34 * 34;
      setPixel(img, x, y, inside ? 230 : 255, inside ? 40 : 255, inside ? 60 : 255);
    }
  }
  return toPdf(traceGeometry(img, { colors: 2 }));
}

describe('resolvePageIndices', () => {
  it('returns every page when none are named', () => {
    expect(resolvePageIndices(3)).toEqual([0, 1, 2]);
  });
  it('dedupes, sorts, and clamps to the page count', () => {
    expect(resolvePageIndices(10, [0, 5])).toEqual([0, 5]);
    expect(resolvePageIndices(3, [0, 5])).toEqual([0]);       // 5 is out of range
    expect(resolvePageIndices(3, [2, 2, 0])).toEqual([0, 2]); // dedupe + sort
    expect(resolvePageIndices(3, [])).toEqual([0, 1, 2]);     // empty → all
  });
});

describe('isPdf', () => {
  it('detects the %PDF- signature', () => {
    expect(isPdf(discPdf())).toBe(true);
  });
  it('rejects non-PDF bytes', () => {
    expect(isPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isPdf(new TextEncoder().encode('<svg/>'))).toBe(false);
  });
});

describe.skipIf(!mupdfOk)('renderPdfPages (needs mupdf)', () => {
  it('renders a page to an RGBA raster at the requested scale', async () => {
    const pages = await renderPdfPages(discPdf(), { scale: 2 });
    expect(pages).toHaveLength(1);
    const [img] = pages;
    // 100pt page × 2 ≈ 200px (mupdf may round by ±1).
    expect(Math.abs(img.width - 200)).toBeLessThanOrEqual(2);
    expect(img.data.length).toBe(img.width * img.height * 4);
    // The centre is the red disc.
    const o = (Math.floor(img.height / 2) * img.width + Math.floor(img.width / 2)) * 4;
    expect(img.data[o]).toBeGreaterThan(150);
    expect(img.data[o + 1]).toBeLessThan(120);
    expect(img.data[o + 2]).toBeLessThan(120);
  });

  it('honours --dpi (dpi/72 scale)', async () => {
    const [img] = await renderPdfPages(discPdf(), { dpi: 144 }); // 2× → ~200px
    expect(Math.abs(img.width - 200)).toBeLessThanOrEqual(2);
  });

  it('counts pages without rendering', async () => {
    expect(await countPdfPages(discPdf())).toBe(1);
  });

  it('filters to selected pages and ignores out-of-range', async () => {
    // A 1-page doc: page index [0] is valid, [5] is dropped.
    const pages = await renderPdfPages(discPdf(), { pages: [0, 5] });
    expect(pages).toHaveLength(1);
  });

  it('a rendered page vectorises to SVG (the graver doc -f svg path)', async () => {
    const [img] = await renderPdfPages(discPdf(), { scale: 1 });
    const { vectorize, loadRaster } = await import('../src/api.js');
    const { encodeRaster } = await import('../src/io/encode.js');
    const png = await encodeRaster(img, { format: 'png' });
    const r = await vectorize(await loadRaster(png), { mode: 'auto' });
    expect(r.svg).toContain('<svg');
    expect(r.shapes).toBeGreaterThan(0);
  });
});
