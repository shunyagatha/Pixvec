import { deltaE2000, luma709, srgbToLab } from '../color.js';
import { severity, compositeScore, type SeverityReport } from './severity.js';
import { compositeOver, premultiply, sameSize } from '../image.js';
import type { AlphaMode, QualityReport, RasterImage, Rgba } from '../types.js';
import { ssimPlane } from './ssim.js';

export { ssimPlane };
export { severity, compositeScore, type SeverityReport, type SeverityOptions } from './severity.js';

/**
 * WHY SSIM IS STILL THE MEASURE HERE, after six replacements were evaluated.
 *
 * A search was run for something a low-pass could not win, against a validation
 * set with known answers: a blur must rank below the unblurred original, a config
 * that erased the subject must rank worse, identity must be the maximum. Seven
 * measures, seven photographic subjects. None replaced SSIM, and two failed in ways
 * worth recording so they are not proposed again.
 *
 * GMSD was the worst, at 0 of 7 — not the best, which is the intuitive guess since
 * it is explicitly an edge-structure measure. The mechanism is specific to what a
 * vectoriser emits: our output is piecewise constant, so its gradient field is ZERO
 * inside regions where the source has texture and enormous at region boundaries
 * where the source is smooth. Wrong in both directions at once. A small blur seeds
 * gradient in the flat interiors and spreads it at the boundaries, moving the
 * candidate toward the reference on both counts, so the score improves nearly
 * everywhere. GMSD also decimates 2x before its Prewitt operator, which absorbs a
 * sub-pixel blur outright.
 *
 * MS-SSIM is worse than useless for this question: scale-robust by construction,
 * and scale-robustness is exactly the property that makes a low-pass cheap. It also
 * compresses real gaps — blurring the SOURCE by sigma 4 costs plain SSIM 0.0954 and
 * MS-SSIM only 0.0492.
 *
 * The leading candidate, `SSIM(luma) x min(r, 1/r)` with r the gradient-energy
 * ratio, scored 5 of 7 and was REJECTED for opening a larger hole than it closed.
 * Our output is under-sharp on every photograph (r = 0.42 to 0.55), so `min(r,1/r)`
 * is just r and the score becomes LINEAR in the candidate's gradient energy with
 * 2.4x of free headroom — and nothing in it asks where that gradient came from. A
 * ~200-byte `<feConvolveMatrix>` unsharp mask, no geometry and no information about
 * the source, gained up to +0.2443 (photo-parrots 0.3952 -> 0.6395) on 8 of 9
 * subjects. That is the blur exploit run backwards, at twenty-six times the margin
 * the measure claimed over blur. Plain SSIM is fooled by 0 of the same 45 variants.
 *
 * The transferable rule: a metric that multiplies fidelity by a term the candidate
 * can raise for free is not a fidelity metric, whichever direction the term points.
 *
 * WHAT IS WORTH KEEPING from that work is not a score but a diagnostic:
 * `gradientRatio`, the candidate's mean Sobel magnitude over the reference's. On
 * its own it is the clearest statement of the photographic gap this project has —
 * we retain 0.42 to 0.55 of the source's gradient energy on the six hard
 * photographs where the paid rival retains 0.62 to 0.83. Report it BESIDE a
 * fidelity score, never folded into one, and never alone: it never looks at the
 * reference's content, so pure noise maximises it.
 *
 * And `scripts/bench-scale.mjs` remains the right instrument for flat art — edge
 * weighted, at magnification, against true vector ground truth. It is structurally
 * unavailable for the photographs, which have no vector original; manufacturing one
 * from the raster would be the circular measurement this project has already been
 * caught by. That split is the honest answer, not a gap to be closed.
 */

export interface CompareOptions {
  /**
   * `premultiplied` (default) treats colour under zero alpha as invisible, which
   * is what a renderer does. `straight` compares the raw stored bytes.
   */
  alphaMode?: AlphaMode;
  /** Background used to flatten both images before the CIEDE2000 pass. */
  deltaEBackground?: Rgba;
  /**
   * Also cluster the differing pixels and report where the error is, plus a
   * single composite score. Off by default: it costs one extra pass over the
   * image, and the existing aggregates are what most callers read.
   */
  severity?: boolean;
  /** Skip the CIEDE2000 pass, which is the expensive part on large photos. */
  skipDeltaE?: boolean;
  /** Skip SSIM, which allocates six float planes per channel. */
  skipSsim?: boolean;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/**
 * Full-reference comparison of two same-sized images.
 *
 * Every number here is computed the way the corresponding literature defines it,
 * so the values are comparable against other tools rather than being a private
 * scale. `psnr` is `Infinity` exactly when the images are bit-identical under
 * the chosen alpha model.
 */
export function compareImages(
  reference: RasterImage,
  candidate: RasterImage,
  opts: CompareOptions = {},
): QualityReport {
  if (!sameSize(reference, candidate)) {
    throw new Error(
      `Cannot compare images of different sizes: ` +
        `${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`,
    );
  }

  const alphaMode = opts.alphaMode ?? 'premultiplied';
  const bg = opts.deltaEBackground ?? WHITE;

  const a = alphaMode === 'premultiplied' ? premultiply(reference) : reference.data;
  const b = alphaMode === 'premultiplied' ? premultiply(candidate) : candidate.data;

  const width = reference.width;
  const height = reference.height;
  const pixels = width * height;

  let sqErr = 0;
  let exactPixels = 0;
  let maxChannelDiff = 0;

  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const d0 = a[o] - b[o];
    const d1 = a[o + 1] - b[o + 1];
    const d2 = a[o + 2] - b[o + 2];
    const d3 = a[o + 3] - b[o + 3];

    sqErr += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;

    if (d0 === 0 && d1 === 0 && d2 === 0 && d3 === 0) {
      exactPixels++;
    } else {
      const m = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3));
      if (m > maxChannelDiff) maxChannelDiff = m;
    }
  }

  const mse = sqErr / (pixels * 4);
  const rmse = Math.sqrt(mse);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const lossless = exactPixels === pixels;

  let ssim = 1;
  let ssimLuma = 1;
  if (!lossless && !opts.skipSsim) {
    const planesA = extractPlanes(a, pixels);
    const planesB = extractPlanes(b, pixels);

    const channelScores: number[] = [];
    for (let c = 0; c < 3; c++) {
      channelScores.push(ssimPlane(planesA.rgb[c], planesB.rgb[c], width, height));
    }

    // Score alpha too, but only when it carries something.
    //
    // SSIM used to run over R, G and B alone. Under premultiplied compositing a
    // dark shape on transparency has all-zero RGB, so alpha is the ONLY channel
    // holding the artwork — and it was the one channel SSIM could not see. An
    // EMPTY SVG scored SSIM 1.000000 against a black disc on transparency while
    // 38% of pixels differed, PSNR was 10.18 dB and CIEDE2000 max was 100. Every
    // other number in this same function already included alpha; only the one the
    // `--fail-under` gate reads did not, so the gate could not fail.
    //
    // Conditional because unconditional would be its own quiet bug: on opaque
    // artwork both alpha planes are a constant 255, `ssimPlane` returns 1 for
    // identical constants, and averaging that in would lift every published score
    // toward 1 without measuring anything.
    //
    // WHETHER ALPHA COUNTS IS A PROPERTY OF THE REFERENCE, NOT OF THE CANDIDATE,
    // and the first version of this got that wrong in a way that was exploitable.
    // It admitted alpha whenever EITHER side varied — so a candidate could opt
    // itself into a fourth channel simply by making its own alpha non-constant,
    // and that channel scores ~1.0 against a constant reference plane. Averaging a
    // free 1.0 into the mean dilutes whatever the RGB channels are saying.
    //
    // Measured, and it is not a small effect. Wrapping our own output in one
    // `<feGaussianBlur>` makes alpha vary at the filter-region edge (207..255 on
    // photo-motorcycles). Reported SSIM went 0.5698 -> 0.6716, which read as a
    // blur being the largest quality gain in the project's history. On RGB alone
    // the same blur goes 0.5698 -> 0.5622 — it is WORSE, as it should be. The
    // whole +0.1094 was the fourth channel.
    //
    // So: the reference decides. A varying reference alpha means the artwork lives
    // partly in that channel and it must be scored. Two constant-but-different
    // planes are still a real difference and stay in — that branch cannot be
    // gamed, because the candidate has to be constant to reach it.
    //
    // A candidate that invents transparency against an opaque reference is not
    // lost by this: the RGB planes are composited over `bg` before scoring, so a
    // see-through pixel changes its colour and is caught there.
    const alphaCarriesArtwork = !isConstant(planesA.alpha);
    const flatlyDifferent = isConstant(planesA.alpha) && isConstant(planesB.alpha)
      && planesA.alpha[0] !== planesB.alpha[0];
    if (alphaCarriesArtwork || flatlyDifferent) {
      channelScores.push(ssimPlane(planesA.alpha, planesB.alpha, width, height));
    }
    ssim = channelScores.reduce((s, v) => s + v, 0) / channelScores.length;
    ssimLuma = ssimPlane(planesA.luma, planesB.luma, width, height);
  }

  let deltaE = { mean: 0, p95: 0, max: 0 };
  // The per-pixel field is only retained when severity is asked for, so the
  // default path allocates nothing extra.
  const field = opts.severity && !lossless ? new Float64Array(pixels) : undefined;
  if (!lossless && !opts.skipDeltaE) {
    deltaE = deltaEStats(reference, candidate, bg, field);
  }

  let sev: SeverityReport | undefined;
  let composite: number | undefined;
  if (opts.severity) {
    sev = lossless
      ? { differing: 0, coherent: 0, clusters: 0, largestCluster: 0, mass: 0, score: 1 }
      : severity(field ?? new Float64Array(pixels), width, height);
    composite = lossless ? 1 : compositeScore(psnr, ssim, sev.score);
  }

  return {
    width,
    height,
    pixels,
    exactPixels,
    exactRatio: pixels === 0 ? 1 : exactPixels / pixels,
    maxChannelDiff,
    mse,
    rmse,
    psnr,
    ssim,
    ssimLuma,
    deltaE,
    deltaEBackground: bg,
    alphaMode,
    lossless,
    severity: sev,
    composite,
  };
}

function extractPlanes(rgba: Uint8ClampedArray, pixels: number) {
  const r = new Float64Array(pixels);
  const g = new Float64Array(pixels);
  const b = new Float64Array(pixels);
  const alpha = new Float64Array(pixels);
  const luma = new Float64Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    r[i] = rgba[o];
    g[i] = rgba[o + 1];
    b[i] = rgba[o + 2];
    alpha[i] = rgba[o + 3];
    luma[i] = luma709(rgba[o], rgba[o + 1], rgba[o + 2]);
  }
  return { rgb: [r, g, b] as const, alpha, luma };
}

/** True when every sample is the same value, so the plane carries no structure. */
function isConstant(plane: Float64Array): boolean {
  for (let i = 1; i < plane.length; i++) if (plane[i] !== plane[0]) return false;
  return true;
}

/**
 * CIEDE2000 statistics over both images flattened onto `bg`.
 *
 * The percentile comes from a 0.01-wide histogram rather than a sorted array:
 * a 12-megapixel comparison would otherwise need a 48 MB buffer just to answer
 * "what is the 95th percentile".
 */
function deltaEStats(
  reference: RasterImage,
  candidate: RasterImage,
  bg: Rgba,
  // When supplied, the per-pixel CIEDE2000 is retained here as well as binned.
  // Severity clustering needs the field, and recomputing it would mean a second
  // full Lab conversion over the image for no new information.
  field?: Float64Array,
): { mean: number; p95: number; max: number } {
  const flatA = compositeOver(reference, bg);
  const flatB = compositeOver(candidate, bg);
  const pixels = reference.width * reference.height;

  const BINS = 10_001; // 0.00 .. 100.00 in 0.01 steps
  const hist = new Uint32Array(BINS);
  const labA = new Float64Array(3);
  const labB = new Float64Array(3);

  let sum = 0;
  let max = 0;

  for (let i = 0; i < pixels; i++) {
    const o = i * 3;
    const ra = flatA[o], ga = flatA[o + 1], ba = flatA[o + 2];
    const rb = flatB[o], gb = flatB[o + 1], bb = flatB[o + 2];

    if (ra === rb && ga === gb && ba === bb) {
      hist[0]++;
      continue;
    }

    srgbToLab(ra, ga, ba, labA);
    srgbToLab(rb, gb, bb, labB);
    const de = deltaE2000(labA[0], labA[1], labA[2], labB[0], labB[1], labB[2]);

    if (field) field[i] = de;
    sum += de;
    if (de > max) max = de;
    const bin = Math.min(BINS - 1, Math.round(de * 100));
    hist[bin]++;
  }

  const target = Math.ceil(pixels * 0.95);
  let cumulative = 0;
  let p95 = 0;
  for (let i = 0; i < BINS; i++) {
    cumulative += hist[i];
    if (cumulative >= target) {
      p95 = i / 100;
      break;
    }
  }

  return { mean: pixels === 0 ? 0 : sum / pixels, p95, max };
}
