import { describe, expect, it } from 'vitest';
import { measureFlatness, vectorize, verifySvg, type VectorizeInput } from '../src/api.js';
import { decodeRaster } from '../src/io/decode.js';
import { quantize, quantizeAlpha } from '../src/vectorize/quantize.js';
import { srgbToOklab } from '../src/color.js';
import { alphaBlob, encode, flatArtwork, photoLike, pixelArt } from './fixtures.js';
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
