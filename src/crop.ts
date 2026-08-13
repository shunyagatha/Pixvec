/**
 * Content-aware cropping.
 *
 * Cropping a wide photo to a square avatar or a 16:9 hero by taking the centre
 * throws away the subject as often as it keeps it. This finds the crop window
 * of a requested aspect ratio that retains the most *interesting* content —
 * edges and saturated colour, where the eye goes — the way smartcrop.js does,
 * but in dependency-free TypeScript that runs in the browser as readily as in
 * Node.
 *
 * The importance map is edge energy (a Sobel gradient magnitude on luma) plus a
 * saturation term, summed into an integral image so every candidate window
 * scores in O(1). The winner maximises captured importance while a size penalty
 * keeps it from trivially selecting the whole frame, and a gentle centre bias
 * breaks ties toward the middle. Pure — {@link RasterImage} in, a rectangle out.
 */

import type { RasterImage } from './types.js';

export interface SmartCropOptions {
  /**
   * Target aspect ratio as width/height. Accepts a number (`1.5`), a `[w, h]`
   * tuple (`[3, 2]`), or is inferred from {@link width}/{@link height}. Defaults
   * to 1 (square).
   */
  aspect?: number | [number, number];
  /** Force an exact output width (with {@link height}, sets the aspect). */
  width?: number;
  /** Force an exact output height. */
  height?: number;
  /** Smallest window size as a fraction of the maximal fitting window. Default 0.6. */
  minScale?: number;
  /** How strongly to penalise larger windows (prefer tighter crops). Default 0.12. */
  sizeWeight?: number;
  /** How strongly to pull the crop toward the image centre on ties. Default 0.25. */
  centerWeight?: number;
  /** Weight of the saturation term relative to edges. Default 0.3. */
  saturationWeight?: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The winning window's score, for debugging/telemetry. */
  score: number;
}

/** Find the best content-aware crop of `aspect` (w/h) within an image. */
export function smartCrop(image: RasterImage, opts: SmartCropOptions = {}): CropRect {
  const { width: W, height: H } = image;
  const aspect = resolveAspect(opts);
  const minScale = clamp(opts.minScale ?? 0.6, 0.1, 1);
  const sizeWeight = opts.sizeWeight ?? 0.12;
  const centerWeight = opts.centerWeight ?? 0.25;
  const satWeight = opts.saturationWeight ?? 0.3;

  // The largest window of the target aspect that fits inside the image.
  let maxW = W;
  let maxH = Math.round(maxW / aspect);
  if (maxH > H) { maxH = H; maxW = Math.round(maxH * aspect); }
  maxW = Math.min(maxW, W);
  maxH = Math.min(maxH, H);
  if (maxW < 1 || maxH < 1) {
    return { x: 0, y: 0, width: W, height: H, score: 0 };
  }

  const importance = importanceMap(image, satWeight);
  const integral = integralImage(importance, W, H);
  const grand = integral[H * (W + 1) + W]; // bottom-right corner = grand sum

  // Nothing stands out (a flat field): there is no subject to follow, so keep
  // as much as possible, centred — the intuitive answer, and it stops the size
  // penalty from arbitrarily shrinking the window.
  if (grand <= 1e-6) {
    return {
      x: Math.floor((W - maxW) / 2),
      y: Math.floor((H - maxH) / 2),
      width: maxW,
      height: maxH,
      score: 0,
    };
  }
  const total = grand;

  const cx = W / 2;
  const cy = H / 2;
  const maxCenterDist = Math.hypot(cx, cy) || 1;

  let best: CropRect = { x: 0, y: 0, width: maxW, height: maxH, score: -Infinity };

  // A handful of scales from full size down to minScale.
  const SCALE_STEPS = 6;
  for (let s = 0; s < SCALE_STEPS; s++) {
    const scale = 1 - ((1 - minScale) * s) / (SCALE_STEPS - 1);
    const winW = Math.max(1, Math.round(maxW * scale));
    const winH = Math.max(1, Math.round(maxH * scale));
    if (winW > W || winH > H) continue;

    // Slide with a step proportional to the window, ~16 positions per axis.
    const stepX = Math.max(1, Math.round(winW / 16));
    const stepY = Math.max(1, Math.round(winH / 16));

    for (let y = 0; y + winH <= H; y += stepY) {
      for (let x = 0; x + winW <= W; x += stepX) {
        const inside = rectSum(integral, W, x, y, winW, winH);
        const captured = inside / total; // fraction of all importance kept

        const area = (winW * winH) / (W * H);
        const winCx = x + winW / 2;
        const winCy = y + winH / 2;
        const centerDist = Math.hypot(winCx - cx, winCy - cy) / maxCenterDist;

        const score = captured
          - sizeWeight * area
          - centerWeight * centerDist * 0.1;

        if (score > best.score) {
          best = { x, y, width: winW, height: winH, score };
        }
      }
    }
  }

  // Guarantee the last row/column can be reached: clamp the window flush to the
  // far edge if the stepping stopped short (never overhang the image).
  best.x = Math.min(best.x, W - best.width);
  best.y = Math.min(best.y, H - best.height);
  return best;
}

/** Copy a sub-rectangle out of an image (pure; clamps to bounds). */
export function cropImage(image: RasterImage, rect: { x: number; y: number; width: number; height: number }): RasterImage {
  const { width: W, height: H, data } = image;
  const x = clampInt(rect.x, 0, W - 1);
  const y = clampInt(rect.y, 0, H - 1);
  const w = clampInt(rect.width, 1, W - x);
  const h = clampInt(rect.height, 1, H - y);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * W + x) * 4;
    out.set(data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

// --- internals -------------------------------------------------------------

function resolveAspect(opts: SmartCropOptions): number {
  if (opts.width && opts.height) return opts.width / opts.height;
  if (Array.isArray(opts.aspect)) {
    const [w, h] = opts.aspect;
    return h > 0 ? w / h : 1;
  }
  if (typeof opts.aspect === 'number' && opts.aspect > 0) return opts.aspect;
  return 1;
}

/** Per-pixel importance: Sobel edge magnitude on luma, plus a saturation term. */
function importanceMap(image: RasterImage, satWeight: number): Float64Array {
  const { width: W, height: H, data } = image;
  const luma = new Float64Array(W * H);
  const sat = new Float64Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3] / 255;
    luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) * a;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    sat[i] = max > 0 ? ((max - min) / max) * a : 0;
  }

  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Replicate-edge Sobel so borders still contribute.
      const x0 = x > 0 ? x - 1 : x, x1 = x < W - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y, y1 = y < H - 1 ? y + 1 : y;
      const tl = luma[y0 * W + x0], tc = luma[y0 * W + x], tr = luma[y0 * W + x1];
      const ml = luma[y * W + x0], mr = luma[y * W + x1];
      const bl = luma[y1 * W + x0], bc = luma[y1 * W + x], br = luma[y1 * W + x1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      const edge = Math.hypot(gx, gy) / 4; // normalise the Sobel gain
      out[i] = edge + satWeight * sat[i] * 255;
    }
  }
  return out;
}

/** Summed-area table with a zero top row/left column; size (W+1)·(H+1). */
function integralImage(src: Float64Array, W: number, H: number): Float64Array {
  const iw = W + 1;
  const integral = new Float64Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += src[y * W + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  return integral;
}

/** Sum of the importance inside [x, x+w) × [y, y+h) via the integral image. */
function rectSum(integral: Float64Array, W: number, x: number, y: number, w: number, h: number): number {
  const iw = W + 1;
  const x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  return (
    integral[y1 * iw + x1]
    - integral[y0 * iw + x1]
    - integral[y1 * iw + x0]
    + integral[y0 * iw + x0]
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
