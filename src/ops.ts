import sharp from 'sharp';
import type { RasterImage, Rgba } from './types.js';

/**
 * `pixvec/ops` — raster editing, on the way in or out.
 *
 * The conversion pipeline sometimes needs the pixels changed first: a 12-megapixel
 * photo downscaled before tracing, a scan deskewed, a busy background blurred
 * back. These are exactly the operations `sharp` already does well, so this
 * module is a thin, typed adapter over it rather than a reimplementation — the
 * point is to make them reachable from a Pixvec pipeline without every caller
 * re-deriving the raw-buffer plumbing.
 *
 * **This is Node-only** and deliberately *not* part of `pixvec/core`: it needs
 * libvips. It ships as its own entry point so a browser or edge consumer never
 * pulls it in, and so a Node consumer who wants it opts in with an explicit
 * `import ... from 'pixvec/ops'`.
 */

export interface ResizeOptions {
  width?: number;
  height?: number;
  /** How to reconcile a differing aspect ratio. Mirrors sharp's `fit`. */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Fill colour for `contain`. */
  background?: Rgba;
  /** Resampling kernel. `lanczos3` (default) is the highest quality. */
  kernel?: 'nearest' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3';
}

export interface ModulateOptions {
  /** Multiplier; >1 brightens. */
  brightness?: number;
  /** Multiplier; >1 more saturated. */
  saturation?: number;
  /** Degrees of hue rotation. */
  hue?: number;
  /** Additive lightness. */
  lightness?: number;
}

export interface OpsChain {
  resize?: ResizeOptions;
  /** Degrees clockwise. Multiples of 90 are lossless. */
  rotate?: number;
  /** Fill exposed corners when rotating by a non-multiple of 90. */
  rotateBackground?: Rgba;
  /** Mirror top-to-bottom. */
  flip?: boolean;
  /** Mirror left-to-right. */
  flop?: boolean;
  /** Crop to a region, in pixels, applied before resize. */
  crop?: { left: number; top: number; width: number; height: number };
  /** Auto-crop a uniform border. `true` uses the top-left pixel's colour. */
  trim?: boolean | { background: Rgba; threshold?: number };
  /** Gaussian blur sigma. */
  blur?: number;
  /** Unsharp-mask sigma. */
  sharpen?: number;
  /** Desaturate to greyscale (output stays RGBA). */
  grayscale?: boolean;
  /** Photographic negative. */
  negate?: boolean;
  /** Stretch contrast to the full range. */
  normalize?: boolean;
  modulate?: ModulateOptions;
  /** Composite onto this opaque colour, discarding transparency. */
  flatten?: Rgba;
}

function rawBuffer(img: RasterImage): Buffer {
  return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

function rgbaToSharp(c: Rgba): { r: number; g: number; b: number; alpha: number } {
  return { r: c.r, g: c.g, b: c.b, alpha: c.a / 255 };
}

/**
 * Apply an ordered chain of edits and return a fresh `RasterImage`.
 *
 * The order is fixed and chosen so each step sees sensible input: crop and trim
 * narrow the frame first, then geometry (resize/rotate/flip), then tone and
 * colour, then flatten last so a background colour is applied to the finished
 * pixels rather than to an intermediate. Reordering these would surprise the
 * caller — a blur before a downscale is not the same as after.
 */
export async function editImage(img: RasterImage, ops: OpsChain): Promise<RasterImage> {
  let pipeline = sharp(rawBuffer(img), {
    raw: { width: img.width, height: img.height, channels: 4 },
  });

  if (ops.crop) pipeline = pipeline.extract(ops.crop);
  if (ops.trim) {
    pipeline = pipeline.trim(
      typeof ops.trim === 'object'
        ? { background: rgbaToSharp(ops.trim.background), threshold: ops.trim.threshold }
        : undefined,
    );
  }

  if (ops.resize) {
    pipeline = pipeline.resize({
      width: ops.resize.width,
      height: ops.resize.height,
      fit: ops.resize.fit ?? 'inside',
      kernel: ops.resize.kernel ?? 'lanczos3',
      background: ops.resize.background ? rgbaToSharp(ops.resize.background) : undefined,
      // Do not scale a small source up to fill a larger box unless asked; the
      // most common resize is "fit within", and upscaling by surprise loses detail.
      withoutEnlargement: ops.resize.fit === undefined || ops.resize.fit === 'inside',
    });
  }

  if (ops.rotate) {
    pipeline = pipeline.rotate(ops.rotate, {
      background: ops.rotateBackground ? rgbaToSharp(ops.rotateBackground) : { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  if (ops.flip) pipeline = pipeline.flip();
  if (ops.flop) pipeline = pipeline.flop();

  if (ops.blur && ops.blur > 0) pipeline = pipeline.blur(ops.blur);
  if (ops.sharpen && ops.sharpen > 0) pipeline = pipeline.sharpen({ sigma: ops.sharpen });
  // Desaturate via modulate rather than `.grayscale()`: the latter collapses the
  // working colourspace to a single band, which then breaks the raw-RGBA round
  // trip this pipeline round-trips through. `saturation: 0` produces the same
  // luma-grey while keeping four channels intact.
  if (ops.grayscale) pipeline = pipeline.modulate({ saturation: 0 });
  if (ops.negate) pipeline = pipeline.negate({ alpha: false });
  if (ops.normalize) pipeline = pipeline.normalize();
  if (ops.modulate) {
    // sharp rejects an explicit `undefined` for any modulate field, so pass only
    // the ones the caller actually set — `--brightness` alone must not smuggle a
    // `saturation: undefined` alongside it.
    const m: Record<string, number> = {};
    if (ops.modulate.brightness !== undefined) m.brightness = ops.modulate.brightness;
    if (ops.modulate.saturation !== undefined) m.saturation = ops.modulate.saturation;
    if (ops.modulate.hue !== undefined) m.hue = ops.modulate.hue;
    if (ops.modulate.lightness !== undefined) m.lightness = ops.modulate.lightness;
    if (Object.keys(m).length > 0) pipeline = pipeline.modulate(m);
  }

  if (ops.flatten) {
    pipeline = pipeline.flatten({
      background: { r: ops.flatten.r, g: ops.flatten.g, b: ops.flatten.b },
    });
  }

  const { data, info } = await pipeline.ensureAlpha().raw({ depth: 'uchar' }).toBuffer({
    resolveWithObject: true,
  });

  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** True when a chain has any effect, so callers can skip a no-op pipeline. */
export function hasOps(ops: OpsChain): boolean {
  return Boolean(
    ops.crop || ops.trim || ops.resize || ops.rotate || ops.flip || ops.flop ||
    ops.blur || ops.sharpen || ops.grayscale || ops.negate || ops.normalize ||
    ops.modulate || ops.flatten,
  );
}
