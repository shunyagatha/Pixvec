import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vectorize, type VectorizeInput } from '../src/api.js';
import { decodeRaster } from '../src/io/decode.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { extractEmbedded } from '../src/vectorize/embed.js';
import { vectorizeExact, vectorizeExactContours } from '../src/vectorize/exact.js';
import { vectorizePixels } from '../src/vectorize/pixel.js';
import { bytesEqual, fromBase64, toBase64 } from '../src/io/formats/bytes.js';
import type { RasterImage } from '../src/types.js';
import {
  alphaBlob, createImage, diagonalPinch, encode, flatArtwork, photoLike, pixelArt, setPixel,
} from './fixtures.js';

async function asInput(img: RasterImage, format: 'png' | 'jpeg' = 'png'): Promise<VectorizeInput> {
  const bytes = await encode(img, format);
  const { image, meta } = await decodeRaster(bytes);
  return { image, meta, bytes };
}

async function renderAndCompare(source: RasterImage, svg: string) {
  const { image } = await rasterizeSvg(svg);
  return compareImages(source, image);
}

describe('exact contours', () => {
  const cases: Array<[string, RasterImage]> = [
    ['flat artwork', flatArtwork()],
    ['pixel art with transparency', pixelArt(4)],
    ['soft alpha edges', alphaBlob()],
    ['diagonal self-touching region', diagonalPinch()],
    ['single pixel', (() => { const i = createImage(1, 1); setPixel(i, 0, 0, 7, 8, 9, 200); return i; })()],
  ];

  /**
   * Contours are exact for the same reason rectangles are: crack following puts
   * every vertex on an integer lattice point, so a boundary runs along pixel
   * edges and never through a pixel. Coverage is therefore exactly 1 or exactly
   * 0, with nothing to round.
   */
  it.each(cases)('is bit-exact for %s', async (_name, source) => {
    const out = vectorizeExactContours(source);
    const report = await renderAndCompare(source, out.svg);
    expect(report.lossless).toBe(true);
    expect(report.psnr).toBe(Infinity);
  });

  it('uses colours verbatim rather than quantising them', () => {
    // 300 distinct colours: any palette-based path would have to merge some.
    const img = createImage(300, 1);
    for (let x = 0; x < 300; x++) setPixel(img, x, 0, x % 256, (x * 7) % 256, (x * 13) % 256, 255);
    expect(vectorizeExactContours(img).colors).toBe(new Set(
      Array.from({ length: 300 }, (_, x) => `${x % 256},${(x * 7) % 256},${(x * 13) % 256}`),
    ).size);
  });

  it('refuses to build an absurd number of regions', () => {
    expect(() => vectorizeExactContours(photoLike(200, 200), { maxRegions: 50 }))
      .toThrow(/photographic|budget/i);
  });
});

describe('vectorizeExact', () => {
  /**
   * Both candidates are rebuilt here independently, and the assertion is
   * equality against their minimum.
   *
   * The earlier form could not fail. It read the contour size back out of
   * `chosen.sizes.contours` — the value under test — and compared the winner
   * against `Math.max(rects, contours)`, an upper bound that picking *either*
   * candidate satisfies. So the one defect worth catching, silently returning
   * the larger encoding, passed: both candidates are bit-exact, so no other test
   * in this file can notice it either.
   */
  it('keeps whichever exact encoding is smaller', () => {
    for (const source of [flatArtwork(), pixelArt(4), alphaBlob()]) {
      const chosen = vectorizeExact(source);

      const rects = vectorizePixels(source).svg.length;
      let contours: number | undefined;
      try { contours = vectorizeExactContours(source).svg.length; } catch { contours = undefined; }

      expect(chosen.svg.length).toBe(contours === undefined ? rects : Math.min(rects, contours));
      // Ties go to rectangles, matching the `>=` in vectorizeExact.
      expect(chosen.strategy).toBe(contours !== undefined && contours < rects ? 'contours' : 'rectangles');

      // The reported sizes are what callers see; check them against the
      // independent builds rather than against each other.
      expect(chosen.sizes.rectangles).toBe(rects);
      expect(chosen.sizes.contours).toBe(contours);
    }
  });

  it('prefers contours on curved flat artwork', () => {
    const chosen = vectorizeExact(flatArtwork(240, 180));
    expect(chosen.strategy).toBe('contours');
  });

  it('falls back to rectangles when contours are not viable', () => {
    const chosen = vectorizeExact(photoLike(80, 60), { maxRegions: 10 });
    expect(chosen.strategy).toBe('rectangles');
    expect(chosen.sizes.contours).toBeUndefined();
  });

  it('is bit-exact whichever strategy wins', async () => {
    for (const source of [flatArtwork(), pixelArt(3), alphaBlob(48, 48), photoLike(40, 30)]) {
      const chosen = vectorizeExact(source);
      expect((await renderAndCompare(source, chosen.svg)).lossless).toBe(true);
    }
  });
});

describe('strict lossless mode', () => {
  /**
   * The guarantee is the whole point: whatever the input, `lossless` either
   * returns something rendered and proven bit-identical, or it throws.
   */
  it.each([
    ['flat artwork', () => flatArtwork(), 'png'],
    ['pixel art', () => pixelArt(4), 'png'],
    ['soft alpha', () => alphaBlob(), 'png'],
    ['photograph', () => photoLike(96, 72), 'png'],
    ['JPEG source', () => photoLike(64, 48), 'jpeg'],
    ['single pixel', () => { const i = createImage(1, 1); setPixel(i, 0, 0, 1, 2, 3, 255); return i; }, 'png'],
  ] as const)('is verified bit-exact for %s', async (_name, make, format) => {
    const input = await asInput(make(), format as 'png' | 'jpeg');
    const result = await vectorize(input, { mode: 'lossless' });

    expect(result.lossless).toBe(true);
    expect(result.quality).toBeDefined();
    expect(result.quality!.lossless).toBe(true);
    expect(result.quality!.psnr).toBe(Infinity);
    expect(result.quality!.maxChannelDiff).toBe(0);

    // Independently re-render rather than trusting the reported figure.
    expect((await renderAndCompare(input.image, result.svg)).lossless).toBe(true);
  });

  it('says it verified by measurement', async () => {
    const result = await vectorize(await asInput(flatArtwork()), { mode: 'lossless' });
    expect(result.notes.join(' ')).toMatch(/Verified bit-exact by rendering/);
  });

  /**
   * An embedded JPEG survives byte for byte, but resvg's decoder rounds its
   * inverse DCT differently, so that candidate is not bit-exact. Strict mode has
   * to notice and move on rather than trusting the construction-time claim.
   */
  it('discards the preserved-JPEG candidate and still succeeds', async () => {
    const input = await asInput(photoLike(96, 72), 'jpeg');
    const result = await vectorize(input, { mode: 'lossless' });
    expect(result.lossless).toBe(true);
    expect(result.notes.join(' ')).toMatch(/Rejected \d+ candidate/);
  });

  it('keeps real geometry for artwork and the bitmap for photographs', async () => {
    const art = await vectorize(await asInput(flatArtwork()), { mode: 'lossless' });
    expect(art.mode).toBe('pixel');

    const photo = await vectorize(await asInput(photoLike(128, 96)), { mode: 'lossless' });
    expect(photo.mode).toBe('embed');
    expect(photo.notes.join(' ')).toMatch(/larger than the embedded bitmap/);
  });

  it('honours --prefer geometry even when the file gets large', async () => {
    const result = await vectorize(await asInput(photoLike(64, 48)), {
      mode: 'lossless', losslessPrefer: 'geometry',
    });
    expect(result.mode).toBe('pixel');
    expect(result.lossless).toBe(true);
  });

  it('honours --prefer size', async () => {
    const result = await vectorize(await asInput(flatArtwork()), {
      mode: 'lossless', losslessPrefer: 'size',
    });
    expect(result.lossless).toBe(true);
    // The embedded PNG beats geometry on this fixture.
    expect(result.mode).toBe('embed');
  });

  it('treats the exact preset the same way', async () => {
    const result = await vectorize(await asInput(pixelArt(2)), { preset: 'exact' });
    expect(result.lossless).toBe(true);
    expect(result.quality!.psnr).toBe(Infinity);
  });
});

describe('byte-identical round trip', () => {
  it('recovers the original file byte for byte', async () => {
    const source = flatArtwork();
    const original = await encode(source, 'png');
    const { image, meta } = await decodeRaster(original);

    const result = await vectorize({ image, meta, bytes: original }, {
      mode: 'embed',
      embed: { strategy: 'preserve' },
    });

    const payload = extractEmbedded(result.svg);
    expect(payload).not.toBeNull();
    expect(payload!.isOriginal).toBe(true);
    expect(payload!.verified).toBe(true);
    expect(bytesEqual(payload!.bytes, original)).toBe(true);
    expect(payload!.actualSha256).toBe(createHash('sha256').update(original).digest('hex'));
  });

  it('records a digest that detects tampering', async () => {
    const original = await encode(pixelArt(2), 'png');
    const { image, meta } = await decodeRaster(original);
    const result = await vectorize({ image, meta, bytes: original }, {
      mode: 'embed',
      embed: { strategy: 'preserve' },
    });

    // Corrupt one base64 character of the payload.
    const tampered = result.svg.replace(/base64,([A-Za-z0-9+/=]{8})/, (m, head: string) =>
      m.replace(head, head[0] === 'A' ? `B${head.slice(1)}` : `A${head.slice(1)}`),
    );
    expect(tampered).not.toBe(result.svg);

    const payload = extractEmbedded(tampered);
    expect(payload).not.toBeNull();
    expect(payload!.verified).toBe(false);
  });

  it('reports honestly when there is no digest to check', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
      '<image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/></svg>';
    const payload = extractEmbedded(svg);
    expect(payload!.recordedSha256).toBeUndefined();
    expect(payload!.verified).toBe(false);
    expect(payload!.isOriginal).toBe(false);
  });

  it('returns null for an SVG with no embedded bitmap', () => {
    const out = vectorizePixels(pixelArt(2));
    expect(extractEmbedded(out.svg)).toBeNull();
  });

  it('identifies the payload media type', async () => {
    const original = await encode(photoLike(32, 32), 'jpeg');
    const { image, meta } = await decodeRaster(original);
    const result = await vectorize({ image, meta, bytes: original }, {
      mode: 'embed',
      embed: { strategy: 'preserve' },
    });
    const payload = extractEmbedded(result.svg)!;
    expect(payload.mime).toBe('image/jpeg');
    expect(payload.extension).toBe('jpg');
    expect(bytesEqual(payload.bytes, original)).toBe(true);
  });
});

/**
 * Base64 is now load-bearing for the byte-identical guarantee: it is what puts
 * the original file into the SVG and takes it back out. A portable
 * implementation replaced `Buffer`'s so the core runs outside Node, so it needs
 * to be exercised directly rather than only through the round trip.
 */
describe('portable base64', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(bytesEqual(fromBase64(toBase64(all)), all)).toBe(true);
  });

  it('handles all three padding cases', () => {
    for (let length = 0; length < 32; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const encoded = toBase64(bytes);
      expect(encoded.length % 4).toBe(0);
      expect(bytesEqual(fromBase64(encoded), bytes)).toBe(true);
    }
  });

  it('agrees with Node\'s implementation', () => {
    for (const length of [1, 2, 3, 7, 64, 255, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 97 + 3) & 0xff;
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('ignores whitespace, which is legal inside a data URI', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const spaced = toBase64(bytes).replace(/(.{4})/g, '$1\n  ');
    expect(bytesEqual(fromBase64(spaced), bytes)).toBe(true);
  });
});
