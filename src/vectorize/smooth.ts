import type { RasterImage } from '../types.js';

/**
 * Edge-preserving simplification, as a pre-pass before quantisation.
 *
 * WHY THIS EXISTS, and what it is not.
 *
 * A 100x100 JPEG of a sticker traces to something that looks exactly like the
 * JPEG: blocky, noisy, gradient-ridden. Being faithful to damage is not a virtue,
 * and every knob already in the tracer makes it worse rather than better —
 * measured, with the pictures kept:
 *
 *   minArea 40          erases the subject along with the speckle
 *   curve fitting       fits the noise, so edges come back SPECKLED, not smooth
 *   segmentation        visually near-identical to the default
 *   Gaussian blur       softens the edges, which is the opposite of the goal
 *
 * The missing capability is a filter that flattens interiors while refusing to
 * average across a boundary. Perona-Malik diffusion does exactly that: each pixel
 * flows toward its neighbours, and the flow is throttled by `g(|gradient|)`, which
 * falls off sharply once a difference looks like an edge rather than like noise.
 *
 * WHAT IT IS NOT. This does not turn a traced photograph into the redrawn,
 * flat-filled illustration a reconstruction-based tool produces. Those tools
 * recover the artwork that existed before the raster was shrunk and compressed,
 * using priors about what illustrations look like. This is a filter; it makes the
 * input cleaner, not different in kind. Measured against one such output the
 * character is still visibly "smoothed photograph", and no strength setting
 * changes that — past a point the subject dissolves instead.
 *
 * WHAT IT ACTUALLY BUYS, over five subjects at `colors: 16`:
 *
 *   sticker (noisy JPEG)   0.48x bytes   SSIM -0.0435
 *   photo-cat              0.64x         -0.1119
 *   photo-parrots          0.72x         -0.0196
 *   flat-art               0.72x         -0.0200
 *   logo-tux (clean PNG)   0.77x         -0.0903
 *
 * Read the first and last rows together, because they are the whole argument for
 * scaling this by measured noise rather than shipping a constant. The sticker buys
 * a 2.1x reduction for 0.04 SSIM. logo-tux pays more than twice that for barely
 * any reduction — because it is a clean PNG with no noise to remove, so the
 * diffusion has nothing to eat except real detail.
 */

/** Perona-Malik conductance: flow freely below `kappa`, stop above it. */
function conductance(gradient: number, kappa: number): number {
  const t = gradient / kappa;
  return Math.exp(-(t * t));
}

/**
 * Mean absolute deviation from the local mean, sampled where the gradient is low.
 *
 * The same quantity `measureFlatness` reports as `interiorNoise`, recomputed here
 * so this module stays usable on its own and does not reach up into the API layer.
 * Alpha-weighted for the same reason it is there: an invisible pixel's colour is
 * whatever the encoder left behind and must not vote.
 */
export function interiorNoiseOf(img: RasterImage): number {
  const { width: w, height: h, data: d } = img;
  if (w < 3 || h < 3) return 0;
  const lum = (x: number, y: number): number => {
    const o = ((y * w) + x) * 4;
    return ((d[o] + d[o + 1] + d[o + 2]) / 3) * (d[o + 3] / 255);
  };
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = lum(x + 1, y) - lum(x - 1, y);
      const gy = lum(x, y + 1) - lum(x, y - 1);
      if (Math.hypot(gx, gy) > 24) continue;
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mean += lum(x + dx, y + dy);
      sum += Math.abs(lum(x, y) - mean / 9);
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Iterations to spend on an image, from how noisy it measures.
 *
 * `strength` is the user's dial in [0, 1]; the noise term is what keeps a clean
 * source from being smoothed for no reason. The populations this is fitted to are
 * the ones recorded for REFINE_NOISE_LIMIT: clean artwork lands at 0.014-0.219 and
 * noisy artwork at 0.577-5.061, so the curve has to saturate well before 5 or a
 * JPEG photograph would dissolve.
 */
export function iterationsFor(noise: number, strength: number): number {
  if (strength <= 0) return 0;
  // Zero below the clean/noisy boundary, then rising and saturating by ~1.5.
  const excess = Math.max(0, noise - 0.3);
  const scaled = 1 - Math.exp(-excess / 0.5);
  return Math.round(24 * strength * scaled);
}

/**
 * Flatten interiors without crossing boundaries.
 *
 * `strength` in [0, 1] scales how far this is allowed to go; 0 returns the input
 * untouched. Iterations are derived from the image's own measured noise unless
 * `iterations` is given outright, which is what the tests use to pin behaviour.
 *
 * Alpha is carried through untouched. Diffusing it would move the silhouette,
 * which is the one edge nothing here is allowed to touch.
 */
export function smoothPreservingEdges(
  img: RasterImage,
  strength: number,
  opts: { kappa?: number; lambda?: number; iterations?: number } = {},
): RasterImage {
  const kappa = opts.kappa ?? 20;
  const lambda = opts.lambda ?? 0.2;
  const iterations = opts.iterations ?? iterationsFor(interiorNoiseOf(img), strength);
  if (iterations <= 0) return img;

  const { width: w, height: h } = img;
  const cur = new Float64Array(img.data.length);
  for (let i = 0; i < cur.length; i++) cur[i] = img.data[i];
  const next = new Float64Array(cur.length);

  for (let it = 0; it < iterations; it++) {
    next.set(cur);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const o = ((y * w) + x) * 4;
        for (let c = 0; c < 3; c++) {
          const p = cur[o + c];
          const dN = cur[o - w * 4 + c] - p;
          const dS = cur[o + w * 4 + c] - p;
          const dE = cur[o + 4 + c] - p;
          const dW = cur[o - 4 + c] - p;
          next[o + c] = p + lambda * (
            conductance(Math.abs(dN), kappa) * dN +
            conductance(Math.abs(dS), kappa) * dS +
            conductance(Math.abs(dE), kappa) * dE +
            conductance(Math.abs(dW), kappa) * dW
          );
        }
      }
    }
    cur.set(next);
  }

  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = cur[i];
  // Redundant, and kept deliberately. The `c < 3` bound in the loop above is what
  // actually keeps alpha out of the diffusion, so deleting this line changes
  // nothing — mutation-testing it produced no failure, which is how that was
  // established rather than assumed. It stays as a guard for the day someone
  // widens that bound to four and does not notice the silhouette moving.
  for (let i = 3; i < out.length; i += 4) out[i] = img.data[i];
  return { width: w, height: h, data: out };
}
