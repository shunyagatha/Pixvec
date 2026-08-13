import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { decodeRaster, looksLikeSvg } from '../src/io/decode.js';
import { encodeRaster, formatFromExtension } from '../src/io/encode.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { encode, flatArtwork, pixelArt } from './fixtures.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vexel-io-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('looksLikeSvg', () => {
  it('recognises SVG with and without a prologue', () => {
    expect(looksLikeSvg(Buffer.from('<svg xmlns="..."></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<?xml version="1.0"?>\n<svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('  \n<!-- hello -->\n<svg >'))).toBe(true);
  });

  it('rejects rasters and lookalikes', () => {
    expect(looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(looksLikeSvg(Buffer.from('<svgx></svgx>'))).toBe(false);
    expect(looksLikeSvg(Buffer.from('not an image'))).toBe(false);
  });
});

describe('decodeRaster', () => {
  it('normalises every supported format to RGBA', async () => {
    const source = flatArtwork(40, 30);
    for (const format of ['png', 'webp', 'tiff'] as const) {
      const bytes = await encode(source, format);
      const { image, meta } = await decodeRaster(bytes);
      expect(image.width).toBe(40);
      expect(image.height).toBe(30);
      expect(image.data).toHaveLength(40 * 30 * 4);
      expect(meta.format).toBe(format);
      // These are all lossless encoders, so the pixels must survive intact.
      expect(compareImages(source, image).lossless).toBe(true);
    }
  });

  it('expands greyscale to four channels', async () => {
    const grey = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 90, g: 90, b: 90 } },
    }).greyscale().png().toBuffer();

    const { image } = await decodeRaster(grey);
    expect(image.data[3]).toBe(255);
    expect(image.data[0]).toBe(image.data[1]);
    expect(image.data[1]).toBe(image.data[2]);
  });

  it('applies EXIF orientation so pixels match what a viewer shows', async () => {
    // A 4x2 image tagged "rotate 90" must decode as 2x4.
    const tagged = await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const applied = await decodeRaster(tagged, { applyOrientation: true });
    expect([applied.image.width, applied.image.height]).toEqual([2, 4]);

    const raw = await decodeRaster(tagged, { applyOrientation: false });
    expect([raw.image.width, raw.image.height]).toEqual([4, 2]);
  });

  it('rejects SVG input with a pointer to the right entry point', async () => {
    await expect(decodeRaster(Buffer.from('<svg xmlns="x"/>'))).rejects.toThrow(/rasterize/i);
  });
});

describe('encodeRaster', () => {
  it('round-trips losslessly through PNG', async () => {
    const source = pixelArt(3);
    const png = await encodeRaster(source, { format: 'png' });
    const { image } = await decodeRaster(png);
    expect(compareImages(source, image).lossless).toBe(true);
  });

  it('round-trips losslessly through WebP', async () => {
    const source = pixelArt(3);
    const webp = await encodeRaster(source, { format: 'webp', lossless: true });
    const { image } = await decodeRaster(webp);
    expect(compareImages(source, image).lossless).toBe(true);
  });

  it('flattens alpha onto the background for JPEG', async () => {
    const source = pixelArt(3); // corners are fully transparent
    const jpeg = await encodeRaster(source, {
      format: 'jpeg',
      quality: 100,
      background: { r: 255, g: 0, b: 255, a: 255 },
    });
    const { image } = await decodeRaster(jpeg);
    expect(image.data[3]).toBe(255);
    expect(image.data[0]).toBeGreaterThan(200); // magenta showing through
    expect(image.data[2]).toBeGreaterThan(200);
  });

  it('maps extensions to encoders', () => {
    expect(formatFromExtension('.JPG')).toBe('jpeg');
    expect(formatFromExtension('webp')).toBe('webp');
    expect(formatFromExtension('.tif')).toBe('tiff');
    expect(formatFromExtension('.psd')).toBeUndefined();
  });
});

describe('rasterizeSvg', () => {
  const square = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#3060a0"/></svg>`;

  it('renders at the intrinsic size by default', async () => {
    const { image, intrinsic } = await rasterizeSvg(square(37, 19));
    expect([image.width, image.height]).toEqual([37, 19]);
    expect(intrinsic).toEqual({ width: 37, height: 19 });
  });

  it('scales by zoom, width, and height', async () => {
    expect((await rasterizeSvg(square(40, 20), { scale: 3 })).image.width).toBe(120);
    expect((await rasterizeSvg(square(40, 20), { width: 200 })).image.width).toBe(200);
    expect((await rasterizeSvg(square(40, 20), { height: 100 })).image.height).toBe(100);
  });

  it('leaves the canvas transparent unless a background is given', async () => {
    const bare = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>`;
    expect((await rasterizeSvg(bare)).image.data[3]).toBe(0);
    const painted = await rasterizeSvg(bare, { background: { r: 12, g: 34, b: 56, a: 255 } });
    expect(Array.from(painted.image.data.slice(0, 4))).toEqual([12, 34, 56, 255]);
  });

  /**
   * resvg returns premultiplied pixels; this library un-premultiplies them to
   * avoid a PNG encode/decode round trip. The two paths must agree exactly, or
   * every quality number downstream is measured against the wrong reference.
   */
  it('un-premultiplies exactly as resvg\'s own PNG export does', async () => {
    let body = '';
    for (let a = 0; a < 256; a++) {
      body += `<rect x="${a}" y="0" width="1" height="1" fill="rgb(220,130,40)" fill-opacity="${a / 255}"/>`;
      body += `<rect x="${a}" y="1" width="1" height="1" fill="rgb(3,250,17)" fill-opacity="${a / 255}"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="2">${body}</svg>`;

    const ours = await rasterizeSvg(svg);
    const viaPng = await decodeRaster(await encodeRaster(ours.image, { format: 'png' }));
    expect(compareImages(ours.image, viaPng.image, { alphaMode: 'straight' }).lossless).toBe(true);
  });

  it('inlines external image references relative to the SVG', async () => {
    const png = await encode(pixelArt(2), 'png');
    await writeFile(join(dir, 'sprite.png'), png);
    const svgPath = join(dir, 'doc.svg');
    await writeFile(
      svgPath,
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
        `<image width="16" height="16" href="sprite.png"/></svg>`,
    );

    const { readFile } = await import('node:fs/promises');
    const { image, inlined } = await rasterizeSvg(await readFile(svgPath), { baseDir: dir });

    expect(inlined).toHaveLength(1);
    // Without inlining resvg would render nothing at all.
    const anyOpaque = Array.from({ length: image.width * image.height })
      .some((_, i) => image.data[i * 4 + 3] > 0);
    expect(anyOpaque).toBe(true);
  });

  it('reports a useful error for malformed SVG', async () => {
    await expect(rasterizeSvg('<svg><unclosed>')).rejects.toThrow(/Failed to parse SVG/);
  });
});
