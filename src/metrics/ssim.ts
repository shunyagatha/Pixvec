/**
 * Structural similarity (Wang, Bovik, Sheikh & Simoncelli, 2004).
 *
 * This is the Gaussian-weighted formulation with an 11x11 window and sigma 1.5,
 * matching the reference MATLAB `ssim_index.m`. The convolution is `valid`:
 * border pixels whose window would fall off the image are excluded from the
 * mean rather than padded, which is what scikit-image and the original paper do.
 * Padding instead of cropping quietly inflates the score on small images.
 */

const K1 = 0.01;
const K2 = 0.03;
const DYNAMIC_RANGE = 255;
const C1 = (K1 * DYNAMIC_RANGE) ** 2; // 6.5025
const C2 = (K2 * DYNAMIC_RANGE) ** 2; // 58.5225

function gaussianKernel(radius: number, sigma: number): Float64Array {
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Separable convolution with clamped edges. Edge values are cropped later.
 *
 * Each pass is split into border and interior rather than clamping every tap.
 * Only pixels within `radius` of an edge can ever need the clamp, so on any
 * real image the branch was being evaluated eleven times per pixel to change
 * nothing: at 1600x1598 the interior is 99.3% of the image. Splitting it out
 * measured 15-21% faster across the corpus.
 *
 * The interior loop accumulates the same taps, in the same order, as the
 * clamped one — the clamp is the identity there — so this is bit-identical, not
 * merely close. Verified as an exact match on every pixel of four images before
 * it was adopted, which matters because SSIM is the number this project
 * publishes and re-measures in CI.
 *
 * One caveat for anyone changing the clamped branches: they are not observable
 * through `ssimPlane`. The scored region below is exactly `[radius, w - radius)`
 * x `[radius, h - radius)`, which is precisely the interior, so a border column
 * of `tmp` is only ever read back for an output in that same column — and every
 * such output is cropped. This function is kept a correct general convolution
 * rather than one fused to the caller's crop, but a test cannot reach the clamp,
 * so review it by reading rather than by expecting CI to catch it.
 *
 * Narrowing these planes to `Float32Array`, which is the obvious-looking way to
 * make this cheaper, was measured and is 77% *slower*: JS arithmetic is
 * double-precision, so every element read widens and every write rounds, buying
 * conversions rather than saving them. It also moved the score in the sixth
 * decimal. Transposing `tmp` so the vertical pass reads sequentially was also
 * tried: bit-identical, and 6-20% slower, because the two extra full passes
 * cost more than the strided reads they remove. Peak RSS was unchanged by any
 * of the three.
 */
function blur(
  src: Float64Array,
  width: number,
  height: number,
  kernel: Float64Array,
  radius: number,
  tmp: Float64Array,
  dst: Float64Array,
): void {
  // Where the window fits entirely inside the row/column. Empty when the image
  // is narrower or shorter than the window, in which case every pixel clamps.
  const xLo = Math.min(radius, width);
  const xHi = Math.max(xLo, width - radius);
  const yLo = Math.min(radius, height);
  const yHi = Math.max(yLo, height - radius);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < xLo; x++) tmp[row + x] = clampedTap(src, row, x, width, kernel, radius);
    for (let x = xLo; x < xHi; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) acc += src[row + x + t] * kernel[t + radius];
      tmp[row + x] = acc;
    }
    for (let x = xHi; x < width; x++) tmp[row + x] = clampedTap(src, row, x, width, kernel, radius);
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    if (y >= yLo && y < yHi) {
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let t = -radius; t <= radius; t++) acc += tmp[(y + t) * width + x] * kernel[t + radius];
        dst[row + x] = acc;
      }
    } else {
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let t = -radius; t <= radius; t++) {
          let sy = y + t;
          if (sy < 0) sy = 0;
          else if (sy >= height) sy = height - 1;
          acc += tmp[sy * width + x] * kernel[t + radius];
        }
        dst[row + x] = acc;
      }
    }
  }
}

/** One output of the horizontal pass, for the columns near an edge. */
function clampedTap(
  src: Float64Array, row: number, x: number,
  width: number, kernel: Float64Array, radius: number,
): number {
  let acc = 0;
  for (let t = -radius; t <= radius; t++) {
    let sx = x + t;
    if (sx < 0) sx = 0;
    else if (sx >= width) sx = width - 1;
    acc += src[row + sx] * kernel[t + radius];
  }
  return acc;
}

/**
 * Mean SSIM between two equally sized single-channel planes, values in 0–255.
 *
 * Returns 1 for identical input, including the degenerate case of a constant
 * image where the variance terms vanish.
 */
export function ssimPlane(
  x: Float64Array,
  y: Float64Array,
  width: number,
  height: number,
): number {
  const minDim = Math.min(width, height);
  if (minDim < 3) {
    // Too small for a meaningful window; fall back to an exactness check.
    let identical = true;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) { identical = false; break; }
    }
    return identical ? 1 : 0;
  }

  let win = 11;
  if (minDim < win) win = minDim % 2 === 0 ? minDim - 1 : minDim;
  const radius = (win - 1) / 2;
  const kernel = gaussianKernel(radius, 1.5);

  const n = width * height;
  const xx = new Float64Array(n);
  const yy = new Float64Array(n);
  const xy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xx[i] = x[i] * x[i];
    yy[i] = y[i] * y[i];
    xy[i] = x[i] * y[i];
  }

  const tmp = new Float64Array(n);
  const muX = new Float64Array(n);
  const muY = new Float64Array(n);
  const sXX = new Float64Array(n);
  const sYY = new Float64Array(n);
  const sXY = new Float64Array(n);

  blur(x, width, height, kernel, radius, tmp, muX);
  blur(y, width, height, kernel, radius, tmp, muY);
  blur(xx, width, height, kernel, radius, tmp, sXX);
  blur(yy, width, height, kernel, radius, tmp, sYY);
  blur(xy, width, height, kernel, radius, tmp, sXY);

  let total = 0;
  let count = 0;
  for (let py = radius; py < height - radius; py++) {
    for (let px = radius; px < width - radius; px++) {
      const i = py * width + px;
      const mx = muX[i], my = muY[i];
      const mx2 = mx * mx, my2 = my * my, mxy = mx * my;
      const vx = sXX[i] - mx2;
      const vy = sYY[i] - my2;
      const vxy = sXY[i] - mxy;

      const num = (2 * mxy + C1) * (2 * vxy + C2);
      const den = (mx2 + my2 + C1) * (vx + vy + C2);
      total += num / den;
      count++;
    }
  }

  return count > 0 ? total / count : 1;
}
