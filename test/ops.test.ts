import { describe, expect, it } from 'vitest';
import { editImage, hasOps } from '../src/ops.js';
import { encode, flatArtwork, pixelArt } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * `graver/ops` is a thin adapter over sharp, so these tests check the adapter's
 * contract — dimensions, channel integrity, the order of operations, and the
 * two bugs found while writing it — rather than re-testing sharp's algorithms.
 */

function isFourChannel(img: RasterImage): boolean {
  return img.data.length === img.width * img.height * 4;
}

describe('editImage', () => {
  it('resizes within a box by default without enlarging', async () => {
    const out = await editImage(flatArtwork(400, 300), { resize: { width: 200 } });
    expect(out.width).toBe(200);
    expect(out.height).toBe(150);
    expect(isFourChannel(out)).toBe(true);
  });

  it('rotates a multiple of 90 by swapping dimensions', async () => {
    const out = await editImage(flatArtwork(40, 30), { rotate: 90 });
    expect([out.width, out.height]).toEqual([30, 40]);
  });

  it('crops to a pixel region before anything else', async () => {
    const out = await editImage(flatArtwork(100, 100), {
      crop: { left: 10, top: 20, width: 30, height: 40 },
    });
    expect([out.width, out.height]).toEqual([30, 40]);
  });

  it('flips and flops', async () => {
    const src = flatArtwork(20, 20);
    const flipped = await editImage(src, { flip: true });
    const flopped = await editImage(src, { flop: true });
    expect([flipped.width, flipped.height]).toEqual([20, 20]);
    expect([flopped.width, flopped.height]).toEqual([20, 20]);
  });

  /**
   * Regression: `.grayscale()` collapses sharp's working colourspace to one
   * band, which broke the raw-RGBA round trip this adapter depends on. It is
   * done through `modulate({ saturation: 0 })` instead, which must still yield a
   * genuine grey and keep four channels.
   */
  it('greyscales to R==G==B while staying four-channel', async () => {
    const out = await editImage(flatArtwork(40, 30), { grayscale: true });
    expect(isFourChannel(out)).toBe(true);
    for (let i = 0; i < out.width * out.height; i++) {
      const o = i * 4;
      if (out.data[o + 3] === 0) continue;
      expect(Math.abs(out.data[o] - out.data[o + 1])).toBeLessThanOrEqual(2);
      expect(Math.abs(out.data[o + 1] - out.data[o + 2])).toBeLessThanOrEqual(2);
    }
  });

  it('negates toward the photographic opposite', async () => {
    const src = flatArtwork(20, 20);
    const out = await editImage(src, { negate: true });
    // The dominant channel value should move away from the original.
    expect(out.data[0]).not.toBe(src.data[0]);
  });

  /**
   * Regression: a single modulate field passed its unset siblings as
   * `undefined`, which sharp rejects. Each must work alone.
   */
  it.each(['brightness', 'saturation', 'hue'] as const)('applies %s on its own', async (field) => {
    const value = field === 'hue' ? 45 : 1.4;
    const out = await editImage(flatArtwork(20, 20), { modulate: { [field]: value } });
    expect(isFourChannel(out)).toBe(true);
  });

  it('combines modulate fields', async () => {
    const out = await editImage(flatArtwork(20, 20), {
      modulate: { brightness: 1.2, saturation: 1.5, hue: 30 },
    });
    expect(isFourChannel(out)).toBe(true);
  });

  it('flattens transparency onto a background colour', async () => {
    const out = await editImage(pixelArt(3), { flatten: { r: 255, g: 0, b: 255, a: 255 } });
    // Every pixel is now opaque.
    for (let i = 0; i < out.width * out.height; i++) expect(out.data[i * 4 + 3]).toBe(255);
  });

  it('applies operations in a fixed, sensible order', async () => {
    // Crop to 30x40, then resize width to 15 → height scales to 20.
    const out = await editImage(flatArtwork(100, 100), {
      crop: { left: 0, top: 0, width: 30, height: 40 },
      resize: { width: 15 },
    });
    expect([out.width, out.height]).toEqual([15, 20]);
  });
});

/**
 * The wider operation surface added for parity with sharp. Each of these funnels
 * through the same raw-RGBA round trip, so the shared risk they are checked for
 * is a step that collapses sharp's band count (as `.grayscale()` and the default
 * `.threshold()` both do) and breaks the four-channel contract.
 */
describe('editImage — extended operations', () => {
  it.each([
    ['median', { median: 3 }],
    ['gamma', { gamma: 2.2 }],
    ['linear', { linear: { a: 1.1, b: -8 } }],
    ['clahe', { clahe: { width: 4, height: 4 } }],
    ['convolve', { convolve: { width: 3, height: 3, kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0] } }],
    ['tint', { tint: { r: 255, g: 220, b: 180, a: 255 } }],
    ['recomb (sepia)', {
      recomb: [
        [0.393, 0.769, 0.189],
        [0.349, 0.686, 0.168],
        [0.272, 0.534, 0.131],
      ] as [[number, number, number], [number, number, number], [number, number, number]],
    }],
    ['threshold', { threshold: 128 }],
    ['dilate', { dilate: 1 }],
    ['erode', { erode: 1 }],
  ])('keeps four channels through %s', async (_name, chain) => {
    const out = await editImage(flatArtwork(24, 18), chain);
    expect(isFourChannel(out)).toBe(true);
    expect([out.width, out.height]).toEqual([24, 18]);
  });

  it('extends the frame outward', async () => {
    const out = await editImage(flatArtwork(24, 18), {
      extend: { top: 2, left: 3, bottom: 4, right: 5 },
    });
    expect([out.width, out.height]).toEqual([24 + 3 + 5, 18 + 2 + 4]);
    expect(isFourChannel(out)).toBe(true);
  });

  it('applies an affine scale', async () => {
    const out = await editImage(flatArtwork(24, 18), { affine: { matrix: [2, 0, 0, 2] } });
    expect([out.width, out.height]).toEqual([48, 36]);
  });

  it('unflattens pure white to transparent', async () => {
    const before = pixelArt(3); // contains fully-white pixels
    const out = await editImage(before, { unflatten: true });
    const transparent = (img: RasterImage): number => {
      let n = 0;
      for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3] === 0) n++;
      return n;
    };
    // The white cells are now transparent on top of the already-transparent border.
    expect(transparent(out)).toBeGreaterThan(transparent(before));
  });

  it('composites an overlay onto the base', async () => {
    const encoded = new Uint8Array(await encode(flatArtwork(6, 6), 'png'));
    const out = await editImage(flatArtwork(24, 18), {
      composite: [{ input: encoded, gravity: 'northwest' }],
    });
    expect([out.width, out.height]).toEqual([24, 18]);
    expect(isFourChannel(out)).toBe(true);
  });
});

describe('hasOps', () => {
  it('is false for an empty chain', () => {
    expect(hasOps({})).toBe(false);
  });

  it('is true when any operation is present', () => {
    expect(hasOps({ rotate: 90 })).toBe(true);
    expect(hasOps({ grayscale: true })).toBe(true);
    expect(hasOps({ resize: { width: 10 } })).toBe(true);
    expect(hasOps({ modulate: { brightness: 1.1 } })).toBe(true);
  });

  it('detects every extended operation', () => {
    expect(hasOps({ median: 3 })).toBe(true);
    expect(hasOps({ gamma: 2 })).toBe(true);
    expect(hasOps({ linear: { a: 1.1 } })).toBe(true);
    expect(hasOps({ clahe: { width: 4, height: 4 } })).toBe(true);
    expect(hasOps({ convolve: { width: 3, height: 3, kernel: [1] } })).toBe(true);
    expect(hasOps({ tint: { r: 1, g: 2, b: 3, a: 255 } })).toBe(true);
    expect(hasOps({ dilate: 1 })).toBe(true);
    expect(hasOps({ erode: 1 })).toBe(true);
    expect(hasOps({ affine: { matrix: [1, 0, 0, 1] } })).toBe(true);
    expect(hasOps({ extend: { top: 1 } })).toBe(true);
    expect(hasOps({ unflatten: true })).toBe(true);
    expect(hasOps({ recomb: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] })).toBe(true);
    expect(hasOps({ composite: [{ input: 'x.png' }] })).toBe(true);
  });

  it('treats a zero threshold as a real operation, not an absent one', () => {
    // 0 is falsy but a legitimate cutoff, so presence — not truthiness — decides.
    expect(hasOps({ threshold: 0 })).toBe(true);
    expect(hasOps({ threshold: 128 })).toBe(true);
  });

  it('ignores an empty composite list', () => {
    expect(hasOps({ composite: [] })).toBe(false);
  });
});
