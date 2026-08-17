import { describe, expect, it } from 'vitest';
import { composeApng } from '../src/io/apng-compose.js';
import { isApng, readApngFrames } from '../src/io/formats/apng.js';
import { u32be } from '../src/io/formats/bytes.js';
import type { RasterImage } from '../src/types.js';
import { createImage, encode, setPixel } from './fixtures.js';

/**
 * APNG, built here rather than checked in as binary fixtures.
 *
 * Assembling the container in the test is the point: it exercises the real
 * chunk reader against bytes whose expected output is known exactly, and it
 * covers layouts a downloaded sample would not — in particular the two legal
 * placements of the first `fcTL`, which differ by a whole frame.
 */

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Split a real PNG into its chunks so the pieces can be reassembled as APNG. */
function splitPng(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const out: Array<{ type: string; data: Uint8Array }> = [];
  let p = 8;
  while (p + 8 <= png.length) {
    const len = u32be(png, p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    out.push({ type, data: png.subarray(p + 8, p + 8 + len) });
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

interface FrameSpec {
  png: Uint8Array;
  x: number;
  y: number;
  delayMs: number;
  dispose: 0 | 1 | 2;
  blend: 0 | 1;
  /** Write this delay numerator/denominator verbatim instead of milliseconds. */
  delayNum?: number;
  delayDen?: number;
}

function fcTL(seq: number, f: FrameSpec, w: number, h: number): Uint8Array {
  const d = new Uint8Array(26);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, seq);
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  dv.setUint32(12, f.x);
  dv.setUint32(16, f.y);
  // Delay is a rational, num/den seconds. Default den is 1000 so the
  // millisecond value round-trips exactly; `den` overrides it to reach the
  // specification's rule that a zero denominator means 100.
  const den = f.delayDen ?? 1000;
  dv.setUint16(20, f.delayNum ?? f.delayMs);
  dv.setUint16(22, den);
  d[24] = f.dispose;
  d[25] = f.blend;
  return d;
}

/**
 * Assemble an APNG.
 *
 * `firstIsDefault: true` puts the first `fcTL` *after* `IDAT`, which per spec
 * makes the IDAT image a still fallback that is NOT part of the animation.
 */
function buildApng(
  canvas: { width: number; height: number },
  frames: FrameSpec[],
  opts: { firstIsDefault?: boolean; numPlays?: number; declare?: number } = {},
): Uint8Array {
  const firstIsDefault = opts.firstIsDefault ?? false;
  const animated = firstIsDefault ? frames.slice(1) : frames;

  const base = splitPng(frames[0].png);
  const ihdr = base.find((c) => c.type === 'IHDR')!.data;
  const header = new Uint8Array(ihdr);
  new DataView(header.buffer).setUint32(0, canvas.width);
  new DataView(header.buffer).setUint32(4, canvas.height);

  const acTL = new Uint8Array(8);
  new DataView(acTL.buffer).setUint32(0, opts.declare ?? animated.length);
  new DataView(acTL.buffer).setUint32(4, opts.numPlays ?? 0);

  const parts: Uint8Array[] = [new Uint8Array(SIG), chunk('IHDR', header), chunk('acTL', acTL)];
  let seq = 0;

  frames.forEach((f, i) => {
    const idats = splitPng(f.png).filter((c) => c.type === 'IDAT');
    const isIdatFrame = i === 0;

    if (isIdatFrame) {
      // Frame 0 rides in IDAT. Its fcTL goes before IDAT when it is animated,
      // and is omitted entirely when IDAT is only the still default image.
      if (!firstIsDefault) {
        const dims = splitPng(f.png).find((c) => c.type === 'IHDR')!.data;
        parts.push(chunk('fcTL', fcTL(seq++, f, u32be(dims, 0), u32be(dims, 4))));
      }
      for (const d of idats) parts.push(chunk('IDAT', d.data));
      return;
    }

    const dims = splitPng(f.png).find((c) => c.type === 'IHDR')!.data;
    parts.push(chunk('fcTL', fcTL(seq++, f, u32be(dims, 0), u32be(dims, 4))));
    for (const d of idats) {
      const fd = new Uint8Array(4 + d.data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(d.data, 4);
      parts.push(chunk('fdAT', fd));
    }
  });

  parts.push(chunk('IEND', new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function solid(w: number, h: number, r: number, g: number, b: number, a = 255): RasterImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, r, g, b, a);
  return img;
}

const px = (img: RasterImage, x: number, y: number): number[] => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};

// The decoder contract is straight 8-bit RGBA. ensureAlpha() alone does not get
// there for greyscale or 16-bit sources, so the colourspace and depth are forced.
async function decoder(png: Uint8Array): Promise<RasterImage> {
  const sharpMod = await import('sharp');
  const { data, info } = await sharpMod.default(Buffer.from(png))
    .toColorspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

describe('APNG container', () => {
  it('is not confused with an ordinary PNG', async () => {
    const plain = await encode(solid(4, 4, 10, 20, 30), 'png');
    expect(isApng(plain)).toBe(false);
    expect(() => readApngFrames(plain)).toThrow(/no acTL/i);
  });

  it('reads every frame libvips reports none of', async () => {
    const red = await encode(solid(8, 8, 255, 0, 0), 'png');
    const green = await encode(solid(8, 8, 0, 255, 0), 'png');
    const blue = await encode(solid(8, 8, 0, 0, 255), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: red, x: 0, y: 0, delayMs: 40, dispose: 0, blend: 0 },
      { png: green, x: 0, y: 0, delayMs: 40, dispose: 0, blend: 0 },
      { png: blue, x: 0, y: 0, delayMs: 40, dispose: 0, blend: 0 },
    ]);

    expect(isApng(bytes)).toBe(true);
    const info = readApngFrames(bytes);
    expect(info.declaredFrames).toBe(3);
    expect(info.frames).toHaveLength(3);
    expect(info.width).toBe(8);
    expect(info.height).toBe(8);

    const out = await composeApng(bytes, decoder);
    expect(out.frames).toHaveLength(3);
    expect(px(out.frames[0].image, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out.frames[1].image, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(px(out.frames[2].image, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(out.frames.map((f) => Math.round(f.delayMs))).toEqual([40, 40, 40]);
  });

  /**
   * The IDAT image counts as a frame only when an fcTL precedes it. Getting
   * this wrong is an off-by-one in the frame count, in whichever direction —
   * and it is the difference PIL papers over by exposing the default image as
   * an extra frame 0 regardless.
   */
  it('excludes the IDAT image when it is only a still fallback', async () => {
    const still = await encode(solid(8, 8, 9, 9, 9), 'png');
    const red = await encode(solid(8, 8, 255, 0, 0), 'png');
    const green = await encode(solid(8, 8, 0, 255, 0), 'png');
    const specs: FrameSpec[] = [
      { png: still, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: red, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: green, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
    ];

    const animated = buildApng({ width: 8, height: 8 }, specs);
    expect(readApngFrames(animated).frames).toHaveLength(3);

    const withDefault = buildApng({ width: 8, height: 8 }, specs, { firstIsDefault: true });
    const info = readApngFrames(withDefault);
    expect(info.frames).toHaveLength(2);
    const out = await composeApng(withDefault, decoder);
    // The grey still image must never appear: the animation starts at red.
    expect(px(out.frames[0].image, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out.frames[1].image, 0, 0)).toEqual([0, 255, 0, 255]);
  });

  it('composites a sub-rectangle at its offset instead of at the origin', async () => {
    const base = await encode(solid(8, 8, 0, 0, 0), 'png');
    const patch = await encode(solid(2, 2, 255, 255, 0), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: base, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: patch, x: 5, y: 3, delayMs: 10, dispose: 0, blend: 0 },
    ]);

    const out = await composeApng(bytes, decoder);
    expect(px(out.frames[1].image, 5, 3)).toEqual([255, 255, 0, 255]);
    expect(px(out.frames[1].image, 6, 4)).toEqual([255, 255, 0, 255]);
    // Outside the patch the previous frame survives (dispose = NONE).
    expect(px(out.frames[1].image, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out.frames[1].image, 7, 5)).toEqual([0, 0, 0, 255]);
  });

  it('clears only the frame rectangle for dispose = BACKGROUND', async () => {
    const base = await encode(solid(8, 8, 0, 0, 255), 'png');
    const patch = await encode(solid(2, 2, 255, 0, 0), 'png');
    const tail = await encode(solid(1, 1, 0, 255, 0), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: base, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: patch, x: 2, y: 2, delayMs: 10, dispose: 1, blend: 0 },
      { png: tail, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
    ]);

    const out = await composeApng(bytes, decoder);
    // Frame 1 shows the patch -- the disposal happens AFTER it is displayed.
    expect(px(out.frames[1].image, 2, 2)).toEqual([255, 0, 0, 255]);
    // Frame 2 sees the patch rectangle cleared to transparent black, and
    // everything outside it untouched.
    expect(px(out.frames[2].image, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(px(out.frames[2].image, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(px(out.frames[2].image, 5, 5)).toEqual([0, 0, 255, 255]);
  });

  it('restores the canvas for dispose = PREVIOUS', async () => {
    const base = await encode(solid(8, 8, 0, 0, 255), 'png');
    const patch = await encode(solid(4, 4, 255, 0, 0), 'png');
    const tail = await encode(solid(1, 1, 0, 255, 0), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: base, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: patch, x: 0, y: 0, delayMs: 10, dispose: 2, blend: 0 },
      { png: tail, x: 7, y: 7, delayMs: 10, dispose: 0, blend: 0 },
    ]);

    const out = await composeApng(bytes, decoder);
    expect(px(out.frames[1].image, 1, 1)).toEqual([255, 0, 0, 255]);
    // The snapshot taken before frame 1 is restored, so the blue is back.
    expect(px(out.frames[2].image, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(px(out.frames[2].image, 7, 7)).toEqual([0, 255, 0, 255]);
  });

  /**
   * Compositing anything over an opaque destination yields an opaque result —
   * `a = as + ad(1-as)` is 1 whenever `ad` is 1. Pillow disagrees here, giving
   * 191 for this case (which is `as + as(1-as)`, i.e. blending against the
   * source's own alpha), so this is asserted from the algebra rather than from
   * a reference decoder.
   */
  it('blends OVER an opaque canvas to a fully opaque result', async () => {
    const black = await encode(solid(4, 4, 0, 0, 0, 255), 'png');
    const halfBlue = await encode(solid(4, 4, 0, 0, 255, 128), 'png');
    const bytes = buildApng({ width: 4, height: 4 }, [
      { png: black, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: halfBlue, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 1 },
    ]);

    const out = await composeApng(bytes, decoder);
    const [r, g, b, a] = px(out.frames[1].image, 0, 0);
    expect(a).toBe(255);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(129);
  });

  it('SOURCE punches transparency through instead of blending', async () => {
    const black = await encode(solid(4, 4, 0, 0, 0, 255), 'png');
    const clear = await encode(solid(2, 2, 0, 0, 0, 0), 'png');
    const bytes = buildApng({ width: 4, height: 4 }, [
      { png: black, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: clear, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
    ]);

    const out = await composeApng(bytes, decoder);
    expect(px(out.frames[1].image, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out.frames[1].image, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('refuses a declared frame budget it would have to allocate', async () => {
    const red = await encode(solid(8, 8, 255, 0, 0), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: red, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
    ], { declare: 100_000 });

    await expect(composeApng(bytes, decoder, 1000)).rejects.toThrow(/pixel limit/i);
    // Without a limit the same file decodes its one real frame.
    await expect(composeApng(bytes, decoder)).resolves.toBeTruthy();
  });

  /**
   * "If the denominator is 0, it is to be treated as if it were 100." Reading
   * it literally divides by zero and yields Infinity, which propagates into the
   * animation's total duration and makes every frame timing meaningless — and
   * a zero denominator is what several encoders emit for hundredths.
   */
  it('treats a zero delay denominator as hundredths, not as a division by zero', async () => {
    const red = await encode(solid(4, 4, 255, 0, 0), 'png');
    const green = await encode(solid(4, 4, 0, 255, 0), 'png');
    const bytes = buildApng({ width: 4, height: 4 }, [
      { png: red, x: 0, y: 0, delayMs: 0, delayNum: 25, delayDen: 0, dispose: 0, blend: 0 },
      { png: green, x: 0, y: 0, delayMs: 0, delayNum: 6, delayDen: 0, dispose: 0, blend: 0 },
    ]);

    const info = readApngFrames(bytes);
    expect(info.frames.map((f) => f.delayMs)).toEqual([250, 60]);
    for (const f of info.frames) expect(Number.isFinite(f.delayMs)).toBe(true);
  });

  it('reports the declared count separately from what the file carries', async () => {
    const red = await encode(solid(8, 8, 255, 0, 0), 'png');
    const green = await encode(solid(8, 8, 0, 255, 0), 'png');
    const bytes = buildApng({ width: 8, height: 8 }, [
      { png: red, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
      { png: green, x: 0, y: 0, delayMs: 10, dispose: 0, blend: 0 },
    ], { declare: 7 });

    const info = readApngFrames(bytes);
    expect(info.declaredFrames).toBe(7);
    expect(info.frames).toHaveLength(2);
  });
});
