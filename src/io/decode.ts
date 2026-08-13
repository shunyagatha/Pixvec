import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { RasterImage, SourceMeta } from '../types.js';
import { decodeFallback, decodeTgaFallback, type FallbackResult } from './formats/index.js';

export interface DecodeOptions {
  /**
   * Apply the EXIF orientation tag so the pixels match what a viewer shows.
   * Turn this off when you need the stored buffer verbatim (it can swap the
   * width and height).
   */
  applyOrientation?: boolean;
  /** Guard against decompression bombs. `false` removes the limit entirely. */
  limitInputPixels?: number | false;
}

export interface Decoded {
  image: RasterImage;
  meta: SourceMeta;
  /** The original encoded bytes, kept for lossless embedding. */
  bytes: Uint8Array;
}

const SVG_SNIFF = /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;

/** Cheap content sniff: is this buffer an SVG document rather than a raster? */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  // Only the head matters, and SVG is text — decode a slice, not the whole file.
  // `TextDecoder` rather than `Buffer.toString` so the check works in any runtime.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
  return SVG_SNIFF.test(head);
}

/** sharp needs a `Buffer`; wrap without copying when the input already is one. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Decode any raster the platform understands into straight RGBA8 / sRGB.
 *
 * Three normalisations happen here and each one exists to stop a class of
 * silent corruption:
 *
 * - `toColorspace('srgb')` converts CMYK and greyscale sources, and makes
 *   libvips apply an embedded ICC profile instead of reinterpreting the numbers.
 * - `ensureAlpha()` guarantees a four-channel result so downstream code never
 *   branches on channel count.
 * - 16-bit sources are reduced to 8-bit, because that is the only colour depth
 *   SVG paint servers can express. `embed` mode sidesteps this by carrying the
 *   original bytes through untouched.
 */
export async function decodeRaster(
  input: string | Uint8Array,
  opts: DecodeOptions = {},
): Promise<Decoded> {
  const bytes = typeof input === 'string' ? await readFile(input) : input;

  if (looksLikeSvg(bytes)) {
    throw new Error(
      'Input looks like an SVG document. Use the rasterize path for SVG -> raster.',
    );
  }

  const { applyOrientation = true, limitInputPixels = false } = opts;

  // Formats libvips was not built with are handled in pure TypeScript. They are
  // identified by signature first, because libvips would otherwise reject them
  // with a generic "unsupported image format" that says nothing useful.
  const fallback = decodeFallback(bytes);
  if (fallback) return finishFallback(fallback, bytes, opts);

  const base = () => sharp(asBuffer(bytes), { limitInputPixels, unlimited: true, animated: false });

  let raw: sharp.Metadata;
  try {
    raw = await base().metadata();
  } catch (err) {
    // TGA carries no leading signature, so it only gets a turn once a real
    // codec has declined — guessing earlier risks misreading another format.
    const tga = decodeTgaFallback(bytes);
    if (tga) return finishFallback(tga, bytes, opts);
    throw new Error(
      `Could not read image metadata: ${(err as Error).message}. ` +
        `Supported inputs: PNG, JPEG, WebP, AVIF, TIFF, GIF, BMP, ICO, PNM/PPM, TGA.`,
    );
  }

  let pipeline = base();
  if (applyOrientation) pipeline = pipeline.rotate(); // no argument = honour EXIF

  const { data, info } = await pipeline
    .toColorspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(`Expected 4 channels after normalisation, got ${info.channels}`);
  }

  const image: RasterImage = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };

  const meta: SourceMeta = {
    format: raw.format ?? 'unknown',
    width: info.width,
    height: info.height,
    channels: raw.channels ?? 4,
    depth: raw.depth ?? 'uchar',
    hasAlpha: raw.hasAlpha ?? false,
    space: raw.space ?? 'srgb',
    density: raw.density,
    hasProfile: Boolean(raw.icc),
    frames: raw.pages ?? 1,
    bytes: bytes.byteLength,
    orientation: raw.orientation,
  };

  return { image, meta, bytes };
}

/**
 * Finish a pure-TypeScript decode, delegating embedded PNG/JPEG payloads.
 *
 * A BMP with `BI_PNG` compression, or the 256×256 entry of a modern icon, holds
 * a complete PNG rather than raw pixels. Re-implementing a PNG decoder to reach
 * it would be absurd when libvips is already loaded, so those bytes are simply
 * passed back through the normal path.
 */
async function finishFallback(
  result: FallbackResult,
  original: Uint8Array,
  opts: DecodeOptions,
): Promise<Decoded> {
  if (result.delegate) {
    const inner = await decodeRaster(result.delegate.bytes, opts);
    return {
      image: inner.image,
      // Report the container the user actually handed us, not what was inside it.
      meta: { ...inner.meta, format: result.format, bytes: original.byteLength },
      bytes: original,
    };
  }

  const image = result.image!;
  let hasAlpha = false;
  for (let o = 3; o < image.data.length; o += 4) {
    if (image.data[o] !== 255) { hasAlpha = true; break; }
  }

  return {
    image,
    meta: {
      format: result.format,
      width: image.width,
      height: image.height,
      channels: hasAlpha ? 4 : 3,
      depth: result.channelDepth > 8 ? 'ushort' : 'uchar',
      hasAlpha,
      space: 'srgb',
      hasProfile: false,
      frames: 1,
      bytes: original.byteLength,
    },
    bytes: original,
  };
}
