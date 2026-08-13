import type { RasterImage } from '../../types.js';
import { decodeBmp, isBmp } from './bmp.js';
import { decodeIco, isIco, listIcoEntries } from './ico.js';
import { decodePnm, isPnm } from './pnm.js';
import { decodeTga, isTga } from './tga.js';

export { decodeBmp, isBmp } from './bmp.js';
export { decodeIco, isIco, listIcoEntries, type IcoEntry } from './ico.js';
export { decodePnm, isPnm } from './pnm.js';
export { decodeTga, isTga } from './tga.js';
export {
  encodeBmp, encodePnm, encodeTga, encodeIco, encodeIcoDib,
  type BmpEncodeOptions, type PnmEncodeOptions, type TgaEncodeOptions, type IcoEntryInput,
} from './encoders.js';

/**
 * Formats libvips does not build in, decoded here in pure TypeScript.
 *
 * These four are not exotic — BMP and ICO come out of Windows tooling daily,
 * Netpbm out of scientific and shell pipelines, TGA out of game asset chains —
 * and each is simple and stable enough to implement completely rather than
 * pulling in another native dependency to cover them.
 */
export type FallbackFormat = 'bmp' | 'ico' | 'pnm' | 'tga';

/**
 * The subset identifiable from a leading signature.
 *
 * TGA is excluded by type, not just by convention, so the sniffing path and the
 * last-resort path cannot be confused for one another.
 */
export type SignatureFormat = Exclude<FallbackFormat, 'tga'>;

export interface FallbackResult {
  image?: RasterImage;
  format: FallbackFormat;
  /**
   * Bits per **pixel** as the container stores them — 24 for a truecolour BMP,
   * 8 for a palettised one. Useful to report; not the same thing as colour depth.
   */
  bitDepth: number;
  /**
   * Bits per **channel** in the source, which is what `depth` in the image
   * metadata means. Conflating the two makes a 24-bit BMP look like a 16-bit
   * image, which would send callers hunting for precision that was never there.
   */
  channelDepth: number;
  /**
   * Some containers hold a complete PNG or JPEG rather than raw pixels — a
   * 256×256 ICO entry almost always does. Those bytes come back here to be
   * handed to a real codec instead of being reimplemented badly.
   */
  delegate?: { format: 'png' | 'jpeg'; bytes: Uint8Array };
  /** Extra detail worth surfacing, such as the specific Netpbm variant. */
  detail?: string;
}

/**
 * Identify a format from its magic bytes.
 *
 * TGA is deliberately excluded: it has no leading signature, so guessing at it
 * before a real codec has had its turn risks misreading some other format's
 * header as a plausible TGA. {@link decodeTgaFallback} handles it as a last resort.
 */
export function sniffFallbackFormat(bytes: Uint8Array): SignatureFormat | null {
  if (isBmp(bytes)) return 'bmp';
  if (isIco(bytes)) return 'ico';
  if (isPnm(bytes)) return 'pnm';
  return null;
}

/** Decode one of the signature-identified formats, or return null. */
export function decodeFallback(bytes: Uint8Array): FallbackResult | null {
  const format = sniffFallbackFormat(bytes);
  if (!format) return null;

  switch (format) {
    case 'bmp': {
      const { image, bitDepth, delegate } = decodeBmp(bytes);
      return delegate
        ? { format, bitDepth, channelDepth: 8, delegate }
        : { image, format, bitDepth, channelDepth: 8 };
    }
    case 'ico': {
      const { image, delegate, entry, entries } = decodeIco(bytes);
      const detail = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
        `using ${entry.width}x${entry.height}`;
      return delegate
        ? { format, bitDepth: entry.bitCount, channelDepth: 8, delegate: { format: 'png', bytes: delegate }, detail }
        : { image, format, bitDepth: entry.bitCount, channelDepth: 8, detail };
    }
    case 'pnm': {
      const { image, bitDepth, variant } = decodePnm(bytes);
      return { image, format, bitDepth, channelDepth: bitDepth, detail: variant };
    }
    default: {
      // Unreachable, but it makes adding a format to the union a compile error
      // here rather than a silent null at runtime.
      const exhaustive: never = format;
      throw new Error(`Unhandled fallback format: ${String(exhaustive)}`);
    }
  }
}

/** Last-resort TGA attempt, for use only after a real codec has declined. */
export function decodeTgaFallback(bytes: Uint8Array): FallbackResult | null {
  if (!isTga(bytes)) return null;
  try {
    const { image, bitDepth } = decodeTga(bytes);
    return { image, format: 'tga', bitDepth, channelDepth: 8 };
  } catch {
    return null;
  }
}
