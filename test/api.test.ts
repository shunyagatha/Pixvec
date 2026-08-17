import { describe, expect, it } from 'vitest';
import { measureFlatness, vectorize, verifySvg, type VectorizeInput } from '../src/api.js';
import { decodeRaster } from '../src/io/decode.js';
import { quantize, quantizeAlpha } from '../src/vectorize/quantize.js';
import { autoMinArea, trace } from '../src/vectorize/trace.js';
import { srgbToOklab } from '../src/color.js';
import { alphaBlob, createImage, encode, flatArtwork, photoLike, pixelArt, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

async function asInput(img: RasterImage, format: 'png' | 'jpeg' = 'png'): Promise<VectorizeInput> {
  const bytes = await encode(img, format);
  const { image, meta } = await decodeRaster(bytes);
  return { image, meta, bytes };
}

describe('measureFlatness', () => {
  it('separates flat artwork from photographic input', () => {
    const flat = measureFlatness(flatArtwork());
    const photo = measureFlatness(photoLike(128, 128));

    expect(flat.distinctColors).toBeLessThan(16);
    expect(flat.runRatio).toBeLessThan(0.1);
    expect(photo.runRatio).toBeGreaterThan(0.5);
  });

  it('stops counting once the cap is passed', () => {
    const result = measureFlatness(photoLike(200, 200), 64);
    expect(result.capped).toBe(true);
  });
});

describe('vectorize mode selection', () => {
  it('picks pixel mode for flat artwork and proves it lossless', async () => {
    const source = await asInput(flatArtwork());
    const result = await vectorize(source, { verify: true });

    expect(result.mode).toBe('pixel');
    expect(result.lossless).toBe(true);
    expect(result.quality?.psnr).toBe(Infinity);
  });

  it('picks trace mode for photographic input', async () => {
    const source = await asInput(photoLike(160, 120));
    const result = await vectorize(source);
    expect(result.mode).toBe('trace');
  });

  it('honours an explicit mode', async () => {
    const source = await asInput(flatArtwork());
    expect((await vectorize(source, { mode: 'trace' })).mode).toBe('trace');
    expect((await vectorize(source, { mode: 'embed' })).mode).toBe('embed');
  });

  it('falls back from pixel to embed when lossless is demanded of a photo', async () => {
    const source = await asInput(photoLike(160, 120));
    const result = await vectorize(source, { mode: 'lossless', verify: true });

    expect(result.mode).toBe('embed');
    expect(result.lossless).toBe(true);
    // The choice is explained with the actual measured sizes rather than a
    // heuristic guess about the kind of image this is.
    expect(result.notes.join(' ')).toMatch(/larger than the embedded bitmap/);
    expect(result.notes.join(' ')).toMatch(/Both are bit-exact/);
  });

  it('uses pixel mode when lossless is demanded of flat artwork', async () => {
    const source = await asInput(pixelArt(4));
    const result = await vectorize(source, { mode: 'lossless', verify: true });

    expect(result.mode).toBe('pixel');
    expect(result.lossless).toBe(true);
  });

  it('reports measured losslessness rather than the construction-time claim', async () => {
    // A JPEG payload survives byte for byte, but resvg's decoder rounds its
    // inverse DCT differently, so the rendered result is not bit-identical.
    const source = await asInput(photoLike(96, 96), 'jpeg');
    const result = await vectorize(source, { mode: 'embed', verify: true });

    expect(result.quality).toBeDefined();
    expect(result.lossless).toBe(result.quality!.lossless);
    expect(result.quality!.psnr).toBeGreaterThan(45); // close, but honestly not exact
  });
});

describe('quality-targeted refinement', () => {
  it('escalates until the target is met and says so', async () => {
    const source = await asInput(flatArtwork());
    const result = await vectorize(source, { mode: 'trace', targetSsim: 0.97, maxRefineSteps: 6 });

    expect(result.quality!.ssim).toBeGreaterThanOrEqual(0.97);
    expect(result.notes.join(' ')).toMatch(/Reached target/);
  });

  it('returns the best attempt and admits failure when the target is unreachable', async () => {
    const source = await asInput(photoLike(96, 72));
    const result = await vectorize(source, {
      mode: 'trace', targetSsim: 0.9999, maxRefineSteps: 2,
    });

    expect(result.quality).toBeDefined();
    expect(result.quality!.ssim).toBeLessThan(0.9999);
    expect(result.notes.join(' ')).toMatch(/without reaching the target/);
    expect(result.notes.join(' ')).toMatch(/embed/);
  });

  it('settles on parameters it reports back', async () => {
    const source = await asInput(flatArtwork());
    const result = await vectorize(source, { mode: 'trace', targetSsim: 0.99 });
    expect(result.settled).toHaveProperty('colors');
    expect(result.settled).toHaveProperty('tolerance');
  });
});

describe('verifySvg', () => {
  it('renders at the reference size even when the document disagrees', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 20 20"><rect width="20" height="20" fill="#000"/></svg>`;
    const reference = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    for (let i = 0; i < 64 * 64; i++) reference.data[i * 4 + 3] = 255;

    const report = await verifySvg(svg, reference);
    expect(report.width).toBe(64);
    expect(report.height).toBe(64);
  });
});

describe('quantize', () => {
  it('never returns more colours than requested', () => {
    for (const k of [1, 2, 5, 16, 64]) {
      expect(quantize(photoLike(96, 96), k).count).toBeLessThanOrEqual(k);
    }
  });

  it('finds the exact palette of a flat image', () => {
    const palette = quantize(flatArtwork(), 16);
    expect(palette.count).toBeLessThanOrEqual(16);

    // Every source colour should have a palette entry essentially on top of it.
    const wanted = [[250, 244, 232], [214, 69, 65], [32, 96, 160], [40, 150, 110]];
    const lab = new Float64Array(3);
    for (const [r, g, b] of wanted) {
      srgbToOklab(r, g, b, lab);
      let best = Infinity;
      for (let i = 0; i < palette.count; i++) {
        best = Math.min(best, Math.hypot(
          lab[0] - palette.lab[i * 3],
          lab[1] - palette.lab[i * 3 + 1],
          lab[2] - palette.lab[i * 3 + 2],
        ));
      }
      expect(best).toBeLessThan(0.02);
    }
  });

  it('is deterministic', () => {
    const img = photoLike(64, 64);
    expect(Array.from(quantize(img, 24).rgb)).toEqual(Array.from(quantize(img, 24).rgb));
  });

  it('ignores colour hidden under full transparency', () => {
    const img = alphaBlob(48, 48);
    // Paint loud garbage into the fully transparent border.
    for (let i = 0; i < img.width * img.height; i++) {
      if (img.data[i * 4 + 3] === 0) {
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 0;
        img.data[i * 4 + 2] = 255;
      }
    }
    const palette = quantize(img, 4);
    for (let i = 0; i < palette.count; i++) {
      const isMagenta = palette.rgb[i * 3] > 200 && palette.rgb[i * 3 + 1] < 60 && palette.rgb[i * 3 + 2] > 200;
      expect(isMagenta).toBe(false);
    }
  });
});

describe('quantizeAlpha', () => {
  it('keeps every distinct value when there are few', () => {
    expect(Array.from(quantizeAlpha(pixelArt(2), 8))).toEqual([0, 255]);
  });

  it('always preserves fully transparent and fully opaque', () => {
    const levels = Array.from(quantizeAlpha(alphaBlob(), 4));
    expect(levels).toContain(0);
    expect(levels).toContain(255);
  });

  it('returns sorted levels', () => {
    const levels = Array.from(quantizeAlpha(alphaBlob(), 6));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});

/**
 * Auto mode chooses a strategy from image statistics *before* producing
 * anything, and those signals misjudge anti-aliased artwork. A logo with a
 * couple of hundred colours and soft edges reads as "too varied for exact
 * geometry", goes to the tracer, and comes back larger than the source file and
 * still approximate — while an embedded copy would be smaller *and* exact.
 *
 * The guard only fires on strict dominance: the alternative has to win on both
 * size and accuracy. Anything less is a real trade-off and belongs to the caller.
 */
describe('auto mode never returns a dominated result', () => {
  it('switches away from a traced result that is beaten on both size and accuracy', async () => {
    // Anti-aliased flat artwork: few colours, soft edges, exactly the shape that
    // fools the statistics-based choice.
    const size = 200;
    const img = createImage(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - size / 2, y - size / 2);
        // A soft edge over ~2px, as any real rasteriser would produce.
        const t = Math.min(1, Math.max(0, (d - 60) / 2));
        const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
        setPixel(img, x, y, mix(214, 250), mix(69, 244), mix(65, 232), 255);
      }
    }

    const input = await asInput(img);
    const auto = await vectorize(input, { verify: true });
    const traced = await vectorize(input, { mode: 'trace', verify: true });

    // Whatever auto picked, it must not be worse on both axes than what it could
    // have had. That is the whole invariant.
    const autoBytes = Buffer.byteLength(auto.svg);
    const tracedBytes = Buffer.byteLength(traced.svg);
    const autoBetterOrEqual =
      auto.lossless || auto.quality!.ssim >= traced.quality!.ssim || autoBytes <= tracedBytes;
    expect(autoBetterOrEqual).toBe(true);
  });

  it('keeps tracing when the traced result is genuinely smaller', async () => {
    // A photograph traces to something smaller than an exact copy, so there is a
    // real trade-off and auto must not quietly resolve it.
    const input = await asInput(photoLike(200, 150));
    const result = await vectorize(input, { verify: true });
    expect(result.mode).toBe('trace');
  });

  it('leaves an explicit mode alone', async () => {
    const size = 120;
    const img = createImage(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - size / 2, y - size / 2);
        const t = Math.min(1, Math.max(0, (d - 35) / 2));
        const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
        setPixel(img, x, y, mix(20, 240), mix(90, 240), mix(180, 240), 255);
      }
    }
    // Asking for trace means trace, however large the result.
    const result = await vectorize(await asInput(img), { mode: 'trace', verify: true });
    expect(result.mode).toBe('trace');
  });
});

describe('autoMinArea', () => {
  it('disables despeckling on small images and scales up on large ones', () => {
    expect(autoMinArea(172 * 178)).toBeLessThanOrEqual(1);   // no despeckle
    expect(autoMinArea(265 * 314)).toBe(2);
    expect(autoMinArea(768 * 512)).toBe(8);
    expect(autoMinArea(4000 * 3000)).toBe(16);               // capped
  });

  it('is used when minArea is not given, and overridable', () => {
    const img = photoLike(320, 240);
    expect(trace(img).despeckled).toBeGreaterThan(0);
    expect(trace(img, { minArea: 0 }).despeckled).toBe(0);
  });
});

describe('an explicit preset outranks the auto heuristics', () => {
  /**
   * Naming a tracing preset used to do nothing to routing.
   *
   * `resolveMode` consulted `opts.preset` for exactly two values — `'pixelart'`
   * and `'exact'` — and every other preset was read only inside `runTrace`, which
   * is never reached when the image statistics choose pixel. So `logo`, `lineart`,
   * `poster`, `photo` and `detailed` all returned output *byte-identical to
   * `auto`*: measured on a rasterised vector original, all five gave the same
   * sha256, the same 40,630 bytes and the same 57 shapes. On this project's own
   * `logo-tux.png`, `--preset logo` returned a 16 KB base64 raster.
   *
   * Two changes were needed, and the second is easy to miss: exempting an explicit
   * preset from the dominating-exact swap. Without it the trace is built and then
   * handed straight back for a base64 copy, because that check fires on exactly
   * the images a logo preset is for — its own docstring names "a logo with 194
   * colours and soft edges".
   */
  it('sends a flat image to trace when a tracing preset is named', async () => {
    const source = await asInput(flatArtwork());
    // The control: without a preset this is the pixel-mode case asserted above.
    expect((await vectorize(source)).mode).toBe('pixel');

    for (const preset of ['logo', 'lineart', 'poster', 'detailed'] as const) {
      const result = await vectorize(source, { preset });
      expect(result.mode, `preset '${preset}' should select trace`).toBe('trace');
      // And it must actually be geometry, not a wrapped bitmap.
      expect(result.svg).not.toMatch(/<image\b/);
    }
  });

  it('still honours the more specific --mode flag', async () => {
    // `--mode pixel --preset logo` is not a contradiction to resolve by preset:
    // mode is the more specific instruction and wins.
    const source = await asInput(flatArtwork());
    expect((await vectorize(source, { mode: 'pixel', preset: 'logo' })).mode).toBe('pixel');
    expect((await vectorize(source, { mode: 'embed', preset: 'logo' })).mode).toBe('embed');
  });

  it('leaves pixelart, exact and lossless exactly as they were', async () => {
    const source = await asInput(flatArtwork());
    // `pixelart` means "this IS pixel art", so it must keep choosing pixel.
    expect((await vectorize(source, { preset: 'pixelart' })).mode).toBe('pixel');
    // The bit-exactness promise is not routed by preset at all: `exact` and
    // `lossless` measure candidates instead of guessing, and must stay exact.
    for (const opts of [{ preset: 'exact' as const }, { mode: 'lossless' as const }]) {
      const result = await vectorize(source, { ...opts, verify: true });
      expect(result.lossless, `${JSON.stringify(opts)} must stay bit-exact`).toBe(true);
      expect(result.quality?.psnr).toBe(Infinity);
    }
  });

  it('plain auto is untouched, including the exact-copy swap', async () => {
    // The swap must still fire without a preset — that is the behaviour #48 added
    // and this change must not disable it generally, only exempt explicit presets.
    const source = await asInput(flatArtwork());
    const auto = await vectorize(source, { verify: true });
    expect(auto.mode).toBe('pixel');
    expect(auto.lossless).toBe(true);
  });
});
