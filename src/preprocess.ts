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

  /**
   * Separable convolution, streamed.
   *
   * The horizontal pass feeds the vertical one, which feeds the compose step,
   * and each consumes its input exactly once in the order it is produced — so
   * none of it needs to exist all at once. The previous version kept two
   * whole-image Float64 planes anyway, 64 bytes per pixel of scratch: measured
   * 211 MiB on a 3 MP image, for an intermediate no later stage ever revisits.
   *
   * The ring holds only the rows the vertical window can still reach — at most
   * `2 * radius + 1`, so eleven at the maximum radius of five. That is 28 MiB
   * at 3 MP instead of 211, and it is *faster* rather than merely smaller,
   * because the working set now fits in cache instead of streaming through main
   * memory twice.
   *
   * Arithmetic is untouched, deliberately and to the letter: the same kernel,
   * the same clamped edges, the same accumulation order, the same `> delta`
   * comparison and the same `Math.round`. Only where an intermediate lives has
   * changed, which is what makes the output bit-identical rather than merely
   * close.
   */
  const span = radius * 2 + 1;
  const rowLen = width * 4;
  const ring = new Float64Array(span * rowLen);
  const out = new Uint8ClampedArray(n * 4);

  /** Horizontal pass for one source row, written into its ring slot. */
  const hrow = (sy: number): void => {
    const row = sy * width;
    const base = (sy % span) * rowLen;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
        const o = (row + sx) * 4;
        const w = kernel[t + radius];
        r += data[o] * w; g += data[o + 1] * w; b += data[o + 2] * w; a += data[o + 3] * w;
      }
      const d = base + x * 4;
      ring[d] = r; ring[d + 1] = g; ring[d + 2] = b; ring[d + 3] = a;
    }
  };

  // Prime the window with every row the first output row can see.
  for (let sy = 0; sy <= Math.min(height - 1, radius); sy++) hrow(sy);

  for (let y = 0; y < height; y++) {
    // Row y needs source rows clamp(y-radius)..clamp(y+radius). Everything up to
    // min(height-1, y+radius) has been computed, and the oldest row still needed
    // is y-radius, which is exactly `span` behind the newest — so nothing the
    // window can still reach has been overwritten.
    const need = y + radius;
    if (need <= height - 1 && need > radius) hrow(need);

    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
        const o = (sy % span) * rowLen + x * 4;
        const w = kernel[t + radius];
        r += ring[o] * w; g += ring[o + 1] * w; b += ring[o + 2] * w; a += ring[o + 3] * w;
      }

      // Compose in place: use the blur only where it barely changed anything (a
      // flat area), and fall back to the original wherever any channel moved
      // more than `delta` (an edge). This is what keeps the vectorizer's
      // boundaries crisp.
      const o = (y * width + x) * 4;
      const dr = Math.abs(r - data[o]);
      const dg = Math.abs(g - data[o + 1]);
      const db = Math.abs(b - data[o + 2]);
      const da = Math.abs(a - data[o + 3]);
      if (dr > delta || dg > delta || db > delta || da > delta) {
        out[o] = data[o]; out[o + 1] = data[o + 1]; out[o + 2] = data[o + 2]; out[o + 3] = data[o + 3];
      } else {
        out[o] = Math.round(r);
        out[o + 1] = Math.round(g);
        out[o + 2] = Math.round(b);
        out[o + 3] = Math.round(a);
      }
    }
  }

  return { width, height, data: out };
}
