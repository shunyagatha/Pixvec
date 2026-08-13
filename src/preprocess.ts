import type { RasterImage } from './types.js';

/**
 * Pre-tracing pixel filters.
 *
 * These run *before* quantisation and segmentation, to change what the tracer
 * sees. The one that matters is a selective blur: a plain blur would smear the
 * edges a vectorizer exists to find, so this blurs only where the image is
 * already smooth and leaves edges untouched. It mirrors imagetracerjs's
 * `blurradius`/`blurdelta`, and its job is to stop sensor noise and JPEG grain
 * from fragmenting a flat region into hundreds of speckle contours.
 *
 * Pure TypeScript over `RasterImage`, so it lives in the portable core.
 */

export interface BlurOptions {
  /**
   * Gaussian radius, 1–5. Larger removes more grain but risks softening detail.
   * Values below 1 are a no-op; the maximum is 5 because that is where the
   * separable kernel stops buying anything for the cost.
   */
  radius: number;
  /**
   * Edge-preservation threshold, 0–255. A pixel keeps its *original* value
   * wherever the blur would have moved any channel by more than this. Low values
   * protect almost every edge (blurring only the flattest areas); high values
   * let the blur reach into textured regions. imagetracerjs's default is 20.
   */
  delta?: number;
}

const DEFAULT_DELTA = 20;

/** 1-D Gaussian weights for a given radius, normalised to sum to 1. */
function gaussianKernel(radius: number): Float64Array {
  // sigma tied to radius the way a 3-sigma rule suggests, so the kernel's tails
  // are negligible exactly at its edge.
  const sigma = radius / 3 || 1;
  const size = radius * 2 + 1;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

/**
 * Edge-preserving Gaussian blur.
 *
 * Returns a new image; the input is untouched. Alpha is blurred alongside colour
 * so a soft mask does not develop a hard seam, but the edge-preservation test
 * looks at all four channels, so a hard alpha edge is protected too.
 */
export function selectiveBlur(img: RasterImage, opts: BlurOptions): RasterImage {
  const radius = Math.min(5, Math.floor(opts.radius));
  const delta = opts.delta ?? DEFAULT_DELTA;
  const { width, height, data } = img;

  if (radius < 1) return { width, height, data: new Uint8ClampedArray(data) };

  const kernel = gaussianKernel(radius);
  const n = width * height;

  // Separable convolution: horizontal pass into a scratch buffer, then vertical.
  const tmp = new Float64Array(n * 4);
  const blurred = new Float64Array(n * 4);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
        const o = (row + sx) * 4;
        const w = kernel[t + radius];
        r += data[o] * w; g += data[o + 1] * w; b += data[o + 2] * w; a += data[o + 3] * w;
      }
      const d = (row + x) * 4;
      tmp[d] = r; tmp[d + 1] = g; tmp[d + 2] = b; tmp[d + 3] = a;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
        const o = (sy * width + x) * 4;
        const w = kernel[t + radius];
        r += tmp[o] * w; g += tmp[o + 1] * w; b += tmp[o + 2] * w; a += tmp[o + 3] * w;
      }
      const d = (y * width + x) * 4;
      blurred[d] = r; blurred[d + 1] = g; blurred[d + 2] = b; blurred[d + 3] = a;
    }
  }

  // Compose: use the blur only where it barely changed anything (a flat area),
  // and fall back to the original wherever any channel moved more than `delta`
  // (an edge). This is what keeps the vectorizer's boundaries crisp.
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(blurred[o] - data[o]);
    const dg = Math.abs(blurred[o + 1] - data[o + 1]);
    const db = Math.abs(blurred[o + 2] - data[o + 2]);
    const da = Math.abs(blurred[o + 3] - data[o + 3]);
    if (dr > delta || dg > delta || db > delta || da > delta) {
      out[o] = data[o]; out[o + 1] = data[o + 1]; out[o + 2] = data[o + 2]; out[o + 3] = data[o + 3];
    } else {
      out[o] = Math.round(blurred[o]);
      out[o + 1] = Math.round(blurred[o + 1]);
      out[o + 2] = Math.round(blurred[o + 2]);
      out[o + 3] = Math.round(blurred[o + 3]);
    }
  }

  return { width, height, data: out };
}
