import { srgbToOklab } from './color.js';
import type { RasterImage, Rgba } from './types.js';

/**
 * Background removal — turning a solid backdrop transparent.
 *
 * Two decisions make the difference between this being useful and being a
 * footgun:
 *
 * **It flood-fills from the edges by default.** Removing "every white pixel"
 * from a logo also punches holes through the whites *inside* it — the glint in
 * an eye, the counter of an 'o', a highlight. Only colour reachable from the
 * border without crossing the subject is actually background, so that is what
 * gets removed. Pass `edgesOnly: false` for the blunt global version when you
 * genuinely want every matching pixel gone.
 *
 * **Tolerance is measured in Oklab, not RGB.** A JPEG's "white" background is
 * never exactly `#ffffff`, and an RGB threshold loose enough to catch it is also
 * loose enough to eat pale yellows. Perceptual distance keeps "slightly off
 * white" and "a colour a human would call different" on opposite sides of the
 * line.
 */

export interface RemoveBackgroundOptions {
  /**
   * Colour to knock out. Omitted means detect it: the most common colour around
   * the border, which is what a backdrop looks like from the inside.
   */
  color?: Rgba;
  /**
   * How far a pixel may sit from the background colour and still count, as an
   * Oklab distance. 0 matches exactly; 0.02 absorbs JPEG ringing; above about
   * 0.1 it starts eating genuinely different colours.
   */
  tolerance?: number;
  /** Remove only background reachable from the border. Default true. */
  edgesOnly?: boolean;
  /**
   * Soften the cut by making near-threshold pixels partly transparent instead of
   * fully opaque or fully clear, which avoids a hard jagged edge.
   */
  feather?: boolean;
}

export interface RemoveBackgroundResult {
  image: RasterImage;
  /** The colour that was treated as background. */
  color: Rgba;
  /** How many pixels became fully or partly transparent. */
  removed: number;
  /** True when the colour was detected rather than supplied. */
  detected: boolean;
}

const DEFAULT_TOLERANCE = 0.02;

/**
 * Guess the backdrop from the border.
 *
 * Sampling the whole image would pick whichever colour is most *common*, which
 * on a logo is often the subject. The border is where a background is by
 * definition, so that is where the vote happens.
 */
export function detectBackgroundColor(img: RasterImage): Rgba {
  const { width, height, data } = img;
  const votes = new Map<number, number>();

  const vote = (x: number, y: number): void => {
    const o = (y * width + x) * 4;
    const key =
      data[o + 3] === 0
        ? 0
        : ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  };

  for (let x = 0; x < width; x++) {
    vote(x, 0);
    if (height > 1) vote(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    vote(0, y);
    if (width > 1) vote(width - 1, y);
  }

  let best = 0;
  let bestKey = 0;
  for (const [key, count] of votes) {
    if (count > best) { best = count; bestKey = key; }
  }

  return {
    r: (bestKey >>> 24) & 0xff,
    g: (bestKey >>> 16) & 0xff,
    b: (bestKey >>> 8) & 0xff,
    a: bestKey & 0xff,
  };
}

/** Make the background transparent, returning a new image. */
export function removeBackground(
  img: RasterImage,
  opts: RemoveBackgroundOptions = {},
): RemoveBackgroundResult {
  const { width, height } = img;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const edgesOnly = opts.edgesOnly ?? true;
  const detected = opts.color === undefined;
  const color = opts.color ?? detectBackgroundColor(img);

  const out: RasterImage = {
    width,
    height,
    data: new Uint8ClampedArray(img.data),
  };

  const target = new Float64Array(3);
  srgbToOklab(color.r, color.g, color.b, target);
  const scratch = new Float64Array(3);

  /** Perceptual distance from the background colour, in Oklab. */
  const distanceAt = (index: number): number => {
    const o = index * 4;
    // A pixel that is already transparent is background by any definition.
    if (img.data[o + 3] === 0) return 0;
    srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], scratch);
    return Math.hypot(scratch[0] - target[0], scratch[1] - target[1], scratch[2] - target[2]);
  };

  // Feathering needs a band: inside `tolerance` is fully removed, and the
  // half-tolerance beyond it fades, so edges do not come out stair-stepped.
  const outerBand = opts.feather ? tolerance * 2 : tolerance;

  const alphaFor = (distance: number): number => {
    if (distance <= tolerance) return 0;
    if (!opts.feather || distance >= outerBand) return -1; // keep as-is
    return Math.round(255 * ((distance - tolerance) / (outerBand - tolerance)));
  };

  let removed = 0;

  if (!edgesOnly) {
    for (let i = 0; i < width * height; i++) {
      const alpha = alphaFor(distanceAt(i));
      if (alpha < 0) continue;
      if (alpha < out.data[i * 4 + 3]) {
        out.data[i * 4 + 3] = alpha;
        removed++;
      }
    }
    return { image: out, color, removed, detected };
  }

  // Flood fill inward from every border pixel that matches.
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const consider = (index: number): void => {
    if (visited[index]) return;
    visited[index] = 1;
    const alpha = alphaFor(distanceAt(index));
    if (alpha < 0) return; // not background; the fill stops here
    if (alpha < out.data[index * 4 + 3]) {
      out.data[index * 4 + 3] = alpha;
      removed++;
    }
    stack.push(index);
  };

  for (let x = 0; x < width; x++) {
    consider(x);
    if (height > 1) consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    consider(y * width);
    if (width > 1) consider(y * width + width - 1);
  }

  while (stack.length > 0) {
    const index = stack.pop()!;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) consider(index - 1);
    if (x < width - 1) consider(index + 1);
    if (y > 0) consider(index - width);
    if (y < height - 1) consider(index + width);
  }

  return { image: out, color, removed, detected };
}
