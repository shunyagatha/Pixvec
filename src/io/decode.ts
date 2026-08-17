import { readFile } from 'node:fs/promises';
// sharp 0.35 replaced its `sharp.*` type namespace with named exports, so the
// types are imported explicitly rather than reached through the default. The
// value is loaded lazily (see io/native.ts) so `--omit=optional` installs are
// not dead on arrival; `import type` is erased at compile time, so this line
// pulls in nothing at runtime.
import { type Metadata } from 'sharp';
import { loadSharp } from './native.js';
import type { RasterImage, SourceMeta } from '../types.js';
import { decodeFallback, decodeTgaFallback, type FallbackResult } from './formats/index.js';
import { findDecoder, registeredFormats, type CustomDecoder } from '../codecs.js';

/**
 * The most pixels a decode will materialise, unless a caller says otherwise.
 *
 * 268 402 689 is libvips' own default (0x3FFF²) and roughly a 16 000 × 16 000
 * photograph, so it is far above any real image this tool is pointed at and far
 * below the sizes that turn a small file into gigabytes of RAM.
 *
 * This used to default to `false` — no limit at all — with `unlimited: true`
 * alongside it, which also switched off libvips' internal guards, and no caller
 * anywhere passed a number. A 380 KB greyscale PNG of all-zero pixels declaring
 * 20000 × 20000 decoded to **1.60 GB** of RGBA without complaint, through the
 * public API, the CLI and every MCP tool. The option existed and was documented
 * as a bomb guard; it was simply never on.
 */
export const DEFAULT_MAX_INPUT_PIXELS = 268_402_689;

/**
 * The ceiling every decode falls back to when a caller does not name one.
 *
 * Mutable so a host process can lower it once instead of threading an option
 * through every call site — the CLI reaches this decoder from twenty places,
 * and a `--max-pixels` wired through nineteen of them would be a limit that
 * lies. An explicit `limitInputPixels` always wins, so a library caller is
 * never affected by what some other part of the process decided.
 *
 * Deliberately settable only downward-or-upward by an explicit call: it is not
 * read from the environment, because a decompression guard that a stray
 * variable can switch off is not a guard.
 */
let processMaxInputPixels: number | false = DEFAULT_MAX_INPUT_PIXELS;

/** Set the fallback ceiling for decodes that do not specify one. */
export function setDefaultMaxInputPixels(limit: number | false): void {
  processMaxInputPixels = limit;
}

/** The fallback ceiling currently in force. */
export function getDefaultMaxInputPixels(): number | false {
  return processMaxInputPixels;
}

export interface DecodeOptions {
  /**
   * Apply the EXIF orientation tag so the pixels match what a viewer shows.
   * Turn this off when you need the stored buffer verbatim (it can swap the
   * width and height).
   */
  applyOrientation?: boolean;
  /**
   * Guard against decompression bombs. Defaults to
   * {@link DEFAULT_MAX_INPUT_PIXELS}. Pass a larger number for a genuinely huge
   * image, or `false` to remove the limit — only for input you produced
   * yourself, never for a file someone sent you.
   */
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

  const { applyOrientation = true, limitInputPixels = processMaxInputPixels } = opts;

  // Formats libvips was not built with are handled in pure TypeScript. They are
  // identified by signature first, because libvips would otherwise reject them
  // with a generic "unsupported image format" that says nothing useful.
  const fallback = decodeFallback(bytes);
  if (fallback) return finishFallback(fallback, bytes, opts);

  // A user-registered codec (e.g. a WASM HEIC/JXL decoder) gets the same
  // signature-tier treatment as the built-in fallbacks, so once registered its
  // format reads anywhere any other format does.
  const custom = findDecoder(bytes);
  if (custom) return finishCustomDecode(custom, bytes);

  // `unlimited` is deliberately left at its default (false): it switches off
  // libvips' own safety limits, which is the opposite of what a decoder handed
  // untrusted bytes should do.
  const sharp = await loadSharp();
  const base = () => sharp(asBuffer(bytes), { limitInputPixels, animated: false });

  let raw: Metadata;
  try {
    raw = await base().metadata();
  } catch (err) {
    // TGA carries no leading signature, so it only gets a turn once a real
    // codec has declined — guessing earlier risks misreading another format.
    const tga = decodeTgaFallback(bytes);
    if (tga) return finishFallback(tga, bytes, opts);

    // A size refusal is not a format problem, and listing the supported formats
    // in answer to one sends the reader looking in the wrong place entirely.
    const message = (err as Error).message;
    if (/exceeds pixel limit/i.test(message)) {
      const cap = limitInputPixels === false ? 'the limit' : `${limitInputPixels.toLocaleString('en-US')} pixels`;
      throw new Error(
        `This image declares more pixels than ${cap}, so it was not decoded. ` +
          'That guard exists because a small file can declare an enormous canvas — ' +
          'a 380 KB PNG can ask for 1.6 GB of memory. ' +
          'If the image is genuinely this large and you trust it, raise or remove the ' +
          'cap with the `limitInputPixels` option.',
      );
    }

    const extra = registeredFormats().decode;
    const registeredNote = extra.length ? `, plus registered: ${extra.join(', ')}` : '';
    throw new Error(
      `Could not read image metadata: ${message}. ` +
        `Supported inputs: PNG, JPEG, WebP, AVIF, TIFF, GIF, BMP, ICO, PNM/PPM, TGA${registeredNote}.`,
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

/** Run a user-registered decoder and package its result like any other decode. */
async function finishCustomDecode(decoder: CustomDecoder, original: Uint8Array): Promise<Decoded> {
  const image = await decoder.decode(original);
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error(
      `Registered '${decoder.format}' decoder returned ${image.data.length} bytes for a ` +
        `${image.width}x${image.height} image; expected ${image.width * image.height * 4} (RGBA8).`,
    );
  }
  let hasAlpha = false;
  for (let o = 3; o < image.data.length; o += 4) {
    if (image.data[o] !== 255) { hasAlpha = true; break; }
  }
  return {
    image,
    meta: {
      format: decoder.format,
      width: image.width,
      height: image.height,
      channels: hasAlpha ? 4 : 3,
      depth: 'uchar',
      hasAlpha,
      space: 'srgb',
      hasProfile: false,
      frames: 1,
      bytes: original.byteLength,
    },
    bytes: original,
  };
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
