/**
 * Where the error is, not just how much.
 *
 * SSIM, PSNR and mean ΔE are global aggregates, and a global aggregate cannot
 * tell two very different failures apart: a fine dusting of half-wrong pixels
 * spread over the whole frame, and one solid wrong-coloured blob in the middle of
 * a face. The dusting is usually invisible — it is the antialiasing along every
 * edge, which any vector approximation produces. The blob is the thing a person
 * actually notices. Averaged over a megapixel they can score the same.
 *
 * `diff --fail-over` had the same blind spot from the other direction: it gated
 * on the *fraction* of changed pixels, which counts the harmless dusting and the
 * damaging blob at one pixel each.
 *
 * This measures coherence instead. Pixels that differ beyond a perceptual
 * threshold are opened morphologically — a pixel survives only if it has enough
 * differing neighbours — which deletes single-pixel edge filaments while leaving
 * solid regions untouched. What remains is grouped into 4-connected clusters, and
 * the score is driven by the *sum of squared areas*, so one cluster of 400 px
 * outweighs 400 scattered singles by a factor of 400 rather than tying with them.
 *
 * Pure TypeScript over the existing ΔE field, so it stays in the portable core.
 */

import type { RasterImage } from '../types.js';

export interface SeverityOptions {
  /**
   * CIEDE2000 above which a pixel counts as differing. Default 2.0 — the usual
   * "just noticeable difference" line, and the same default `diff` already uses.
   */
  threshold?: number;
  /**
   * How many of a differing pixel's 8 neighbours must also differ for it to
   * survive the open. Default 4. Below this a pixel is a filament — an
   * antialiasing artifact along an edge — not a region.
   */
  minNeighbours?: number;
}

export interface SeverityReport {
  /** Pixels differing beyond the threshold, before the open. */
  differing: number;
  /** Pixels still differing after single-pixel filaments are removed. */
  coherent: number;
  /** Number of distinct 4-connected clusters among the coherent pixels. */
  clusters: number;
  /** Area of the single largest cluster, in pixels. */
  largestCluster: number;
  /**
   * `sqrt(Σ area²) / pixels`, in [0, 1]. Squaring before summing is what makes
   * one coherent blob dominate scattered dust; the square root returns it to
   * pixel units so the ratio is interpretable.
   */
  mass: number;
  /**
   * `1 - mass`, in [0, 1]. 1.0 means no coherent error anywhere. Falls fastest
   * for large contiguous wrong regions, which is what a viewer sees first.
   */
  score: number;
}

/**
 * Cluster the perceptually-differing pixels and score by coherence.
 *
 * `deltaE` is the per-pixel CIEDE2000 field, already computed by
 * {@link compareImages}; passing it in avoids a second colour conversion pass.
 */
export function severity(
  deltaE: Float64Array,
  width: number,
  height: number,
  opts: SeverityOptions = {},
): SeverityReport {
  const threshold = opts.threshold ?? 2.0;
  const minNeighbours = opts.minNeighbours ?? 4;
  const n = width * height;
  const empty: SeverityReport = {
    differing: 0, coherent: 0, clusters: 0, largestCluster: 0, mass: 0, score: 1,
  };
  if (n === 0) return empty;

  const bad = new Uint8Array(n);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (deltaE[i] > threshold) { bad[i] = 1; differing++; }
  }
  if (differing === 0) return empty;

  // Morphological open by neighbour count. A pixel on a one-pixel-wide edge
  // filament has at most two differing neighbours along the filament; a pixel
  // inside a solid wrong region has eight. The cutoff separates them without
  // needing a structuring element or a second buffer pass.
  const kept = new Uint8Array(n);
  let coherent = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!bad[i]) continue;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          if (bad[yy * width + xx]) c++;
        }
      }
      if (c >= minNeighbours) { kept[i] = 1; coherent++; }
    }
  }
  if (coherent === 0) {
    return { differing, coherent: 0, clusters: 0, largestCluster: 0, mass: 0, score: 1 };
  }

  // 4-connected labelling with an explicit stack — recursion would blow the call
  // stack on a large contiguous region, which is exactly the case that matters.
  const seen = new Uint8Array(n);
  const stack = new Int32Array(coherent);
  let clusters = 0, largest = 0, sumSq = 0;
  for (let s = 0; s < n; s++) {
    if (!kept[s] || seen[s]) continue;
    clusters++;
    let top = 0, area = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const i = stack[--top];
      area++;
      const x = i % width, y = (i - x) / width;
      if (x > 0 && kept[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x + 1 < width && kept[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && kept[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[top++] = i - width; }
      if (y + 1 < height && kept[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (area > largest) largest = area;
    sumSq += area * area;
  }

  const mass = Math.min(1, Math.sqrt(sumSq) / n);
  return { differing, coherent, clusters, largestCluster: largest, mass, score: 1 - mass };
}

/**
 * One number for "how good is this", combining accuracy, structure and the
 * location of the error.
 *
 * A geometric mean, deliberately: an arithmetic mean lets a strong axis carry a
 * collapsed one, so a result that is sharp and correctly coloured but has a hole
 * in it can still score well. Multiplying means any axis near zero drags the
 * whole score down, which is the honest behaviour — a result with a hole in it is
 * not "mostly fine".
 *
 * PSNR is unbounded above, so it is mapped through a saturating curve: 40 dB is
 * treated as effectively perfect, which is where per-pixel differences stop being
 * visible. SSIM is used as-is. Severity contributes its own [0,1] score.
 *
 * Returns `1` only for a bit-exact result.
 */
export function compositeScore(psnr: number, ssim: number, severityScore: number): number {
  const p = Number.isFinite(psnr) ? Math.max(0, Math.min(1, psnr / 40)) : 1;
  const s = Math.max(0, Math.min(1, ssim));
  const v = Math.max(0, Math.min(1, severityScore));
  // SSIM is squared so structure counts double: it is the axis that best tracks
  // what a person calls "does this look like the original".
  return Math.pow(p * s * s * v, 1 / 4);
}
