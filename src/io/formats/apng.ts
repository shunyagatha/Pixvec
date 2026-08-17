import { bytesEqual, latin1, u16be, u32be } from './bytes.js';

/**
 * Animated PNG (APNG), split into per-frame PNGs.
 *
 * libvips builds against libspng, which decodes an APNG as its still fallback
 * image and reports no page count at all — `sharp(bytes, { animated: true })`
 * returns `pages: undefined`, not `pages: 20`. So every APNG that reached this
 * toolkit came back as a single frame, and an `animate` run on a 20-frame file
 * reported `frames: 1` with nothing to indicate the other 19 had been dropped.
 *
 * **This module does not decode pixels.** An APNG frame is ordinary PNG image
 * data that has been split across `fdAT` chunks and stripped of its header, so
 * the honest fix is to put the header back and hand a real codec a real PNG —
 * the same approach {@link decodeIco} already takes for icon entries that hold
 * an embedded PNG. Reimplementing inflate and PNG unfiltering to avoid one
 * round-trip would be a large amount of subtle code to do worse.
 *
 * Compositing is likewise left to the caller, because it needs decoded pixels:
 * see `compositeApng` in `../apng-compose.js`.
 *
 * Structure, per the APNG specification:
 *
 * - `acTL` declares the frame count, and must precede the first `IDAT`.
 * - `fcTL` precedes each frame, carrying its sub-rectangle, delay and the
 *   dispose/blend operators.
 * - `fdAT` carries frame data — identical to `IDAT` payload after a 4-byte
 *   sequence number is removed.
 * - The `IDAT` image is part of the animation **only** when an `fcTL` appears
 *   before it. Otherwise it is a still fallback for decoders that ignore APNG,
 *   and the animation proper begins at the first `fdAT`. Both layouts are real
 *   and the difference is a whole frame, so it is honoured rather than assumed.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Frame is drawn as-is / over the canvas. */
export type BlendOp = 0 | 1;
/** After display: leave / clear to transparent black / restore the previous canvas. */
export type DisposeOp = 0 | 1 | 2;

export interface ApngFrame {
  /** A complete, standalone PNG holding only this frame's sub-rectangle. */
  png: Uint8Array;
  /** Placement of that sub-rectangle within the canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display time in milliseconds, with the specification's defaults applied. */
  delayMs: number;
  disposeOp: DisposeOp;
  blendOp: BlendOp;
}

export interface ApngInfo {
  /** Canvas size, from `IHDR` — frames may be smaller and offset. */
  width: number;
  height: number;
  /** 0 means loop forever. */
  numPlays: number;
  /**
   * What `acTL` claims. Kept separate from `frames.length` so a truncated file
   * can be reported as truncated instead of silently yielding fewer frames —
   * which is the exact failure this module exists to remove.
   */
  declaredFrames: number;
  frames: ApngFrame[];
}

interface Chunk {
  type: string;
  /** Chunk payload, excluding length, type and CRC. */
  data: Uint8Array;
}

/** True when the bytes are a PNG carrying an `acTL` chunk before the first `IDAT`. */
export function isApng(bytes: Uint8Array): boolean {
  if (!isPng(bytes)) return false;
  for (const chunk of chunks(bytes)) {
    if (chunk.type === 'acTL') return true;
    // acTL after IDAT is invalid; anything claiming it there is not an APNG.
    if (chunk.type === 'IDAT') return false;
  }
  return false;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
}

/** Walk the chunk list, stopping at `IEND` or the first malformed length. */
function* chunks(bytes: Uint8Array): Generator<Chunk> {
  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = u32be(bytes, p);
    // `latin1`'s end is exclusive, so this is the 4 bytes p+4..p+7.
    const type = latin1(bytes, p + 4, p + 8);
    // 12 = length(4) + type(4) + crc(4). A length that overruns the buffer means
    // the file is truncated or not what it claims; stop rather than read past.
    if (p + 12 + length > bytes.length) return;
    yield { type, data: bytes.subarray(p + 8, p + 8 + length) };
    if (type === 'IEND') return;
    p += 12 + length;
  }
}

/**
 * Split an APNG into standalone per-frame PNGs.
 *
 * Throws when the bytes are not an APNG. A file whose `fdAT` stream ends early
 * yields the frames that are actually present, with `declaredFrames` left at
 * what `acTL` said, so the caller can tell the difference.
 */
export function readApngFrames(bytes: Uint8Array): ApngInfo {
  if (!isPng(bytes)) throw new Error('Not a PNG');

  let ihdr: Uint8Array | null = null;
  let acTL: Uint8Array | null = null;
  /** Chunks between IHDR and the first frame that a frame PNG must carry over. */
  const shared: Chunk[] = [];
  /** Payloads accumulated for the frame currently being read. */
  let pending: Uint8Array[] = [];
  let pendingCtl: FrameControl | null = null;
  let sawIdat = false;
  /** Set when an fcTL precedes IDAT, i.e. the still image is also frame 0. */
  let idatIsFrame = false;

  const frames: ApngFrame[] = [];

  const flush = (): void => {
    if (!pendingCtl || pending.length === 0 || !ihdr) return;
    frames.push({
      png: buildFramePng(ihdr, shared, pending, pendingCtl.width, pendingCtl.height),
      x: pendingCtl.x,
      y: pendingCtl.y,
      width: pendingCtl.width,
      height: pendingCtl.height,
      delayMs: pendingCtl.delayMs,
      disposeOp: pendingCtl.disposeOp,
      blendOp: pendingCtl.blendOp,
    });
    pending = [];
    pendingCtl = null;
  };

  for (const chunk of chunks(bytes)) {
    switch (chunk.type) {
      case 'IHDR':
        ihdr = chunk.data;
        break;

      case 'acTL':
        acTL = chunk.data;
        break;

      case 'fcTL': {
        // A new fcTL closes whatever frame was being accumulated.
        flush();
        pendingCtl = readFrameControl(chunk.data);
        // Belt and braces: in a well-formed file the IDAT run is contiguous, so
        // by the time a later fcTL arrives the IDAT chunks are already past and
        // setting this unconditionally would make no difference — mutating the
        // guard away leaves every test passing. It earns its place only against
        // a malformed file that puts IDAT after an fdAT, where dropping it
        // would splice unrelated data into a frame.
        if (!sawIdat) idatIsFrame = true;
        break;
      }

      case 'IDAT':
        sawIdat = true;
        if (idatIsFrame) pending.push(chunk.data);
        break;

      case 'fdAT':
        // Drop the 4-byte sequence number; the rest is IDAT payload verbatim.
        if (chunk.data.length > 4) pending.push(chunk.data.subarray(4));
        break;

      case 'IEND':
        break;

      default:
        // Colour and transparency information lives in chunks the frames all
        // share (PLTE, tRNS, gAMA, ...). A palettised APNG whose frame PNGs
        // omit PLTE does not decode at all, so these are carried over. Anything
        // after IDAT is metadata that cannot affect frame pixels.
        if (!sawIdat) shared.push(chunk);
        break;
    }
  }
  flush();

  if (!ihdr) throw new Error('PNG has no IHDR');
  if (!acTL) throw new Error('Not an APNG: no acTL chunk');

  return {
    width: u32be(ihdr, 0),
    height: u32be(ihdr, 4),
    declaredFrames: u32be(acTL, 0),
    numPlays: u32be(acTL, 4),
    frames,
  };
}

interface FrameControl {
  x: number;
  y: number;
  width: number;
  height: number;
  delayMs: number;
  disposeOp: DisposeOp;
  blendOp: BlendOp;
}

function readFrameControl(d: Uint8Array): FrameControl {
  const delayNum = u16be(d, 20);
  const delayDen = u16be(d, 22);
  return {
    width: u32be(d, 4),
    height: u32be(d, 8),
    x: u32be(d, 12),
    y: u32be(d, 16),
    // "If the denominator is 0, it is to be treated as if it were 100" — so a
    // zero here means hundredths of a second, not a division by zero.
    delayMs: (delayNum / (delayDen === 0 ? 100 : delayDen)) * 1000,
    disposeOp: ((d[24] ?? 0) <= 2 ? d[24] ?? 0 : 0) as DisposeOp,
    blendOp: ((d[25] ?? 0) === 1 ? 1 : 0) as BlendOp,
  };
}

/**
 * Reassemble one frame as a standalone PNG.
 *
 * Only IHDR's width and height change: bit depth, colour type, compression,
 * filter and interlace are copied, because the frame data was compressed under
 * exactly those settings and reinterpreting it under any others would decode to
 * garbage rather than fail.
 */
function buildFramePng(
  ihdr: Uint8Array,
  shared: Chunk[],
  payloads: Uint8Array[],
  width: number,
  height: number,
): Uint8Array {
  const header = new Uint8Array(13);
  header.set(ihdr.subarray(0, 13));
  writeU32be(header, 0, width);
  writeU32be(header, 4, height);

  const parts: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', header)];
  for (const c of shared) parts.push(chunk(c.type, c.data));
  for (const p of payloads) parts.push(chunk('IDAT', p));
  parts.push(chunk('IEND', new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32be(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The CRC covers the type and the data, but not the length.
  writeU32be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function writeU32be(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

let crcTable: Uint32Array | null = null;

/** PNG's CRC-32 (IEEE 802.3, reflected). Built on first use. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
