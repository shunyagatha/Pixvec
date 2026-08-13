import { describe, expect, it } from 'vitest';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents } from '../src/vectorize/contour.js';
import { vectorizeEmbed } from '../src/vectorize/embed.js';
import { vectorizePixels } from '../src/vectorize/pixel.js';
import { trace } from '../src/vectorize/trace.js';
import type { RasterImage, SourceMeta } from '../src/types.js';
import {
  alphaBlob, createImage, diagonalPinch, encode, flatArtwork, photoLike, pixelArt, setPixel,
} from './fixtures.js';

/** Render an SVG at its intrinsic size and compare against the source pixels. */
async function roundTrip(source: RasterImage, svg: string) {
  const { image } = await rasterizeSvg(svg);
  expect(image.width).toBe(source.width);
  expect(image.height).toBe(source.height);
  return compareImages(source, image);
}

describe('pixel mode', () => {
  const cases: Array<[string, RasterImage]> = [
    ['flat artwork', flatArtwork()],
    ['pixel art with transparency', pixelArt(4)],
    ['soft alpha edges', alphaBlob()],
    ['diagonal self-touching region', diagonalPinch()],
    ['photographic noise', photoLike(48, 36)],
    ['single pixel', (() => { const i = createImage(1, 1); setPixel(i, 0, 0, 7, 8, 9, 200); return i; })()],
  ];

  it.each(cases)('is bit-exact for %s', async (_name, source) => {
    const out = vectorizePixels(source);
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
    expect(report.maxChannelDiff).toBe(0);
    expect(report.psnr).toBe(Infinity);
  });

  it('collapses flat runs into far fewer rectangles than pixels', () => {
    const source = flatArtwork();
    const out = vectorizePixels(source);
    expect(out.rects).toBeLessThan((source.width * source.height) / 20);
  });

  it('emits one path per distinct colour', () => {
    const out = vectorizePixels(flatArtwork());
    expect(out.colors).toBe(4);
  });

  it('refuses to explode on photographic input', () => {
    expect(() => vectorizePixels(photoLike(200, 200), { maxRects: 1000 })).toThrow(/embed|trace/);
  });

  it('skips the background rectangle when anything is transparent', async () => {
    const source = pixelArt(2);
    const out = vectorizePixels(source);
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
  });
});

describe('embed mode', () => {
  const meta = (format: string, bytes: number, overrides: Partial<SourceMeta> = {}): SourceMeta => ({
    format, width: 0, height: 0, channels: 4, depth: 'uchar', hasAlpha: true,
    space: 'srgb', hasProfile: false, frames: 1, bytes, ...overrides,
  });

  it('preserves the original PNG bytes and renders bit-exactly', async () => {
    const source = flatArtwork();
    const png = await encode(source, 'png');
    const out = await vectorizeEmbed(source, png, meta('png', png.length));

    expect(out.bytesPreserved).toBe(true);
    expect(out.svg).toContain('data:image/png;base64,');
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
  });

  /**
   * resvg and WebP-less librsvg builds render a WebP `<image>` as blank, with no
   * warning. `auto` must therefore never reach for it on its own.
   */
  it('never selects WebP automatically', async () => {
    const source = flatArtwork();
    const webp = await encode(source, 'webp');
    const out = await vectorizeEmbed(source, webp, meta('webp', webp.length));

    expect(out.mime).toBe('image/png');
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
  });

  it('warns when WebP is explicitly requested', async () => {
    const source = flatArtwork();
    const png = await encode(source, 'png');
    const out = await vectorizeEmbed(source, png, meta('png', png.length), { strategy: 'webp' });

    expect(out.mime).toBe('image/webp');
    expect(out.notes.join(' ')).toMatch(/resvg|librsvg/);
  });

  it('re-encodes formats that data URIs cannot carry everywhere', async () => {
    const source = flatArtwork();
    const tiff = await encode(source, 'tiff');
    const out = await vectorizeEmbed(source, tiff, meta('tiff', tiff.length));

    expect(out.mime).toBe('image/png');
    expect(out.bytesPreserved).toBe(false);
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
  });

  it('emits xlink:href with its namespace when asked', async () => {
    const source = pixelArt(1);
    const png = await encode(source, 'png');
    const out = await vectorizeEmbed(source, png, meta('png', png.length), { xlink: true });

    expect(out.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out.svg).toContain('xlink:href=');
  });
});

describe('contour tracing', () => {
  it('produces loops that enclose exactly the region', () => {
    // A 3x3 block with a single-pixel hole in the middle.
    const w = 5, h = 5;
    const classes = new Int32Array(w * h);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) classes[y * w + x] = 1;
    classes[2 * w + 2] = 0;

    const comps = connectedComponents(classes, w, h, -1);
    const loops = traceComponents(comps.labels, w, h, comps.count);

    const ring = comps.classes.findIndex((c) => c === 1);
    expect(loops[ring]).toHaveLength(2); // outer boundary plus the hole

    const areas = loops[ring].map((l) => l.signedArea).sort((a, b) => b - a);
    expect(areas[0]).toBe(9);   // outer, positive
    expect(areas[1]).toBe(-1);  // hole, negative
  });

  /**
   * Two blocks meeting at a single lattice point. Under 4-connectivity they are
   * separate components, and each must come back as its own simple loop rather
   * than one figure-of-eight that crosses itself at the shared vertex.
   */
  it('keeps diagonally touching regions separate', () => {
    const w = 4, h = 4;
    const classes = new Int32Array(w * h);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) classes[y * w + x] = 1;
    for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) classes[y * w + x] = 1;

    const comps = connectedComponents(classes, w, h, -1);
    // Four, not three: the background is *also* split in two, because its own
    // halves likewise meet only at that centre point.
    expect(comps.count).toBe(4);

    const loops = traceComponents(comps.labels, w, h, comps.count);
    for (let c = 0; c < comps.count; c++) {
      if (comps.classes[c] !== 1) continue;
      expect(loops[c]).toHaveLength(1);
      expect(loops[c][0].signedArea).toBe(4);
    }
  });

  it('collapses collinear runs', () => {
    const w = 12, h = 3;
    const classes = new Int32Array(w * h);
    for (let x = 0; x < w; x++) classes[1 * w + x] = 1;

    const comps = connectedComponents(classes, w, h, -1);
    const loops = traceComponents(comps.labels, w, h, comps.count);
    const bar = comps.classes.findIndex((c) => c === 1);
    // A rectangle, however long, needs exactly four vertices.
    expect(loops[bar][0].pts).toHaveLength(8);
  });
});

describe('trace mode', () => {
  it('is bit-exact as a polygon at zero tolerance', async () => {
    const source = flatArtwork();
    const out = trace(source, { colors: 8, tolerance: 0, polygonOnly: true });
    const report = await roundTrip(source, out.svg);
    expect(report.lossless).toBe(true);
  });

  it('reproduces flat artwork closely at default settings', async () => {
    const source = flatArtwork();
    const report = await roundTrip(source, trace(source, { colors: 8 }).svg);
    expect(report.ssim).toBeGreaterThan(0.9);
    expect(report.psnr).toBeGreaterThan(25);
  });

  it('improves as the tolerance tightens', async () => {
    const source = flatArtwork();
    const loose = await roundTrip(source, trace(source, { colors: 8, tolerance: 1.5, fitError: 1.5 }).svg);
    const tight = await roundTrip(source, trace(source, { colors: 8, tolerance: 0.4, fitError: 0.4 }).svg);
    expect(tight.psnr).toBeGreaterThan(loose.psnr);
  });

  /**
   * Regression: every interior vertex of a one-pixel-wide feature sits within
   * 1px of the chord across it, so Douglas–Peucker at the default tolerance
   * left fewer than three anchors and the loop was dropped entirely.
   */
  it('does not delete one-pixel-wide features', async () => {
    const size = 40;
    const source = createImage(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) setPixel(source, x, y, 255, 255, 255);
    for (let i = 0; i < size; i++) {
      setPixel(source, i, 20, 0, 0, 0);
      setPixel(source, 20, i, 0, 0, 0);
    }

    const report = await roundTrip(source, trace(source, { colors: 2 }).svg);
    // The cross is ~5% of the image; losing it would put SSIM far below this.
    expect(report.ssim).toBeGreaterThan(0.9);
    expect(report.exactRatio).toBeGreaterThan(0.9);
  });

  it('preserves transparency rather than filling it', async () => {
    const source = pixelArt(4);
    const { image } = await rasterizeSvg(trace(source, { colors: 4, alphaLevels: 2 }).svg);
    // The corners of the sprite are fully transparent in the source.
    expect(image.data[3]).toBe(0);
  });

  it('absorbs specks when asked', () => {
    const source = photoLike(64, 48);
    const none = trace(source, { colors: 32, minArea: 0 });
    const cleaned = trace(source, { colors: 32, minArea: 24 });
    expect(cleaned.despeckled).toBeGreaterThan(0);
    expect(cleaned.svg.length).toBeLessThan(none.svg.length);
  });

  it('keeps every region when minArea is zero', () => {
    const out = trace(photoLike(48, 36), { colors: 16, minArea: 0 });
    expect(out.despeckled).toBe(0);
  });
});
