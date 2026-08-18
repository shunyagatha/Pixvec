import { describe, expect, it, vi } from 'vitest';

/**
 * The four formats this package decodes itself must keep working when the
 * optional native packages are not installed.
 *
 * That is a documented promise — the README says BMP, ICO, PNM and TGA "work in
 * core too, no libvips required" — and it was half false: TGA could not be read
 * at all without `sharp`. The fallback is deliberately ordered *after* a real
 * codec, because TGA has no signature to sniff and guessing early risks
 * misreading another format's header. But `loadSharp()` throws before the
 * `metadata()` catch that reaches the fallback, so with no codec installed the
 * turn never came.
 *
 * Mocking `loadSharp` to reject is what makes this a real test: sharp *is*
 * installed in CI, so nothing here would exercise the path otherwise.
 */
vi.mock('../src/io/native.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/io/native.js')>()),
  loadSharp: vi.fn(async () => {
    throw new Error("Cannot find package 'sharp'");
  }),
}));

const { decodeRaster } = await import('../src/io/decode.js');

const W = 8;
const H = 8;

/** A left/right split, so a decode that transposes or mirrors is not silently equal. */
function pixels(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const left = x < W / 2;
      out[o] = left ? 200 : 20;
      out[o + 1] = left ? 30 : 160;
      out[o + 2] = left ? 90 : 40;
    }
  }
  return out;
}

function bmp(): Uint8Array {
  const src = pixels();
  const rowRaw = W * 3;
  const pad = (4 - (rowRaw % 4)) % 4;
  const row = rowRaw + pad;
  const body = new Uint8Array(row * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + x) * 3; // BMP rows run bottom-up, BGR
      const d = y * row + x * 3;
      body[d] = src[s + 2]; body[d + 1] = src[s + 1]; body[d + 2] = src[s];
    }
  }
  const out = new Uint8Array(54 + body.length);
  const v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  v.setUint32(2, out.length, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, W, true); v.setInt32(22, H, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true);
  v.setUint32(34, body.length, true);
  out.set(body, 54);
  return out;
}

function ppm(): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${W} ${H}\n255\n`);
  const src = pixels();
  const out = new Uint8Array(header.length + src.length);
  out.set(header); out.set(src, header.length);
  return out;
}

function tga(): Uint8Array {
  const src = pixels();
  const out = new Uint8Array(18 + W * H * 3);
  const v = new DataView(out.buffer);
  out[2] = 2;                       // uncompressed truecolour
  v.setUint16(12, W, true); v.setUint16(14, H, true);
  out[16] = 24;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + x) * 3;
      const d = 18 + (y * W + x) * 3;
      out[d] = src[s + 2]; out[d + 1] = src[s + 1]; out[d + 2] = src[s];
    }
  }
  return out;
}

/**
 * A raw-DIB entry, not an embedded PNG. The PNG case genuinely needs a PNG
 * decoder — there is nothing to be done about that — so this covers the half of
 * ICO that is actually this package's to honour.
 */
function ico(): Uint8Array {
  const src = pixels();
  const dib = new Uint8Array(40);
  const dv = new DataView(dib.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, W, true); dv.setInt32(8, H * 2, true); // doubled: XOR + AND masks
  dv.setUint16(12, 1, true); dv.setUint16(14, 32, true);
  const xor = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + x) * 3;
      const d = (y * W + x) * 4;
      xor[d] = src[s + 2]; xor[d + 1] = src[s + 1]; xor[d + 2] = src[s]; xor[d + 3] = 255;
    }
  }
  const andMask = new Uint8Array((W / 8) * H);
  const body = new Uint8Array(dib.length + xor.length + andMask.length);
  body.set(dib); body.set(xor, dib.length); body.set(andMask, dib.length + xor.length);

  const out = new Uint8Array(22 + body.length);
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, 1, true);
  out[6] = W; out[7] = H;
  v.setUint16(10, 1, true); v.setUint16(12, 32, true);
  v.setUint32(14, body.length, true); v.setUint32(18, 22, true);
  out.set(body, 22);
  return out;
}

describe('the built-in codecs, with no native packages installed', () => {
  const cases: ReadonlyArray<readonly [string, () => Uint8Array]> = [
    ['BMP', bmp],
    ['PNM', ppm],
    ['TGA', tga],
    ['ICO (raw DIB)', ico],
  ];

  for (const [name, build] of cases) {
    it(`reads ${name} without reaching for sharp`, async () => {
      const { image } = await decodeRaster(build(), {});
      expect(image.width).toBe(W);
      expect(image.height).toBe(H);

      // Check the pixels, not just that something came back. A decoder that
      // returned a blank canvas of the right size would pass a size-only
      // assertion, and this package has shipped exactly that before: a TGA that
      // wrote an empty SVG labelled "bit-exact by construction".
      const at = (x: number, y: number) => {
        const o = (y * W + x) * 4;
        return [image.data[o], image.data[o + 1], image.data[o + 2]];
      };
      expect(at(1, 1)).toEqual([200, 30, 90]);
      expect(at(W - 2, 1)).toEqual([20, 160, 40]);
      expect(at(1, H - 2)).toEqual([200, 30, 90]);
    });
  }

  it('still reports the missing package for a format it cannot decode itself', async () => {
    // The fallbacks must not swallow the real diagnostic for a PNG or JPEG.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(decodeRaster(png, {})).rejects.toThrow(/sharp/);
  });
});
