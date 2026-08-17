import type { RasterImage } from '../../types.js';
import { u16be } from './bytes.js';

/**
 * Netpbm (PBM/PGM/PPM) decoder, covering both the ASCII and binary variants.
 *
 * These are the formats scientific and Unix pipelines fall back to precisely
 * because they are trivial to write — which means they turn up as the output of
 * a one-off script far more often than their obscurity suggests.
 *
 * The parsing quirk worth knowing: comments begin with `#` and run to end of
 * line, and they may appear *anywhere* whitespace is allowed, including between
 * the width and the height.
 */

type Variant = 1 | 2 | 3 | 4 | 5 | 6;

export function isPnm(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x36;
}

export function decodePnm(bytes: Uint8Array): { image: RasterImage; bitDepth: number; variant: string } {
  if (!isPnm(bytes)) throw new Error('Not a Netpbm file');

  const variant = (bytes[1] - 0x30) as Variant;
  const reader = new HeaderReader(bytes, 2);

  const width = reader.nextInt();
  const height = reader.nextInt();
  // Bitmaps are inherently one bit, so they carry no maximum-value field.
  const maxValue = variant === 1 || variant === 4 ? 1 : reader.nextInt();

  if (width <= 0 || height <= 0) throw new Error(`Implausible Netpbm dimensions ${width}x${height}`);
  if (maxValue <= 0 || maxValue > 65535) throw new Error(`Invalid Netpbm maxval ${maxValue}`);

  const image: RasterImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const wide = maxValue > 255;
  const scale = (v: number): number => Math.round((v / maxValue) * 255);

  if (variant <= 3) {
    // ASCII payloads: whitespace-separated integers, comments still permitted.
    const ascii = new HeaderReader(bytes, reader.offset);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      if (variant === 1) {
        // 1 means black in PBM — the opposite of every other format here. Read as
        // a single character, because plain bitmaps may pack samples with no
        // separator at all; see `nextBit`.
        const v = ascii.nextBit() ? 0 : 255;
        image.data[o] = v; image.data[o + 1] = v; image.data[o + 2] = v;
      } else if (variant === 2) {
        const v = scale(ascii.nextInt());
        image.data[o] = v; image.data[o + 1] = v; image.data[o + 2] = v;
      } else {
        image.data[o] = scale(ascii.nextInt());
        image.data[o + 1] = scale(ascii.nextInt());
        image.data[o + 2] = scale(ascii.nextInt());
      }
      image.data[o + 3] = 255;
    }
    return { image, bitDepth: wide ? 16 : 8, variant: `P${variant}` };
  }

  // Binary payloads begin immediately after exactly one whitespace character.
  let p = reader.offset;

  if (variant === 4) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = bytes[p + y * rowBytes + (x >> 3)] ?? 0;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 0 : 255;
        const o = (y * width + x) * 4;
        image.data[o] = v; image.data[o + 1] = v; image.data[o + 2] = v; image.data[o + 3] = 255;
      }
    }
    return { image, bitDepth: 1, variant: 'P4' };
  }

  const channels = variant === 5 ? 1 : 3;
  const step = wide ? 2 : 1;
  const read = (at: number): number => (wide ? (u16be(bytes, at)) : bytes[at] ?? 0);

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const src = p + i * channels * step;
    if (src + channels * step > bytes.length) break;
    if (channels === 1) {
      const v = scale(read(src));
      image.data[o] = v; image.data[o + 1] = v; image.data[o + 2] = v;
    } else {
      image.data[o] = scale(read(src));
      image.data[o + 1] = scale(read(src + step));
      image.data[o + 2] = scale(read(src + step * 2));
    }
    image.data[o + 3] = 255;
  }

  return { image, bitDepth: wide ? 16 : 8, variant: `P${variant}` };
}

/** Reads whitespace-separated integers, skipping `#` comments wherever they appear. */
class HeaderReader {
  constructor(private readonly bytes: Uint8Array, public offset: number) {}

  /**
   * One sample of a plain (ASCII) bitmap — a single `0` or `1` character.
   *
   * P1 is the one Netpbm variant whose samples are *characters*, not numbers, and
   * separating whitespace is optional. Real files exploit that: a 128-wide row is
   * written as `1111111100000...` with nothing between the samples. Reading those
   * with {@link nextInt} consumes the maximal digit run, so an entire row became
   * one enormous integer, the payload ran out early, and the file was rejected as
   * "Malformed Netpbm header: expected a number" — a valid image refused by a
   * decoder that advertises PBM support.
   *
   * P2 and P3 genuinely are whitespace-separated multi-digit values and must keep
   * using {@link nextInt}; only the bitmap is character-per-sample.
   */
  nextBit(): number {
    this.skipSeparators();
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset];
      if (c === 0x30 || c === 0x31) { this.offset++; return c - 0x30; }
      // Whitespace *is* allowed between samples, just not required.
      if (isSpace(c) || c === 0x23) { this.skipSeparators(); continue; }
      throw new Error(`Malformed Netpbm bitmap: expected 0 or 1, got byte 0x${c.toString(16)}`);
    }
    throw new Error('Malformed Netpbm bitmap: payload ended before every pixel was read');
  }

  nextInt(): number {
    this.skipSeparators();
    let value = 0;
    let digits = 0;
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset];
      if (c < 0x30 || c > 0x39) break;
      value = value * 10 + (c - 0x30);
      digits++;
      this.offset++;
    }
    if (digits === 0) throw new Error('Malformed Netpbm header: expected a number');
    // Binary payloads start after exactly one whitespace byte, so consume just that.
    if (this.offset < this.bytes.length && isSpace(this.bytes[this.offset])) this.offset++;
    return value;
  }

  private skipSeparators(): void {
    for (;;) {
      while (this.offset < this.bytes.length && isSpace(this.bytes[this.offset])) this.offset++;
      if (this.bytes[this.offset] !== 0x23) return; // '#'
      while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0x0a) this.offset++;
    }
  }
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}
