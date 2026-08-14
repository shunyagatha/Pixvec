/**
 * Lazy-load placeholders — the tiny previews shown while the real image loads.
 *
 * Two flavours, from the same decode pass the rest of vecline already does:
 *
 * - **BlurHash** — a ~20–30 char string that decodes to a blurred preview.
 *   The de-facto standard (Unsplash, Wolt); implemented here to spec so any
 *   BlurHash decoder renders it.
 * - **LQIP-SVG** — a tiny self-contained SVG (an SQIP successor) that renders a
 *   blurred vector preview and scales cleanly. SQIP is unmaintained and ships a
 *   Go binary; this reuses vecline's own subsample + blur + trace, so it needs
 *   nothing external and stays in the portable core.
 */

import { srgbToLinear, linearToSrgb } from '../color.js';
import { subsample } from '../image.js';
import { selectiveBlur } from '../preprocess.js';
import { trace } from '../vectorize/trace.js';
import type { RasterImage } from '../types.js';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    out += DIGITS[digit];
  }
  return out;
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

function encodeDC(c: [number, number, number]): number {
  return linearToSrgb(c[0]) * 65536 + linearToSrgb(c[1]) * 256 + linearToSrgb(c[2]);
}

function encodeAC(c: [number, number, number], max: number): number {
  const q = (v: number): number =>
    Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / max, 0.5) * 9 + 9.5))));
  return q(c[0]) * 19 * 19 + q(c[1]) * 19 + q(c[2]);
}

/**
 * Encode an image as a BlurHash string, to spec. `componentsX`/`componentsY`
 * (1–9) trade detail for length; 4×3 is the common default.
 */
export function blurHash(image: RasterImage, componentsX = 4, componentsY = 3): string {
  const cx = Math.max(1, Math.min(9, componentsX));
  const cy = Math.max(1, Math.min(9, componentsY));
  const { width, height, data } = image;
  if (width < 1 || height < 1 || data.length < width * height * 4) {
    throw new Error('blurHash: image must have positive dimensions and a matching data buffer');
  }

  const factors: Array<[number, number, number]> = [];
  const scale = 1 / (width * height);
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < cx; x++) {
      const norm = x === 0 && y === 0 ? 1 : 2;
      let r = 0, g = 0, b = 0;
      // Accumulate in the reference BlurHash order (x outer, y inner). The
      // output is a valid, spec-compliant hash any decoder renders correctly;
      // it can differ from a given reference encoder in the last quantised bit
      // at high component counts, purely from float summation order.
      for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++) {
          const basis = norm * Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const p = (j * width + i) * 4;
          r += basis * srgbToLinear(data[p]);
          g += basis * srgbToLinear(data[p + 1]);
          b += basis * srgbToLinear(data[p + 2]);
        }
      }
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0];
  const ac = factors.slice(1);
  let hash = encode83((cx - 1) + (cy - 1) * 9, 1);

  let maxValue = 1;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.map((f) => Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]))));
    const quantMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
    maxValue = (quantMax + 1) / 166;
    hash += encode83(quantMax, 1);
  } else {
    hash += encode83(0, 1);
  }

  hash += encode83(encodeDC(dc), 4);
  for (const f of ac) hash += encode83(encodeAC(f, maxValue), 2);
  return hash;
}

export interface LqipOptions {
  /** Pixel budget for the internal downscale. Default 1600 (~40×40). */
  maxPixels?: number;
  /** Colours in the placeholder. Default 4 — tiny and abstract. */
  colors?: number;
}

/**
 * A tiny self-contained SVG placeholder: downscale hard, blur, then trace to a
 * handful of soft shapes. Renders blurry-but-recognisable and scales to any box.
 */
export function lqipSvg(image: RasterImage, opts: LqipOptions = {}): string {
  const small = subsample(image, opts.maxPixels ?? 1600);
  const blurred = small.width >= 4 && small.height >= 4
    ? selectiveBlur(small, { radius: 2, delta: 255 })
    : small;
  return trace(blurred, {
    colors: opts.colors ?? 4,
    tolerance: 2,
    fitError: 2,
    minArea: 0,
    refineIterations: 0,
  }).svg;
}
