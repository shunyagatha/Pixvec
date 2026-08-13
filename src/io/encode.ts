import sharp from 'sharp';
import type { RasterFormat, RasterImage, Rgba } from '../types.js';
import {
  encodeBmp, encodeIco, encodeIcoDib, encodePnm, encodeTga,
  type BmpEncodeOptions, type PnmEncodeOptions, type TgaEncodeOptions,
} from './formats/encoders.js';
import { findEncoder, registeredFormats } from '../codecs.js';

export interface EncodeOptions {
  /**
   * A built-in format, or the name of a codec registered via `pixvec/codecs`.
   * The string escape hatch is what lets a user-supplied HEIC/JXL encoder be a
   * valid target here without widening the built-in union.
   */
  format: RasterFormat | (string & {});
  /** 1–100. Ignored by PNG and by lossless WebP. */
  quality?: number;
  /** WebP / AVIF: encode losslessly. */
  lossless?: boolean;
  /** Effort/compression knob: 0–9 for PNG, 0–6 for WebP, 0–9 for AVIF. */
  effort?: number;
  /** Colour to composite over when the target format has no alpha channel. */
  background?: Rgba;
  /** Written into the container so viewers report the right physical size. */
  density?: number;
  /**
   * Format-specific encoder knobs for the pure-TypeScript encoders. Ignored for
   * the libvips-backed formats. Without these, `bmp`/`pnm`/`tga` are reachable
   * but stuck on their defaults — 24/32-bit BMP, P6 PNM, RLE TGA — with no way
   * to request greyscale PNM or an uncompressed TGA.
   */
  bmp?: Omit<BmpEncodeOptions, 'background'>;
  pnm?: Omit<PnmEncodeOptions, 'background'>;
  tga?: Omit<TgaEncodeOptions, 'background'>;
}

const OPAQUE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** Wrap raw RGBA for sharp without copying when it is already a Buffer. */
function rawBuffer(img: RasterImage): Buffer {
  return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

/** Formats that cannot carry an alpha channel and therefore need flattening. */
const NO_ALPHA: ReadonlySet<string> = new Set<string>(['jpeg']);

export async function encodeRaster(img: RasterImage, opts: EncodeOptions): Promise<Buffer> {
  const { format, quality = 90, lossless = false, effort, background = OPAQUE_WHITE, density } = opts;

  // A user-registered encoder wins for its format, so a WASM HEIC/JXL encoder
  // slots in as a first-class output target.
  const custom = findEncoder(format);
  if (custom) {
    const out = await custom.encode(img, opts);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }

  // Formats libvips cannot write are handled by this package's own encoders,
  // so the conversion matrix is square: anything readable is also writable.
  switch (format) {
    case 'bmp':
      return Buffer.from(encodeBmp(img, { background, ...opts.bmp }));
    case 'pnm':
      return Buffer.from(encodePnm(img, { background, ...opts.pnm }));
    case 'tga':
      // RLE is a clear win on the flat artwork that reaches TGA in practice,
      // and the encoder falls back to raw packets rather than inflating noise.
      // A caller can turn it off via `opts.tga.rle` when they want raw packets.
      return Buffer.from(encodeTga(img, { background, rle: true, ...opts.tga }));
    case 'ico': {
      // PNG payloads are what every icon above 48px uses, and libvips is right
      // here, so use it rather than the larger uncompressed DIB.
      const png = await sharp(rawBuffer(img), {
        raw: { width: img.width, height: img.height, channels: 4 },
      }).png({ compressionLevel: 9 }).toBuffer();
      const usePng = img.width > 48 || img.height > 48 || png.length < encodeIcoDib(img).length;
      return Buffer.from(
        encodeIco([{
          width: img.width,
          height: img.height,
          payload: usePng ? png : encodeIcoDib(img),
        }]),
      );
    }
    default:
      break;
  }

  let pipeline = sharp(rawBuffer(img), {
    raw: { width: img.width, height: img.height, channels: 4 },
  });

  if (NO_ALPHA.has(format)) {
    pipeline = pipeline.flatten({ background: { r: background.r, g: background.g, b: background.b } });
  }
  if (density) pipeline = pipeline.withMetadata({ density });

  switch (format) {
    case 'png':
      // `palette` is deliberately off: indexing is lossy for >256-colour output
      // and this library's contract is that PNG round-trips exactly.
      return pipeline
        .png({ compressionLevel: clamp(effort ?? 9, 0, 9), effort: 10, palette: false })
        .toBuffer();

    case 'jpeg':
      return pipeline
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' })
        .toBuffer();

    case 'webp':
      return pipeline
        .webp({ quality, lossless, effort: clamp(effort ?? 6, 0, 6), alphaQuality: 100 })
        .toBuffer();

    case 'avif':
      return pipeline
        .avif({ quality, lossless, effort: clamp(effort ?? 5, 0, 9), chromaSubsampling: '4:4:4' })
        .toBuffer();

    case 'tiff':
      return pipeline.tiff({ compression: 'deflate', quality }).toBuffer();

    case 'gif':
      return pipeline.gif({ effort: clamp(effort ?? 7, 1, 10) }).toBuffer();

    default: {
      // Reached only for a string outside the built-in union with no encoder
      // registered for it. Name the escape hatch so the fix is obvious.
      const registered = registeredFormats().encode;
      const note = registered.length ? ` Registered: ${registered.join(', ')}.` : '';
      throw new Error(
        `Unsupported output format: ${String(format)}. ` +
          `Register an encoder for it via pixvec/codecs, or use a built-in format.${note}`,
      );
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

const EXT_TO_FORMAT: Record<string, RasterFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  webp: 'webp',
  avif: 'avif',
  tif: 'tiff',
  tiff: 'tiff',
  gif: 'gif',
  bmp: 'bmp',
  dib: 'bmp',
  ico: 'ico',
  cur: 'ico',
  pnm: 'pnm',
  ppm: 'pnm',
  pgm: 'pnm',
  pbm: 'pnm',
  tga: 'tga',
  targa: 'tga',
  icb: 'tga',
  vda: 'tga',
  vst: 'tga',
};

/** Map a file extension (with or without a dot) to an encoder, if we have one. */
export function formatFromExtension(ext: string): RasterFormat | undefined {
  return EXT_TO_FORMAT[ext.replace(/^\./, '').toLowerCase()];
}

export function isRasterExtension(ext: string): boolean {
  return formatFromExtension(ext) !== undefined;
}
