import type { RasterImage } from '../../types.js';

/**
 * BMP decoder.
 *
 * libvips ships without BMP support, and BMP is still what Windows tooling,
 * screenshots and older asset pipelines produce. The format is small enough to
 * decode correctly in full rather than partially: every bit depth, both scan
 * directions, RLE, and BITFIELDS masks are handled here.
 *
 * Two quirks matter in practice and both are handled below:
 *
 * - Rows are padded to a 4-byte boundary, and stored **bottom-up** unless the
 *   height field is negative.
 * - In 32-bit `BI_RGB`, the fourth byte is officially "unused". Plenty of
 *   encoders leave it at zero, so honouring it literally turns the whole image
 *   transparent. When every alpha byte is zero the image is treated as opaque,
 *   which is what every other decoder does and what the author meant.
 */

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_JPEG = 4;
const BI_PNG = 5;

export interface BmpResult {
  image: RasterImage;
  bitDepth: number;
  /** Set when the pixel data is a wholesale PNG or JPEG that a real codec must handle. */
  delegate?: { format: 'png' | 'jpeg'; bytes: Buffer };
}

export function isBmp(bytes: Buffer): boolean {
  return bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

/**
 * Decode a BMP.
 *
 * @param bytes     The file, or for an icon entry, the DIB starting at its header.
 * @param embedded  True when called for an ICO entry: there is no `BM` file
 *                  header, the stored height covers both the colour and mask
 *                  planes, and a 1-bit AND mask follows the pixels.
 */
export function decodeBmp(bytes: Buffer, embedded = false): BmpResult {
  let dibOffset: number;
  let dataOffset: number;

  if (embedded) {
    dibOffset = 0;
    dataOffset = -1; // computed once the palette size is known
  } else {
    if (!isBmp(bytes)) throw new Error('Not a BMP file');
    dibOffset = 14;
    dataOffset = bytes.readUInt32LE(10);
  }

  const dibSize = bytes.readUInt32LE(dibOffset);

  let width: number;
  let storedHeight: number;
  let bitCount: number;
  let compression = BI_RGB;
  let paletteCount = 0;

  if (dibSize === 12) {
    // BITMAPCOREHEADER: 16-bit dimensions, 3-byte palette entries.
    width = bytes.readInt16LE(dibOffset + 4);
    storedHeight = bytes.readInt16LE(dibOffset + 6);
    bitCount = bytes.readUInt16LE(dibOffset + 10);
  } else if (dibSize >= 40) {
    width = bytes.readInt32LE(dibOffset + 4);
    storedHeight = bytes.readInt32LE(dibOffset + 8);
    bitCount = bytes.readUInt16LE(dibOffset + 14);
    compression = bytes.readUInt32LE(dibOffset + 16);
    paletteCount = bytes.readUInt32LE(dibOffset + 32);
  } else {
    throw new Error(`Unsupported BMP header size ${dibSize}`);
  }

  if (compression === BI_JPEG || compression === BI_PNG) {
    const start = dataOffset >= 0 ? dataOffset : dibOffset + dibSize;
    return {
      image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
      bitDepth: bitCount,
      delegate: {
        format: compression === BI_PNG ? 'png' : 'jpeg',
        bytes: bytes.subarray(start),
      },
    };
  }

  // An icon's DIB claims twice its real height: colour plane plus AND mask.
  const topDown = storedHeight < 0;
  let height = Math.abs(storedHeight);
  if (embedded) height = Math.floor(height / 2);

  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw new Error(`Implausible BMP dimensions ${width}x${height}`);
  }

  // BITFIELDS masks sit between the header and the palette.
  let maskOffset = dibOffset + dibSize;
  let masks: [number, number, number, number] | null = null;
  if (compression === BI_BITFIELDS) {
    if (dibSize === 40) {
      masks = [
        bytes.readUInt32LE(maskOffset),
        bytes.readUInt32LE(maskOffset + 4),
        bytes.readUInt32LE(maskOffset + 8),
        0,
      ];
      maskOffset += 12;
    } else {
      // V4/V5 headers carry the masks inside the header itself.
      masks = [
        bytes.readUInt32LE(dibOffset + 40),
        bytes.readUInt32LE(dibOffset + 44),
        bytes.readUInt32LE(dibOffset + 48),
        dibSize >= 56 ? bytes.readUInt32LE(dibOffset + 52) : 0,
      ];
    }
  }

  // Palette.
  const entrySize = dibSize === 12 ? 3 : 4;
  const indexed = bitCount <= 8;
  if (indexed && paletteCount === 0) paletteCount = 1 << bitCount;
  const paletteOffset = maskOffset;
  const palette = indexed ? readPalette(bytes, paletteOffset, paletteCount, entrySize) : null;

  if (dataOffset < 0) {
    dataOffset = paletteOffset + (indexed ? paletteCount * entrySize : 0);
  }

  const image: RasterImage = {
    width, height,
    data: new Uint8ClampedArray(width * height * 4),
  };

  if (compression === BI_RLE8 || compression === BI_RLE4) {
    decodeRle(bytes, dataOffset, image, palette!, compression === BI_RLE4, topDown);
  } else {
    decodePacked(bytes, dataOffset, image, bitCount, palette, masks, topDown);
  }

  if (embedded) applyAndMask(bytes, dataOffset, image, bitCount);
  else if (bitCount === 32 && compression === BI_RGB) assumeOpaqueIfNoAlpha(image);

  return { image, bitDepth: bitCount };
}

function readPalette(bytes: Buffer, offset: number, count: number, entrySize: number): Uint8Array {
  const palette = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = offset + i * entrySize;
    if (o + 2 >= bytes.length) break;
    palette[i * 4] = bytes[o + 2];     // stored BGR
    palette[i * 4 + 1] = bytes[o + 1];
    palette[i * 4 + 2] = bytes[o];
    palette[i * 4 + 3] = 255;
  }
  return palette;
}

function decodePacked(
  bytes: Buffer, dataOffset: number, image: RasterImage,
  bitCount: number, palette: Uint8Array | null,
  masks: [number, number, number, number] | null, topDown: boolean,
): void {
  const { width, height, data } = image;
  const rowSize = Math.ceil((width * bitCount) / 32) * 4;

  const shifts = masks ? masks.map(maskShift) : null;

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcRow * rowSize;
    if (rowStart >= bytes.length) break;

    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;

      switch (bitCount) {
        case 1: case 4: case 8: {
          const bitPos = x * bitCount;
          const byte = bytes[rowStart + (bitPos >> 3)];
          if (byte === undefined) continue;
          const shift = 8 - bitCount - (bitPos & 7);
          const index = (byte >> shift) & ((1 << bitCount) - 1);
          const p = index * 4;
          r = palette![p]; g = palette![p + 1]; b = palette![p + 2];
          break;
        }
        case 16: {
          const o = rowStart + x * 2;
          if (o + 1 >= bytes.length) continue;
          const v = bytes.readUInt16LE(o);
          if (masks && shifts) {
            r = scaleChannel(v, masks[0], shifts[0]);
            g = scaleChannel(v, masks[1], shifts[1]);
            b = scaleChannel(v, masks[2], shifts[2]);
            if (masks[3]) a = scaleChannel(v, masks[3], shifts[3]);
          } else {
            // Default 16-bit layout is X1R5G5B5.
            r = expand5((v >> 10) & 31);
            g = expand5((v >> 5) & 31);
            b = expand5(v & 31);
          }
          break;
        }
        case 24: {
          const o = rowStart + x * 3;
          if (o + 2 >= bytes.length) continue;
          b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
          break;
        }
        case 32: {
          const o = rowStart + x * 4;
          if (o + 3 >= bytes.length) continue;
          if (masks && shifts) {
            const v = bytes.readUInt32LE(o);
            r = scaleChannel(v, masks[0], shifts[0]);
            g = scaleChannel(v, masks[1], shifts[1]);
            b = scaleChannel(v, masks[2], shifts[2]);
            a = masks[3] ? scaleChannel(v, masks[3], shifts[3]) : 255;
          } else {
            b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2]; a = bytes[o + 3];
          }
          break;
        }
        default:
          throw new Error(`Unsupported BMP bit depth ${bitCount}`);
      }

      data[out] = r; data[out + 1] = g; data[out + 2] = b; data[out + 3] = a;
    }
  }
}

/** Run-length encoded 8- and 4-bit BMPs, including the delta and literal escapes. */
function decodeRle(
  bytes: Buffer, dataOffset: number, image: RasterImage,
  palette: Uint8Array, is4Bit: boolean, topDown: boolean,
): void {
  const { width, height, data } = image;
  let p = dataOffset;
  let x = 0;
  let y = 0;

  const put = (index: number): void => {
    if (x >= width || y >= height) return;
    const row = topDown ? y : height - 1 - y;
    const out = (row * width + x) * 4;
    const q = index * 4;
    data[out] = palette[q]; data[out + 1] = palette[q + 1];
    data[out + 2] = palette[q + 2]; data[out + 3] = 255;
    x++;
  };

  while (p + 1 < bytes.length && y < height) {
    const count = bytes[p++];
    const value = bytes[p++];

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        put(is4Bit ? (i % 2 === 0 ? value >> 4 : value & 15) : value);
      }
      continue;
    }

    // count === 0 introduces an escape code.
    if (value === 0) { x = 0; y++; }
    else if (value === 1) break;                    // end of bitmap
    else if (value === 2) {                         // delta
      x += bytes[p++] ?? 0;
      y += bytes[p++] ?? 0;
    } else {
      // Absolute mode: `value` literal pixels, padded to a 16-bit boundary.
      if (is4Bit) {
        for (let i = 0; i < value; i++) {
          const byte = bytes[p + (i >> 1)];
          if (byte === undefined) break;
          put(i % 2 === 0 ? byte >> 4 : byte & 15);
        }
        p += Math.ceil(value / 2);
      } else {
        for (let i = 0; i < value; i++) {
          if (bytes[p + i] === undefined) break;
          put(bytes[p + i]);
        }
        p += value;
      }
      if (p & 1) p++;
    }
  }
}

/**
 * Apply an icon's 1-bit AND mask.
 *
 * ICO entries predate alpha channels: transparency lives in a separate bitmask
 * appended after the colour plane, where a set bit means "show the background".
 * A 32-bit icon usually carries a real alpha channel too, so the mask is only
 * consulted when there is no alpha information to trust.
 */
function applyAndMask(bytes: Buffer, dataOffset: number, image: RasterImage, bitCount: number): void {
  const { width, height, data } = image;

  if (bitCount === 32 && hasAnyAlpha(image)) return;

  const colorRowSize = Math.ceil((width * bitCount) / 32) * 4;
  const maskOffset = dataOffset + colorRowSize * height;
  const maskRowSize = Math.ceil(width / 32) * 4;

  if (maskOffset + maskRowSize * height > bytes.length) {
    // No usable mask; a 32-bit icon without alpha is simply opaque.
    if (bitCount === 32) assumeOpaqueIfNoAlpha(image);
    return;
  }

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const rowStart = maskOffset + srcRow * maskRowSize;
    for (let x = 0; x < width; x++) {
      const byte = bytes[rowStart + (x >> 3)];
      if (byte === undefined) continue;
      const transparent = (byte >> (7 - (x & 7))) & 1;
      if (transparent) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}

function hasAnyAlpha(image: RasterImage): boolean {
  const d = image.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 0) return true;
  return false;
}

/** Treat an all-zero alpha channel as "the encoder never filled it in". */
function assumeOpaqueIfNoAlpha(image: RasterImage): void {
  if (hasAnyAlpha(image)) return;
  const d = image.data;
  for (let o = 3; o < d.length; o += 4) d[o] = 255;
}

function maskShift(mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  return shift;
}

/** Extract a masked field and rescale it to a full 0–255 range. */
function scaleChannel(value: number, mask: number, shift: number): number {
  if (mask === 0) return 0;
  const field = (value & mask) >>> shift;
  const max = mask >>> shift;
  return max === 0 ? 0 : Math.round((field * 255) / max);
}

function expand5(v: number): number {
  // Replicate the high bits so 31 maps to 255 rather than 248.
  return (v << 3) | (v >> 2);
}
