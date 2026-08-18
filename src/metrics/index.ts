import { deltaE2000, luma709, srgbToLab } from '../color.js';
import { severity, compositeScore, type SeverityReport } from './severity.js';
import { compositeOver, premultiply, sameSize } from '../image.js';
import type { AlphaMode, QualityReport, RasterImage, Rgba } from '../types.js';
import { ssimPlane } from './ssim.js';

export { ssimPlane };
export { severity, compositeScore, type SeverityReport, type SeverityOptions } from './severity.js';

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
    // toward 1 without measuring anything. Alpha joins only when at least one side
    // varies, or when the two are constant at different values.
    if (!(isConstant(planesA.alpha) && isConstant(planesB.alpha) && planesA.alpha[0] === planesB.alpha[0])) {
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
