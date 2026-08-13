import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { RasterImage, SourceMeta } from '../types.js';

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
  bytes: Buffer;
}

const SVG_SNIFF = /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;

/** Cheap content sniff: is this buffer an SVG document rather than a raster? */
export function looksLikeSvg(bytes: Buffer): boolean {
  // Only the head matters, and SVG is text — decode a slice, not the whole file.
  const head = bytes.subarray(0, 2048).toString('utf8');
  return SVG_SNIFF.test(head);
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
  input: string | Buffer,
  opts: DecodeOptions = {},
): Promise<Decoded> {
  const bytes = typeof input === 'string' ? await readFile(input) : input;

  if (looksLikeSvg(bytes)) {
    throw new Error(
      'Input looks like an SVG document. Use the rasterize path for SVG -> raster.',
    );
  }

  const { applyOrientation = true, limitInputPixels = false } = opts;

  const base = () => sharp(bytes, { limitInputPixels, unlimited: true, animated: false });

  let raw: sharp.Metadata;
  try {
    raw = await base().metadata();
  } catch (err) {
    throw new Error(`Could not read image metadata: ${(err as Error).message}`);
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
