import type { RasterImage } from '../../types.js';
import { latin1, u16le } from './bytes.js';

/**
 * Truevision TGA decoder.
 *
 * TGA has no magic number at the front — only an optional 18-byte footer added
 * in 1989 that plenty of files omit. Detection is therefore a plausibility check
 * on the header, and it must stay conservative: this decoder runs only after
 * libvips has already declined the file, so a false positive here would turn a
 * clear "unsupported format" error into a screen of garbage pixels.
 */

const NO_IMAGE = 0;
const COLOR_MAPPED = 1;
const TRUE_COLOR = 2;
const GRAYSCALE = 3;
const RLE_COLOR_MAPPED = 9;
const RLE_TRUE_COLOR = 10;
const RLE_GRAYSCALE = 11;

const FOOTER = 'TRUEVISION-XFILE.';

/** Conservative sniff: trust the footer, otherwise demand a fully coherent header. */
export function isTga(bytes: Uint8Array): boolean {
  if (bytes.length < 18) return false;

  if (bytes.length >= 26) {
    const footer = latin1(bytes, bytes.length - 18, bytes.length - 1);
    if (footer === FOOTER) return true;
  }

  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const depth = bytes[16];
  const width = u16le(bytes, 12);
  const height = u16le(bytes, 14);

  if (colorMapType > 1) return false;
  if (![NO_IMAGE, COLOR_MAPPED, TRUE_COLOR, GRAYSCALE, RLE_COLOR_MAPPED, RLE_TRUE_COLOR, RLE_GRAYSCALE].includes(imageType)) return false;
  if (imageType === NO_IMAGE) return false;
  if (![8, 15, 16, 24, 32].includes(depth)) return false;
  if (width === 0 || height === 0) return false;
  if ((imageType === COLOR_MAPPED || imageType === RLE_COLOR_MAPPED) !== (colorMapType === 1)) return false;

  // The declared geometry must be able to fit in the file, allowing for RLE.
  const isRle = imageType >= RLE_COLOR_MAPPED;
  const idLength = bytes[0];
  const mapLength = u16le(bytes, 5);
  const mapEntrySize = bytes[7];
  const headerBytes = 18 + idLength + (colorMapType === 1 ? mapLength * Math.ceil(mapEntrySize / 8) : 0);
  const uncompressed = width * height * Math.ceil(depth / 8);
  return isRle ? bytes.length > headerBytes : bytes.length >= headerBytes + uncompressed;
}

export function decodeTga(bytes: Uint8Array): { image: RasterImage; bitDepth: number } {
  if (bytes.length < 18) throw new Error('Truncated TGA header');

  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const mapFirst = u16le(bytes, 3);
  const mapLength = u16le(bytes, 5);
  const mapEntrySize = bytes[7];
  const width = u16le(bytes, 12);
  const height = u16le(bytes, 14);
  const depth = bytes[16];
  const descriptor = bytes[17];

  if (width === 0 || height === 0) throw new Error('TGA has zero dimensions');

  // Bit 5 of the descriptor selects the origin; bit 4 mirrors horizontally.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;

  // Bits 0-3 are the ALPHA BIT COUNT, and reading them is not optional.
  //
  // Zero means the file carries no alpha channel, so the fourth byte of a 32-bit
  // pixel and bit 15 of a 16-bit one are undefined padding that must be ignored.
  // This decoder trusted them anyway, and the result was not subtle: a
  // colour-mapped RLE file with 16-bit map entries and `attributeBits = 0`
  // decoded with 0 of 16,384 pixels opaque -- the entire image transparent, which
  // is why pixel mode emitted an SVG containing no shapes at all and still
  // reported "bit-exact by construction". A 32-bit RLE file with the same
  // declaration came back with 1 of 39,601 pixels opaque.
  //
  // Both files are valid TGA. Plenty of writers leave those bytes as scratch
  // precisely because the header says not to read them.
  const attributeBits = descriptor & 0x0f;

  let p = 18 + idLength;

  let colorMap: Uint8Array | null = null;
  if (colorMapType === 1) {
    const entryBytes = Math.ceil(mapEntrySize / 8);
    colorMap = new Uint8Array(( mapFirst + mapLength) * 4);
    for (let i = 0; i < mapLength; i++) {
      const o = p + i * entryBytes;
      const q = (mapFirst + i) * 4;
      const px = readPixel(bytes, o, mapEntrySize, attributeBits);
      colorMap[q] = px[0]; colorMap[q + 1] = px[1];
      colorMap[q + 2] = px[2]; colorMap[q + 3] = px[3];
    }
    p += mapLength * entryBytes;
  }

  const image: RasterImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const bytesPerPixel = Math.ceil(depth / 8);
  const isRle = imageType >= RLE_COLOR_MAPPED;
  const isMapped = imageType === COLOR_MAPPED || imageType === RLE_COLOR_MAPPED;
  const isGray = imageType === GRAYSCALE || imageType === RLE_GRAYSCALE;

  const total = width * height;
  const pixels = new Uint8Array(total * 4);

  const emit = (at: number, source: number): void => {
    const q = at * 4;
    if (isMapped) {
      const index = depth === 8 ? bytes[source] : u16le(bytes, source);
      const m = index * 4;
      pixels[q] = colorMap![m]; pixels[q + 1] = colorMap![m + 1];
      pixels[q + 2] = colorMap![m + 2]; pixels[q + 3] = colorMap![m + 3];
    } else if (isGray) {
      const v = bytes[source];
      pixels[q] = v; pixels[q + 1] = v; pixels[q + 2] = v;
      pixels[q + 3] = depth === 16 && attributeBits > 0 ? bytes[source + 1] : 255;
    } else {
      const px = readPixel(bytes, source, depth, attributeBits);
      pixels[q] = px[0]; pixels[q + 1] = px[1]; pixels[q + 2] = px[2]; pixels[q + 3] = px[3];
    }
  };

  if (isRle) {
    let written = 0;
    while (written < total && p < bytes.length) {
      const packet = bytes[p++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        // Run packet: one pixel value repeated.
        for (let i = 0; i < count && written < total; i++) emit(written++, p);
        p += bytesPerPixel;
      } else {
        for (let i = 0; i < count && written < total; i++) {
          emit(written++, p);
          p += bytesPerPixel;
        }
      }
    }
  } else {
    for (let i = 0; i < total; i++) {
      const o = p + i * bytesPerPixel;
      if (o + bytesPerPixel > bytes.length) break;
      emit(i, o);
    }
  }

  // A declared alpha channel that is zero everywhere is an unused one.
  //
  // The header can say "8 alpha bits" while the writer leaves the byte at 0 for
  // every pixel, and taking that literally yields a wholly invisible image. Two
  // files in the format-authority corpora do exactly this — a 32-bit and a
  // 16-bit truecolour sample, both decoding 0 of 16,384 pixels opaque — and the
  // same heuristic is what stb_image and libtga apply, for the same reason.
  //
  // Deliberately all-or-nothing: a single non-zero alpha anywhere means the
  // channel is in use and every value is honoured, so a genuinely
  // fully-transparent region inside a real RGBA image is never touched.
  if (attributeBits > 0) {
    let anyOpacity = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) { anyOpacity = true; break; }
    }
    if (!anyOpacity) {
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    }
  }

  // Re-orient into top-down, left-to-right.
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcX = rightToLeft ? width - 1 - x : x;
      const from = (srcY * width + srcX) * 4;
      const to = (y * width + x) * 4;
      image.data[to] = pixels[from];
      image.data[to + 1] = pixels[from + 1];
      image.data[to + 2] = pixels[from + 2];
      image.data[to + 3] = pixels[from + 3];
    }
  }

  return { image, bitDepth: depth };
}

/**
 * Read one BGR(A) pixel at the given depth, returning RGBA.
 *
 * `attributeBits` is the image descriptor's alpha-bit count. When it is 0 the
 * file declares no alpha channel and any alpha-looking byte is padding, so the
 * pixel is opaque regardless of what those bits contain.
 */
function readPixel(
  bytes: Uint8Array,
  offset: number,
  depth: number,
  attributeBits: number,
): [number, number, number, number] {
  switch (depth) {
    case 8: {
      const v = bytes[offset] ?? 0;
      return [v, v, v, 255];
    }
    case 15:
    case 16: {
      const v = u16le(bytes, offset);
      const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
      // Bit 15 is an attribute bit, honoured only at 16 bits per pixel AND only
      // when the header says the bit is meaningful.
      const a = depth === 16 && attributeBits > 0 && (v & 0x8000) === 0 ? 0 : 255;
      return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), a];
    }
    case 24:
      return [bytes[offset + 2] ?? 0, bytes[offset + 1] ?? 0, bytes[offset] ?? 0, 255];
    case 32:
      return [
        bytes[offset + 2] ?? 0, bytes[offset + 1] ?? 0, bytes[offset] ?? 0,
        attributeBits > 0 ? (bytes[offset + 3] ?? 255) : 255,
      ];
    default:
      throw new Error(`Unsupported TGA bit depth ${depth}`);
  }
}
