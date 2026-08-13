import type { RasterImage, Rgba } from '../../types.js';

/**
 * Encoders for the formats libvips cannot write.
 *
 * These are the mirror image of the decoders next door, and they exist so the
 * conversion matrix is *square*: every format the library reads, it can also
 * write. Reading ten formats but writing six leaves 44 of 121 conversions
 * impossible for no reason the user can see.
 *
 * All four are pure TypeScript over `Uint8Array`, so they work in the same
 * places the decoders do — browser, Deno, Bun, edge — with no codec available.
 * Each is lossless, so `decode(encode(x))` returns `x` exactly, which is what
 * the round-trip tests assert.
 */

const OPAQUE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** True when no pixel is even slightly transparent. */
function isOpaque(img: RasterImage): boolean {
  const d = img.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 255) return false;
  return true;
}

/** Composite onto an opaque background, for formats with no alpha channel. */
function flattenPixel(
  d: Uint8ClampedArray, o: number, bg: Rgba,
): [number, number, number] {
  const a = d[o + 3] / 255;
  if (a === 1) return [d[o], d[o + 1], d[o + 2]];
  const inv = 1 - a;
  return [
    Math.round(d[o] * a + bg.r * inv),
    Math.round(d[o + 1] * a + bg.g * inv),
    Math.round(d[o + 2] * a + bg.b * inv),
  ];
}

// ---------------------------------------------------------------------------
// BMP
// ---------------------------------------------------------------------------

export interface BmpEncodeOptions {
  /** Force a bit depth instead of choosing by whether alpha is present. */
  bitDepth?: 24 | 32;
  /** Background for flattening when writing 24-bit from an image with alpha. */
  background?: Rgba;
}

/**
 * Write a BMP.
 *
 * Opaque images get 24-bit `BI_RGB` with the classic 40-byte header, which is
 * the most widely readable BMP there is. Images with alpha get 32-bit
 * `BI_BITFIELDS` with a `BITMAPV4HEADER`, because that is the only way to
 * *declare* an alpha channel rather than hope the reader guesses — a 32-bit
 * `BI_RGB` file leaves alpha officially undefined, and readers disagree.
 */
export function encodeBmp(img: RasterImage, opts: BmpEncodeOptions = {}): Uint8Array {
  const { width, height, data } = img;
  const withAlpha = opts.bitDepth ? opts.bitDepth === 32 : !isOpaque(img);
  const bg = opts.background ?? OPAQUE_WHITE;

  const bitsPerPixel = withAlpha ? 32 : 24;
  const headerSize = withAlpha ? 108 : 40; // BITMAPV4HEADER vs BITMAPINFOHEADER
  const rowSize = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const pixelBytes = rowSize * height;
  const offset = 14 + headerSize;

  const out = new Uint8Array(offset + pixelBytes);
  const view = new DataView(out.buffer);

  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, out.length, true);
  view.setUint32(10, offset, true);

  view.setUint32(14, headerSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive: rows stored bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, bitsPerPixel, true);
  view.setUint32(30, withAlpha ? 3 : 0, true); // BI_BITFIELDS : BI_RGB
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); // ~72 DPI, in pixels per metre
  view.setInt32(42, 2835, true);

  if (withAlpha) {
    view.setUint32(54, 0x00ff0000, true); // red mask
    view.setUint32(58, 0x0000ff00, true); // green
    view.setUint32(62, 0x000000ff, true); // blue
    view.setUint32(66, 0xff000000, true); // alpha
    view.setUint32(70, 0x73524742, true); // 'sRGB' colour space
  }

  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y; // bottom-up
    for (let x = 0; x < width; x++) {
      const s = (sourceRow * width + x) * 4;
      const o = offset + y * rowSize + x * (bitsPerPixel / 8);
      if (withAlpha) {
        out[o] = data[s + 2];
        out[o + 1] = data[s + 1];
        out[o + 2] = data[s];
        out[o + 3] = data[s + 3];
      } else {
        const [r, g, b] = flattenPixel(data, s, bg);
        out[o] = b;
        out[o + 1] = g;
        out[o + 2] = r;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Netpbm
// ---------------------------------------------------------------------------

export interface PnmEncodeOptions {
  /** `P6` colour (default), `P5` greyscale, or `P4` bilevel. */
  variant?: 'P6' | 'P5' | 'P4';
  background?: Rgba;
  /** Threshold used by `P4`, on the 0–255 luma scale. */
  threshold?: number;
}

/** Write a binary Netpbm file. None of the variants carry alpha, so it is flattened. */
export function encodePnm(img: RasterImage, opts: PnmEncodeOptions = {}): Uint8Array {
  const { width, height, data } = img;
  const variant = opts.variant ?? 'P6';
  const bg = opts.background ?? OPAQUE_WHITE;
  const pixels = width * height;

  const header = new TextEncoder().encode(
    variant === 'P4'
      ? `P4\n${width} ${height}\n`
      : `${variant}\n${width} ${height}\n255\n`,
  );

  if (variant === 'P4') {
    const threshold = opts.threshold ?? 128;
    const rowBytes = Math.ceil(width / 8);
    const out = new Uint8Array(header.length + rowBytes * height);
    out.set(header);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = flattenPixel(data, (y * width + x) * 4, bg);
        // A set bit means black in PBM, the opposite of every other format here.
        if (0.2126 * r + 0.7152 * g + 0.0722 * b < threshold) {
          out[header.length + y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    return out;
  }

  const channels = variant === 'P6' ? 3 : 1;
  const out = new Uint8Array(header.length + pixels * channels);
  out.set(header);

  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = flattenPixel(data, i * 4, bg);
    const o = header.length + i * channels;
    if (channels === 3) {
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    } else {
      out[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// TGA
// ---------------------------------------------------------------------------

export interface TgaEncodeOptions {
  bitDepth?: 24 | 32;
  background?: Rgba;
  /** Run-length encode. Smaller on flat artwork, larger on noise. */
  rle?: boolean;
}

/**
 * Write a Truevision TGA, top-down so no reader has to flip it.
 *
 * The RLE path deliberately never emits a run shorter than two pixels: a
 * one-pixel "run" costs the same as a raw packet plus a wasted control byte, so
 * on noisy input naive run detection produces a file larger than uncompressed.
 */
export function encodeTga(img: RasterImage, opts: TgaEncodeOptions = {}): Uint8Array {
  const { width, height, data } = img;
  const depth = opts.bitDepth ?? (isOpaque(img) ? 24 : 32);
  const bg = opts.background ?? OPAQUE_WHITE;
  const bytesPerPixel = depth / 8;

  // Assemble BGRA in reading order first; both paths consume it.
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  for (let i = 0; i < width * height; i++) {
    const s = i * 4;
    const o = i * bytesPerPixel;
    if (depth === 32) {
      pixels[o] = data[s + 2];
      pixels[o + 1] = data[s + 1];
      pixels[o + 2] = data[s];
      pixels[o + 3] = data[s + 3];
    } else {
      const [r, g, b] = flattenPixel(data, s, bg);
      pixels[o] = b; pixels[o + 1] = g; pixels[o + 2] = r;
    }
  }

  const body = opts.rle ? runLengthEncode(pixels, width, height, bytesPerPixel) : pixels;

  const out = new Uint8Array(18 + body.length + 26);
  const view = new DataView(out.buffer);
  out[2] = opts.rle ? 10 : 2; // RLE true-colour : uncompressed true-colour
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  out[16] = depth;
  // Bit 5 = top-down origin; low nibble = attribute (alpha) bit count.
  out[17] = 0x20 | (depth === 32 ? 8 : 0);
  out.set(body, 18);

  // Footer, so readers can identify the file without guessing at the header.
  const footer = 18 + body.length;
  out.set(new TextEncoder().encode('TRUEVISION-XFILE.'), footer + 8);
  return out;
}

function runLengthEncode(
  pixels: Uint8Array, width: number, height: number, bpp: number,
): Uint8Array {
  const chunks: number[] = [];
  const total = width * height;

  const samePixel = (a: number, b: number): boolean => {
    for (let k = 0; k < bpp; k++) if (pixels[a * bpp + k] !== pixels[b * bpp + k]) return false;
    return true;
  };

  let i = 0;
  while (i < total) {
    // Packets may not cross a scanline boundary.
    const rowEnd = (Math.floor(i / width) + 1) * width;

    let run = 1;
    while (i + run < rowEnd && run < 128 && samePixel(i, i + run)) run++;

    if (run >= 2) {
      chunks.push(0x80 | (run - 1));
      for (let k = 0; k < bpp; k++) chunks.push(pixels[i * bpp + k]);
      i += run;
      continue;
    }

    // Raw packet: gather until a run of two or more appears.
    let raw = 1;
    while (
      i + raw < rowEnd && raw < 128 &&
      !(i + raw + 1 < rowEnd && samePixel(i + raw, i + raw + 1))
    ) raw++;

    chunks.push(raw - 1);
    for (let p = 0; p < raw; p++) {
      for (let k = 0; k < bpp; k++) chunks.push(pixels[(i + p) * bpp + k]);
    }
    i += raw;
  }

  return Uint8Array.from(chunks);
}

// ---------------------------------------------------------------------------
// ICO
// ---------------------------------------------------------------------------

export interface IcoEntryInput {
  width: number;
  height: number;
  /** A complete PNG file, or a headerless DIB produced by {@link encodeIcoDib}. */
  payload: Uint8Array;
  bitCount?: number;
}

/**
 * Assemble an ICO from one or more pre-encoded entries.
 *
 * Icons are containers, so this takes payloads rather than pixels: callers with
 * a PNG encoder to hand should pass PNG (what every icon above 48px uses today),
 * and callers without one can use {@link encodeIcoDib}, which needs nothing.
 */
export function encodeIco(entries: readonly IcoEntryInput[]): Uint8Array {
  if (entries.length === 0) throw new Error('An ICO needs at least one entry');
  if (entries.length > 255) throw new Error('An ICO cannot hold more than 255 entries');

  const directoryBytes = 6 + entries.length * 16;
  const total = directoryBytes + entries.reduce((sum, e) => sum + e.payload.length, 0);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true); // 1 = icon
  view.setUint16(4, entries.length, true);

  let payloadOffset = directoryBytes;
  entries.forEach((entry, i) => {
    const o = 6 + i * 16;
    // A stored dimension of 0 means 256 — the field is only one byte wide.
    out[o] = entry.width >= 256 ? 0 : entry.width;
    out[o + 1] = entry.height >= 256 ? 0 : entry.height;
    out[o + 2] = 0; // palette size, 0 for true colour
    out[o + 3] = 0;
    view.setUint16(o + 4, 1, true);
    view.setUint16(o + 6, entry.bitCount ?? 32, true);
    view.setUint32(o + 8, entry.payload.length, true);
    view.setUint32(o + 12, payloadOffset, true);
    out.set(entry.payload, payloadOffset);
    payloadOffset += entry.payload.length;
  });

  return out;
}

/**
 * Build the headerless DIB an ICO entry expects.
 *
 * Two details are specific to icons and easy to get wrong: the stored height is
 * *doubled* to cover the AND mask that follows the colour plane, and that mask
 * must be present even for a 32-bit entry that carries its own alpha.
 */
export function encodeIcoDib(img: RasterImage): Uint8Array {
  const { width, height, data } = img;
  const rowSize = Math.ceil((width * 32) / 32) * 4;
  const maskRowSize = Math.ceil(width / 32) * 4;
  const out = new Uint8Array(40 + rowSize * height + maskRowSize * height);
  const view = new DataView(out.buffer);

  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true); // colour plane plus mask
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(16, 0, true); // BI_RGB
  view.setUint32(20, rowSize * height, true);

  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (sourceRow * width + x) * 4;
      const o = 40 + y * rowSize + x * 4;
      out[o] = data[s + 2];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s];
      out[o + 3] = data[s + 3];
      // Mark fully transparent pixels in the AND mask as well, so readers that
      // ignore the alpha channel still show them as transparent.
      if (data[s + 3] === 0) {
        const m = 40 + rowSize * height + y * maskRowSize + (x >> 3);
        out[m] |= 0x80 >> (x & 7);
      }
    }
  }

  return out;
}
