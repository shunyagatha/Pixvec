import { describe, expect, it } from 'vitest';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents } from '../src/vectorize/contour.js';
import { vectorizeEmbed } from '../src/vectorize/embed.js';
import { vectorizePixels } from '../src/vectorize/pixel.js';
import { trace } from '../src/vectorize/trace.js';
import { fitLoop } from '../src/vectorize/fit.js';
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

  describe('the degenerate-meshing guard', () => {
    // 600x600 of noise meshes at ~100%, so it clears both halves of the guard.
    const BIG = 600;

    it('refuses a large image that has stopped compressing', () => {
      expect(() => vectorizePixels(photoLike(BIG, BIG))).toThrow(/stopped compressing/);
    });

    it('still allows it when the caller raises the budget', () => {
      const out = vectorizePixels(photoLike(BIG, BIG), { maxRectsPerPixel: 1 });
      expect(out.rects).toBeGreaterThan(BIG * BIG * 0.5);
    });

    it('does NOT refuse a small image, however degenerate', () => {
      // The reason the guard needs two halves. A 48x36 patch of noise meshes at
      // ~100% — perfectly degenerate — and produces a few kilobytes: bit-exact,
      // small, entirely usable. A ratio test alone refuses this, which would
      // break `--prefer geometry` and four other tested contracts. Whether the
      // output hurts is a question about size, not shape.
      const small = photoLike(48, 36);
      const out = vectorizePixels(small);
      expect(out.rects).toBeGreaterThan(small.width * small.height * 0.5);
      expect(out.svg.length).toBeLessThan(400_000);
    });

    it('leaves blocky artwork alone no matter how large', () => {
      // Same pixel count as the refused case, so only the ratio distinguishes
      // them — this must pass on shape, not on being small.
      const out = vectorizePixels(flatArtwork(BIG, BIG));
      expect(out.rects).toBeLessThan(BIG * BIG * 0.5);
    });

    it('names the measured numbers rather than guessing at the damage', () => {
      // An earlier version said "tens of megabytes" unconditionally, which was
      // false for the small inputs it was also refusing.
      let msg = '';
      try { vectorizePixels(photoLike(BIG, BIG)); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/rectangles for/);
      expect(msg).toMatch(new RegExp(`${BIG * BIG}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
      // The remedy must be something a CLI user can actually type. The first
      // version of this message named `maxRectsPerPixel`, an API option with no
      // CLI equivalent — advice that could not be followed from the place the
      // error appears.
      expect(msg).toMatch(/--max-rects-per-pixel/);
      // And the measured percentage must not read as equal to the budget it
      // exceeded: `toFixed(0)` printed "50%, over the 50% budget".
      const pct = msg.match(/\((\d+\.\d)%, over the (\d+)% budget\)/);
      expect(pct).not.toBeNull();
      expect(Number(pct![1])).toBeGreaterThan(Number(pct![2]));
    });
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

/**
 * Curve optimisation: merging adjacent Béziers where one curve fits both.
 *
 * The measured effect is small — Schneider subdivision only splits where a
 * single curve provably failed, so re-fitting the merged span usually fails the
 * same test. What matters is that it is never *harmful*: it must not increase
 * the segment count and must not degrade accuracy, because every merge is
 * checked against the same error budget the split was.
 */
describe('curve optimisation', () => {
  const shapes: Array<[string, (x: number, y: number, n: number) => boolean]> = [
    ['disc', (x, y, n) => Math.hypot(x - n / 2, y - n / 2) < n * 0.38],
    ['ring', (x, y, n) => {
      const d = Math.hypot(x - n / 2, y - n / 2);
      return d < n * 0.4 && d > n * 0.22;
    }],
    ['lobed blob', (x, y, n) => {
      const a = Math.atan2(y - n / 2, x - n / 2);
      const d = Math.hypot(x - n / 2, y - n / 2);
      return d < n * (0.28 + 0.09 * Math.sin(3 * a) + 0.05 * Math.cos(5 * a));
    }],
  ];

  function loopFor(fn: (x: number, y: number, n: number) => boolean, n = 120) {
    const classes = new Int32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) classes[y * n + x] = fn(x, y, n) ? 1 : 0;
    }
    const comps = connectedComponents(classes, n, n, -1);
    const loops = traceComponents(comps.labels, n, n, comps.count);
    const target = comps.classes.findIndex((c) => c === 1);
    return loops[target][0];
  }

  it.each(shapes)('never emits more segments for a %s', (_name, fn) => {
    const loop = loopFor(fn);
    for (const tolerance of [0.5, 1, 2]) {
      const base = { tolerance, fitError: tolerance, cornerAngle: 75, polygonOnly: false };
      const off = fitLoop(loop.pts, { ...base, optimize: false })!;
      const on = fitLoop(loop.pts, { ...base, optimize: true })!;
      expect(on.segments.length).toBeLessThanOrEqual(off.segments.length);
    }
  });

  it('keeps the traced result at least as accurate', async () => {
    const source = flatArtwork(120, 90);
    const off = await roundTrip(source, trace(source, { colors: 8, optimize: false }).svg);
    const on = await roundTrip(source, trace(source, { colors: 8, optimize: true }).svg);
    // Merges are gated on the same error budget, so accuracy must not fall
    // meaningfully. At the retuned default tolerance this fixture traces
    // perfectly (PSNR infinity) either way, so compare through SSIM, which
    // stays finite, rather than a subtraction that Infinity would defeat.
    expect(on.ssim).toBeGreaterThanOrEqual(off.ssim - 1e-6);
  });

  it('is on by default', () => {
    const loop = loopFor(shapes[2][1]);
    const base = { tolerance: 1, fitError: 1, cornerAngle: 75, polygonOnly: false };
    const explicit = fitLoop(loop.pts, { ...base, optimize: true })!;
    const implicit = fitLoop(loop.pts, base)!;
    expect(implicit.segments.length).toBe(explicit.segments.length);
  });
});
