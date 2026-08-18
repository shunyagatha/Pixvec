import { readFile } from 'node:fs/promises';
// sharp 0.35 replaced its `sharp.*` type namespace with named exports, so the
// types are imported explicitly rather than reached through the default. The
// value is loaded lazily (see io/native.ts) so `--omit=optional` installs are
// not dead on arrival; `import type` is erased at compile time, so this line
// pulls in nothing at runtime.
import { type Metadata } from 'sharp';
import { loadSharp } from './native.js';
import type { RasterImage, SourceMeta } from '../types.js';
import { isApng, readApngFrames } from './formats/apng.js';
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
  let sharp: Awaited<ReturnType<typeof loadSharp>>;
  try {
    sharp = await loadSharp();
  } catch (err) {
    // TGA waits for a real codec to decline before it gets a turn. When there is
    // no real codec installed at all, that turn has come and gone — so try it
    // here rather than reporting a missing dependency for a format this package
    // decodes itself. Without this, `--omit=optional` could never read a TGA:
    // the throw above lands before the `metadata()` catch below, which is the
    // only other place the fallback is reached.
    const tga = decodeTgaFallback(bytes);
    if (tga) return finishFallback(tga, bytes, opts);
    throw err;
  }
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

    // Some failures are a specific, nameable limitation rather than "this is
    // not an image". Saying which one, once, beats forwarding the codec's own
    // diagnostics and a list of formats that sends the reader looking in the
    // wrong place.
    const explained = explainCodecFailure(message);
    if (explained) throw new Error(`${explained} (${tidyCodecMessage(message)})`);

    const extra = registeredFormats().decode;
    const registeredNote = extra.length ? `, plus registered: ${extra.join(', ')}` : '';
    throw new Error(
      `Could not read image metadata: ${tidyCodecMessage(message)}. ` +
        `Supported inputs: PNG, JPEG, WebP, AVIF, TIFF, GIF, BMP, ICO, PNM/PPM, TGA${registeredNote}.`,
    );
  }

  let pipeline = base();
  if (applyOrientation) pipeline = pipeline.rotate(); // no argument = honour EXIF

  // Decoding the pixels can fail long after the header parsed cleanly: a TIFF
  // announces its tiling and planar config in the header and only fails when
  // libvips tries to read it, and libheif reports a missing codec at the same
  // point. Left unwrapped, that surfaced the codec's own diagnostics verbatim —
  // six "source: bad seek to N" lines ahead of the one that mattered.
  let data: Buffer;
  let info: { width: number; height: number; channels: number };
  try {
    ({ data, info } = await pipeline
      .toColorspace('srgb')
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    const message = (err as Error).message;
    const explained = explainCodecFailure(message);
    throw new Error(
      explained
        ? `${explained} (${tidyCodecMessage(message)})`
        : `Could not decode this ${raw.format ?? 'image'}: ${tidyCodecMessage(message)}`,
    );
  }

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
    // libvips reports no page count for an APNG at all, so `pages` is
    // undefined and this used to report 1 frame for a 20-frame file. The
    // container itself is the authority; reading acTL costs a chunk walk.
    frames: raw.pages ?? apngFrameCount(bytes) ?? 1,
    bytes: bytes.byteLength,
    orientation: raw.orientation,
  };

  return { image, meta, bytes };
}

/**
 * Strip a codec diagnostic down to the part that carries information.
 *
 * libheif emits one `source: bad seek to N` line per probe while it works out
 * the file layout — six of them precede the real cause on a HEIC — and libvips
 * repeats `tiffload_buffer: load error` once per attempted load. None of it
 * tells the reader anything, and it buries the one line that does.
 *
 * Repeated *phrases* are collapsed too, because libheif concatenates its own
 * prefix as an error propagates: "Memory allocation error: Security limit
 * exceeded: Memory allocation error: Security limit exceeded: Allocating..."
 * is one failure, reported twice inside one string.
 */
export function tidyCodecMessage(message: string): string {
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^source: bad seek to \d+$/i.test(l));

  const deduped = lines.filter((l, i) => lines.indexOf(l) === i);
  const joined = deduped.join('; ');

  // Collapse an immediately repeated "Prefix: Prefix:" run to one.
  return joined.replace(/(\b[\w ]+?: [\w ]+?: )\1/g, '$1');
}

/**
 * Name the limitation behind a codec failure, or null if it is not one we know.
 *
 * Each of these is a genuine capability boundary of the bundled libvips or
 * libheif rather than a broken file, so the useful answer is what the boundary
 * is and what to do about it — not the codec's internal diagnostic.
 */
export function explainCodecFailure(message: string): string | null {
  if (/tiled separate planes not supported/i.test(message)) {
    return 'This TIFF stores tiled data with separate colour planes ' +
      '(PLANARCONFIG_SEPARATE), a combination libvips does not read. ' +
      'Convert it to contiguous planes first — `tiffcp -p contig in.tif out.tif`, ' +
      'or re-save it as a striped TIFF';
  }

  if (/Support for this compression format has not been built in/i.test(message)) {
    return 'This file needs an HEVC decoder, which the bundled libheif does not ' +
      'include — HEIC/HEIF from Apple devices is normally HEVC-coded. ' +
      'Convert it first (macOS `sips -s format png`, or ImageMagick with a ' +
      'HEIC delegate), or use an AVIF instead, which decodes here natively';
  }

  if (/exceeds the security limit/i.test(message)) {
    // Reads as a memory error, but it is libheif declining on principle: the
    // other AVIFs in the format corpus decode at the same sizes, and only the
    // layered one trips this. The limit is libheif's, not a Vecline setting,
    // so there is no option here to point the reader at.
    return 'libheif refused this file under its own security limit. That normally ' +
      'means layered (multi-layer) HEIF/AVIF coding, which it declines to ' +
      'reconstruct — ordinary single-layer AVIF is unaffected. Re-encode it as ' +
      'a flat single-layer AVIF or as PNG';
  }

  return null;
}

/**
 * Frames an APNG actually carries, or null if these bytes are not one.
 *
 * Reports what the file contains rather than what `acTL` claims, since the two
 * differ in a truncated file and the count is used to tell callers how much
 * animation is really there.
 */
function apngFrameCount(bytes: Uint8Array): number | null {
  if (!isApng(bytes)) return null;
  try {
    const n = readApngFrames(bytes).frames.length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
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
