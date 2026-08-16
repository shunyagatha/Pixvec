/**
 * Animated raster → animated SVG.
 *
 * Reads every frame of an animated GIF or APNG, traces each to vector, and
 * stacks them into one CSS-animated SVG (see {@link framesToAnimatedSvg}). All
 * frames are quantised against a single shared palette so colours stay stable
 * from frame to frame — no per-frame flicker — and the vector output scales
 * cleanly where the source GIF would pixelate. Node-only: frame extraction
 * needs libvips (sharp).
 */

import sharp from 'sharp';
import type { RasterImage, Rgba } from '../types.js';
import { trace, type TraceOptions } from '../vectorize/trace.js';
import { quantize } from '../vectorize/quantize.js';
import { framesToAnimatedSvg, type AnimateOptions } from '../emit/animate.js';
import { DEFAULT_MAX_INPUT_PIXELS } from '../io/decode.js';

export interface TraceAnimationOptions extends AnimateOptions {
  /** Tracing options applied to every frame. */
  trace?: TraceOptions;
  /** Cap the number of frames (sampled evenly) to bound output size. */
  maxFrames?: number;
  /**
   * Guard against decompression bombs, as {@link DEFAULT_MAX_INPUT_PIXELS}.
   * Counts every frame, since libvips decodes the pages into one strip.
   */
  limitInputPixels?: number | false;
}

export interface AnimationResult {
  svg: string;
  /** Frames actually emitted (after any {@link TraceAnimationOptions.maxFrames} cap). */
  frames: number;
  /** Source frame count. */
  sourceFrames: number;
  width: number;
  height: number;
  /** Loop duration in seconds. */
  duration: number;
}

/** Trace an animated image (GIF/APNG bytes) into one animated SVG. */
export async function traceAnimation(
  bytes: Uint8Array,
  opts: TraceAnimationOptions = {},
): Promise<AnimationResult> {
  // An animated source multiplies the risk rather than reducing it: libvips
  // reports `pageHeight` per frame but decodes every page into one strip, so
  // the pixel budget covers width x pageHeight x pages. Left unguarded, a small
  // GIF declaring a large canvas and many frames allocates the product.
  const img = sharp(Buffer.from(bytes), {
    animated: true,
    limitInputPixels: opts.limitInputPixels ?? DEFAULT_MAX_INPUT_PIXELS,
  });
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const pages = meta.pages ?? 1;
  const pageHeight = meta.pageHeight ?? meta.height ?? 0;
  if (width < 1 || pageHeight < 1) {
    throw new Error('Could not determine animation dimensions.');
  }

  const { data } = await img
    .toColorspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  const frameBytes = width * pageHeight * 4;
  const rawDelays = normaliseDelays(meta.delay, pages);

  // Pick frames (evenly sampled if capped), carrying each one's delay along.
  const indices = sampleIndices(pages, opts.maxFrames);
  const frameImages: RasterImage[] = indices.map((p) => ({
    width,
    height: pageHeight,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset + p * frameBytes, frameBytes),
  }));
  const chosenDelayMs = indices.map((p) => rawDelays[p]);

  // One palette for the whole animation, computed from the full frame stack, so
  // a colour that drifts a hair between frames still maps to one swatch.
  const t = opts.trace ?? {};
  const stack: RasterImage = {
    width,
    height: pageHeight * pages,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, frameBytes * pages),
  };
  const palette = quantize(stack, t.colors ?? 16, {
    refineIterations: t.refineIterations,
    fillStrategy: t.fillStrategy,
    fixedPalette: t.fixedPalette,
  });
  const fixedPalette: Rgba[] = [];
  for (let i = 0; i < palette.count; i++) {
    fixedPalette.push({ r: palette.rgb[i * 3], g: palette.rgb[i * 3 + 1], b: palette.rgb[i * 3 + 2], a: 255 });
  }

  const frameSvgs = frameImages.map((f) => trace(f, { ...t, fixedPalette }).svg);

  const totalMs = chosenDelayMs.reduce((a, b) => a + b, 0) || indices.length * 100;
  const duration = opts.duration ?? totalMs / 1000;
  const svg = framesToAnimatedSvg(frameSvgs, { ...opts, duration });

  return {
    svg,
    frames: indices.length,
    sourceFrames: pages,
    width,
    height: pageHeight,
    duration,
  };
}

/** Per-frame delays in ms; sharp may return one value or too few — pad sensibly. */
function normaliseDelays(delay: number[] | undefined, pages: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pages; i++) {
    const d = delay?.[i] ?? delay?.[0] ?? 100;
    // GIF encoders often store 0 for "as fast as possible"; browsers clamp to
    // ~100ms, so match that to avoid a degenerate zero-length loop.
    out.push(d > 0 ? d : 100);
  }
  return out;
}

/** Evenly sample up to `max` frame indices from `pages` (all of them if uncapped). */
function sampleIndices(pages: number, max?: number): number[] {
  if (!max || max >= pages) return Array.from({ length: pages }, (_, i) => i);
  // A single requested frame has no interval to divide by — take a middle,
  // representative frame rather than dividing by (max − 1) = 0.
  if (max === 1) return [Math.round((pages - 1) / 2)];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (pages - 1)) / (max - 1)));
  return [...new Set(out)];
}
