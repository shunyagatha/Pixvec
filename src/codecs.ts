import type { RasterImage } from './types.js';

/**
 * A registry for formats this package does not decode on its own.
 *
 * HEIC, JPEG XL and JPEG 2000 were all asked for, and the honest position is:
 * the prebuilt libvips that ships with `sharp` cannot read or write any of them
 * (HEVC for patent reasons, JXL and JP2 simply not compiled in), and bundling a
 * WASM codec for each would add tens of megabytes to *every* install for formats
 * most users never touch — the exact bloat the modular design exists to avoid.
 *
 * So instead of shipping the codecs, this ships the socket. A user who needs one
 * installs a WASM decoder themselves and registers it in a few lines; everyone
 * else pays nothing. `decodeRaster` consults the registry by signature, right
 * alongside the built-in BMP/ICO/PNM decoders, and `encodeRaster` consults it by
 * format name before its own switch.
 *
 * ```ts
 * import decodeJxl from '@jsquash/jxl/decode.js';
 * import { registerDecoder } from 'pixvec/codecs';
 *
 * registerDecoder({
 *   format: 'jxl',
 *   // JPEG XL streams start FF 0A, or the ISOBMFF 'JXL ' box.
 *   canDecode: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0x0a,
 *   decode: async (bytes) => {
 *     const { data, width, height } = await decodeJxl(bytes);
 *     return { width, height, data: new Uint8ClampedArray(data.buffer) };
 *   },
 * });
 * // pixvec can now read .jxl anywhere it reads any other format.
 * ```
 *
 * The registry itself is pure — it holds functions, imports nothing — so it
 * lives in the portable core. The codecs a user registers may or may not be.
 */

export interface CustomDecoder {
  /** Format name, e.g. `'jxl'`. Reported by {@link registeredFormats}. */
  format: string;
  /**
   * True when these bytes are this decoder's format. Keep it a cheap
   * signature check on the first few bytes, not a full parse.
   */
  canDecode(bytes: Uint8Array): boolean;
  /** Decode to straight (non-premultiplied) RGBA8. */
  decode(bytes: Uint8Array): Promise<RasterImage> | RasterImage;
}

export interface CustomEncoder {
  format: string;
  encode(img: RasterImage, options?: unknown): Promise<Uint8Array> | Uint8Array;
}

// Most-recently-registered wins, so a later registration can override an earlier
// one (including, deliberately, a built-in format a user wants to handle their
// own way).
const decoders: CustomDecoder[] = [];
const encoders = new Map<string, CustomEncoder>();

export function registerDecoder(decoder: CustomDecoder): void {
  decoders.unshift(decoder);
}

export function registerEncoder(encoder: CustomEncoder): void {
  encoders.set(encoder.format, encoder);
}

/** Remove a previously registered codec. Returns true if something was removed. */
export function unregisterDecoder(format: string): boolean {
  const before = decoders.length;
  for (let i = decoders.length - 1; i >= 0; i--) {
    if (decoders[i].format === format) decoders.splice(i, 1);
  }
  return decoders.length !== before;
}

export function unregisterEncoder(format: string): boolean {
  return encoders.delete(format);
}

/** Find a registered decoder whose signature matches, if any. */
export function findDecoder(bytes: Uint8Array): CustomDecoder | undefined {
  for (const d of decoders) {
    try {
      if (d.canDecode(bytes)) return d;
    } catch {
      // A misbehaving signature check must not sink the whole decode path.
    }
  }
  return undefined;
}

export function findEncoder(format: string): CustomEncoder | undefined {
  return encoders.get(format);
}

/** What the registry currently covers. Feeds `info` and error messages. */
export function registeredFormats(): { decode: string[]; encode: string[] } {
  return {
    decode: [...new Set(decoders.map((d) => d.format))],
    encode: [...encoders.keys()],
  };
}
