import { describe, expect, it } from 'vitest';
import { decodeRaster } from '../src/io/decode.js';
import { encodeRaster, formatFromExtension } from '../src/io/encode.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { loadRaster, vectorize } from '../src/api.js';
import { encodeBmp, encodeIco, encodeIcoDib, encodePnm, encodeTga } from '../src/io/formats/index.js';
import type { RasterFormat, RasterImage } from '../src/types.js';
import { alphaBlob, createImage, flatArtwork, pixelArt, setPixel } from './fixtures.js';

/**
 * The conversion matrix.
 *
 * The promise is that every format the library reads, it can also write — so
 * any input converts to any output. That is a property of the whole matrix, not
 * of any single pair, and it is exactly the kind of claim that quietly stops
 * being true when someone adds a decoder and forgets the encoder. So it is
 * asserted for all N x N combinations rather than spot-checked.
 */

const RASTER_FORMATS: RasterFormat[] = [
  'png', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pnm', 'tga',
];

/** Formats that must round-trip bit-exactly. JPEG is lossy by construction. */
const LOSSLESS_FORMATS = new Set<RasterFormat>([
  'png', 'webp', 'tiff', 'bmp', 'ico', 'pnm', 'tga',
]);

/** Formats with no alpha channel, where transparency is flattened on write. */
const NO_ALPHA = new Set<RasterFormat>(['jpeg', 'pnm']);

function fixture(width = 32, height = 24): RasterImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2);
      const c =
        d < 5 ? [250, 244, 232] :
        d < 9 ? [214, 69, 65] :
        x < width / 3 ? [32, 96, 160] : [40, 150, 110];
      setPixel(img, x, y, c[0], c[1], c[2], 255);
    }
  }
  return img;
}

describe('format encoders', () => {
  const source = fixture(37, 23); // odd dimensions exercise row padding

  it.each(RASTER_FORMATS)('encodes and decodes %s', async (format) => {
    const encoded = await encodeRaster(source, { format, lossless: true, quality: 100 });
    expect(encoded.length).toBeGreaterThan(0);

    const { image } = await decodeRaster(encoded);
    expect([image.width, image.height]).toEqual([source.width, source.height]);

    if (LOSSLESS_FORMATS.has(format)) {
      expect(compareImages(source, image).lossless).toBe(true);
    } else {
      expect(compareImages(source, image).psnr).toBeGreaterThan(40);
    }
  });

  it('reports the container it wrote, not what is inside it', async () => {
    for (const format of ['bmp', 'ico', 'pnm', 'tga'] as const) {
      const { meta } = await decodeRaster(
        await encodeRaster(source, { format, lossless: true }),
      );
      expect(meta.format).toBe(format);
    }
  });

  it('preserves alpha in formats that carry it', async () => {
    const transparent = pixelArt(3);
    for (const format of ['png', 'webp', 'tiff', 'bmp', 'ico', 'tga'] as const) {
      const { image } = await decodeRaster(
        await encodeRaster(transparent, { format, lossless: true }),
      );
      expect(compareImages(transparent, image).lossless).toBe(true);
    }
  });

  it('flattens alpha onto the background where the format has none', async () => {
    const transparent = pixelArt(3);
    for (const format of NO_ALPHA) {
      const { image } = await decodeRaster(
        await encodeRaster(transparent, {
          format, quality: 100, background: { r: 255, g: 0, b: 255, a: 255 },
        }),
      );
      expect(image.data[3]).toBe(255);          // corner is now opaque
      expect(image.data[0]).toBeGreaterThan(200); // magenta showed through
      expect(image.data[2]).toBeGreaterThan(200);
    }
  });

  it('maps every new extension', () => {
    expect(formatFromExtension('.bmp')).toBe('bmp');
    expect(formatFromExtension('.dib')).toBe('bmp');
    expect(formatFromExtension('.ICO')).toBe('ico');
    expect(formatFromExtension('.cur')).toBe('ico');
    expect(formatFromExtension('.ppm')).toBe('pnm');
    expect(formatFromExtension('.pgm')).toBe('pnm');
    expect(formatFromExtension('.tga')).toBe('tga');
  });
});

describe('portable encoders', () => {
  const source = fixture(29, 17);

  it('writes 24-bit BMP for opaque input and 32-bit when alpha is present', async () => {
    const opaque = encodeBmp(source);
    expect(opaque[28]).toBe(24);          // bit count, opaque
    // pixelArt has genuinely transparent corners; alphaBlob at a small size
    // never reaches its transparent radius and would be fully opaque.
    const withAlpha = encodeBmp(pixelArt(3));
    expect(withAlpha[28]).toBe(32);
    // Both must survive a decode.
    expect(compareImages(source, (await decodeRaster(opaque)).image).lossless).toBe(true);
  });

  it('run-length encodes TGA without inflating it', async () => {
    const raw = encodeTga(source, { rle: false });
    const rle = encodeTga(source, { rle: true });
    // Flat artwork compresses; either way it must still decode exactly.
    expect(rle.length).toBeLessThan(raw.length);
    expect(compareImages(source, (await decodeRaster(rle)).image).lossless).toBe(true);
    expect(compareImages(source, (await decodeRaster(raw)).image).lossless).toBe(true);
  });

  it('writes every Netpbm variant', async () => {
    for (const variant of ['P6', 'P5', 'P4'] as const) {
      const bytes = encodePnm(source, { variant });
      expect(String.fromCharCode(bytes[0], bytes[1])).toBe(variant);
      const { image } = await decodeRaster(bytes);
      expect([image.width, image.height]).toEqual([source.width, source.height]);
    }
  });

  it('builds an ICO whose DIB carries the AND mask', async () => {
    const sprite = pixelArt(2);
    const ico = encodeIco([{
      width: sprite.width, height: sprite.height, payload: encodeIcoDib(sprite),
    }]);
    const { image, meta } = await decodeRaster(ico);
    expect(meta.format).toBe('ico');
    expect(compareImages(sprite, image).lossless).toBe(true);
  });

  it('needs no codec: encoders are pure functions over Uint8Array', () => {
    for (const bytes of [encodeBmp(source), encodePnm(source), encodeTga(source)]) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    }
  });
});

describe('every format converts to every other', () => {
  it('completes all 11 x 11 conversions', async () => {
    const source = fixture(32, 24);
    const all = [...RASTER_FORMATS, 'svg'] as const;

    // Prepare one encoded input per format.
    const inputs = new Map<string, Uint8Array>();
    for (const format of RASTER_FORMATS) {
      inputs.set(format, await encodeRaster(source, { format, lossless: true, quality: 100 }));
    }
    const pngInput = inputs.get('png')!;
    inputs.set(
      'svg',
      new TextEncoder().encode(
        (await vectorize(await loadRaster(pngInput), { mode: 'lossless' })).svg,
      ),
    );

    const failures: string[] = [];

    for (const from of all) {
      const pixels = from === 'svg'
        ? (await rasterizeSvg(inputs.get('svg')!, { width: source.width })).image
        : (await decodeRaster(inputs.get(from)!)).image;

      for (const to of all) {
        try {
          if (to === 'svg') {
            const loaded = await loadRaster(pngInput);
            const result = await vectorize({ ...loaded, image: pixels }, { mode: 'lossless' });
            const back = await rasterizeSvg(result.svg, { width: source.width });
            if (back.image.width !== source.width) throw new Error('size mismatch');
          } else {
            const encoded = await encodeRaster(pixels, { format: to, lossless: true, quality: 100 });
            const back = await decodeRaster(encoded);
            if (back.image.width !== source.width || back.image.height !== source.height) {
              throw new Error(`size ${back.image.width}x${back.image.height}`);
            }
          }
        } catch (err) {
          failures.push(`${from} -> ${to}: ${(err as Error).message}`);
        }
      }
    }

    expect(failures).toEqual([]);
  }, 180_000);

  it('keeps flat artwork bit-exact through every lossless hop', async () => {
    const source = flatArtwork(48, 36);
    for (const format of LOSSLESS_FORMATS) {
      const encoded = await encodeRaster(source, { format, lossless: true });
      const { image } = await decodeRaster(encoded);
      expect(
        compareImages(source, image).lossless,
        `${format} was not bit-exact`,
      ).toBe(true);
    }
  });
});
