import type { RasterImage } from '../../types.js';
import { decodeBmp } from './bmp.js';

/**
 * Windows icon (ICO) and cursor (CUR) container.
 *
 * An icon file is a directory of independent images at different sizes, so
 * "decode the icon" needs a policy: this picks the largest, then the deepest
 * colour, which is what a user converting `favicon.ico` to SVG expects to get.
 *
 * Each entry is either a complete PNG (common since Vista, for 256×256) or a
 * headerless BMP whose stored height is doubled to cover the AND transparency
 * mask. Both cases are handled; the PNG case is handed back for a real decoder.
 */

export interface IcoEntry {
  width: number;
  height: number;
  bitCount: number;
  offset: number;
  length: number;
  /** True when the payload is a whole PNG file rather than a raw DIB. */
  isPng: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isIco(bytes: Buffer): boolean {
  if (bytes.length < 6) return false;
  if (bytes.readUInt16LE(0) !== 0) return false;
  const type = bytes.readUInt16LE(2);
  if (type !== 1 && type !== 2) return false; // 1 = icon, 2 = cursor
  const count = bytes.readUInt16LE(4);
  return count > 0 && bytes.length >= 6 + count * 16;
}

export function listIcoEntries(bytes: Buffer): IcoEntry[] {
  const count = bytes.readUInt16LE(4);
  const entries: IcoEntry[] = [];

  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > bytes.length) break;
    // A stored dimension of 0 means 256 — the field is a single byte.
    const width = bytes[o] === 0 ? 256 : bytes[o];
    const height = bytes[o + 1] === 0 ? 256 : bytes[o + 1];
    const bitCount = bytes.readUInt16LE(o + 6);
    const length = bytes.readUInt32LE(o + 8);
    const offset = bytes.readUInt32LE(o + 12);
    if (offset + length > bytes.length) continue;

    entries.push({
      width, height, bitCount, offset, length,
      isPng: bytes.subarray(offset, offset + 8).equals(PNG_SIGNATURE),
    });
  }

  return entries;
}

export interface IcoResult {
  image?: RasterImage;
  /** Set when the chosen entry is a PNG that a real codec must decode. */
  delegate?: Buffer;
  entry: IcoEntry;
  entries: IcoEntry[];
}

export function decodeIco(bytes: Buffer, index?: number): IcoResult {
  if (!isIco(bytes)) throw new Error('Not an ICO/CUR file');

  const entries = listIcoEntries(bytes);
  if (entries.length === 0) throw new Error('ICO contains no usable entries');

  const chosen = index !== undefined
    ? entries[index]
    : [...entries].sort(
        (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount,
      )[0];

  if (!chosen) throw new Error(`ICO has no entry at index ${index}`);

  const payload = bytes.subarray(chosen.offset, chosen.offset + chosen.length);

  if (chosen.isPng) {
    return { delegate: payload, entry: chosen, entries };
  }

  const { image } = decodeBmp(payload, true);
  return { image, entry: chosen, entries };
}
