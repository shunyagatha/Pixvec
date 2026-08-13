import type { RasterImage, Rgba } from './types.js';

export function createImage(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function sameSize(a: RasterImage, b: RasterImage): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * Premultiply in place into a fresh buffer.
 *
 * Comparing straight RGBA is a trap: a fully transparent pixel can carry any RGB
 * at all and still render identically, so two visually identical images can show
 * a huge "error". Premultiplying makes invisible colour differences vanish,
 * which is what every quality metric here operates on.
 */
export function premultiply(img: RasterImage): Uint8ClampedArray {
  const n = img.width * img.height;
  const src = img.data;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = src[o + 3];
    if (a === 255) {
      out[o] = src[o];
      out[o + 1] = src[o + 1];
      out[o + 2] = src[o + 2];
    } else if (a !== 0) {
      const f = a / 255;
      out[o] = Math.round(src[o] * f);
      out[o + 1] = Math.round(src[o + 1] * f);
      out[o + 2] = Math.round(src[o + 2] * f);
    }
    out[o + 3] = a;
  }
  return out;
}

/** Composite `img` over an opaque background, producing opaque RGB triples. */
export function compositeOver(img: RasterImage, bg: Rgba): Uint8ClampedArray {
  const n = img.width * img.height;
  const src = img.data;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 4, q = i * 3;
    const a = src[o + 3] / 255;
    const inv = 1 - a;
    out[q] = Math.round(src[o] * a + bg.r * inv);
    out[q + 1] = Math.round(src[o + 1] * a + bg.g * inv);
    out[q + 2] = Math.round(src[o + 2] * a + bg.b * inv);
  }
  return out;
}

/** True when no pixel has alpha < 255. */
export function isOpaque(img: RasterImage): boolean {
  const d = img.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 255) return false;
  return true;
}

/** Pack an RGBA pixel into one unsigned 32-bit key (R in the high byte). */
export function packRgba(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function unpackRgba(key: number): Rgba {
  return {
    r: (key >>> 24) & 0xff,
    g: (key >>> 16) & 0xff,
    b: (key >>> 8) & 0xff,
    a: key & 0xff,
  };
}

/**
 * Histogram of distinct RGBA values.
 *
 * `stopAfter` lets callers bail out early: for a photograph the answer is
 * "basically all of them", and knowing that is enough to pick a strategy.
 */
export function colorHistogram(
  img: RasterImage,
  stopAfter = Infinity,
): { counts: Map<number, number>; truncated: boolean } {
  const counts = new Map<number, number>();
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Fully transparent pixels are indistinguishable regardless of RGB.
    const a = d[o + 3];
    const key = a === 0 ? 0 : packRgba(d[o], d[o + 1], d[o + 2], a);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > stopAfter) return { counts, truncated: true };
  }
  return { counts, truncated: false };
}

/** Nearest-neighbour box downscale, used to keep quantisation sampling cheap. */
export function subsample(img: RasterImage, maxPixels: number): RasterImage {
  const total = img.width * img.height;
  if (total <= maxPixels) return img;

  const scale = Math.sqrt(maxPixels / total);
  const w = Math.max(1, Math.floor(img.width * scale));
  const h = Math.max(1, Math.floor(img.height * scale));
  const out = createImage(w, h);

  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      const so = (sy * img.width + sx) * 4;
      const dobj = (y * w + x) * 4;
      out.data[dobj] = img.data[so];
      out.data[dobj + 1] = img.data[so + 1];
      out.data[dobj + 2] = img.data[so + 2];
      out.data[dobj + 3] = img.data[so + 3];
    }
  }
  return out;
}
