import sharp from 'sharp';
import type { RasterFormat, RasterImage, Rgba } from '../types.js';

export interface EncodeOptions {
  format: RasterFormat;
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
}

const OPAQUE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** Formats that cannot carry an alpha channel and therefore need flattening. */
const NO_ALPHA: ReadonlySet<RasterFormat> = new Set<RasterFormat>(['jpeg']);

export async function encodeRaster(img: RasterImage, opts: EncodeOptions): Promise<Buffer> {
  const { format, quality = 90, lossless = false, effort, background = OPAQUE_WHITE, density } = opts;

  let pipeline = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
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
      const never: never = format;
      throw new Error(`Unsupported output format: ${String(never)}`);
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
};

/** Map a file extension (with or without a dot) to an encoder, if we have one. */
export function formatFromExtension(ext: string): RasterFormat | undefined {
  return EXT_TO_FORMAT[ext.replace(/^\./, '').toLowerCase()];
}

export function isRasterExtension(ext: string): boolean {
  return formatFromExtension(ext) !== undefined;
}
