import { loadSharp } from './io/native.js';
import type { RasterImage, Rgba } from './types.js';

/**
 * `vecline/ops` — raster editing, on the way in or out.
 *
 * The conversion pipeline sometimes needs the pixels changed first: a 12-megapixel
 * photo downscaled before tracing, a scan deskewed, a busy background blurred
 * back. These are exactly the operations `sharp` already does well, so this
 * module is a thin, typed adapter over it rather than a reimplementation — the
 * point is to make them reachable from a Vecline pipeline without every caller
 * re-deriving the raw-buffer plumbing.
 *
 * **This is Node-only** and deliberately *not* part of `vecline/core`: it needs
 * libvips. It ships as its own entry point so a browser or edge consumer never
 * pulls it in, and so a Node consumer who wants it opts in with an explicit
 * `import ... from 'vecline/ops'`.
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

/** A single overlay for {@link OpsChain.composite}. */
export interface CompositeInput {
  /** Overlay image: a file path or already-encoded bytes sharp can decode. */
  input: string | Uint8Array;
  /** Blend mode. `over` (default) is normal alpha compositing. */
  blend?:
    | 'over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
    | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
    | 'difference' | 'exclusion' | 'add' | 'dest-over' | 'xor';
  /** Anchor. Ignored when `top`/`left` are given. */
  gravity?:
    | 'north' | 'northeast' | 'east' | 'southeast' | 'south'
    | 'southwest' | 'west' | 'northwest' | 'centre' | 'center';
  /** Absolute offset from the top edge, in pixels. */
  top?: number;
  /** Absolute offset from the left edge, in pixels. */
  left?: number;
  /** Repeat the overlay to fill, honouring gravity. */
  tile?: boolean;
}

export interface OpsChain {
  // --- Geometry (narrow the frame, then transform it) ---
  /** Crop to a region, in pixels, applied first. */
  crop?: { left: number; top: number; width: number; height: number };
  /** Auto-crop a uniform border. `true` uses the top-left pixel's colour. */
  trim?: boolean | { background: Rgba; threshold?: number };
  resize?: ResizeOptions;
  /** Degrees clockwise. Multiples of 90 are lossless. */
  rotate?: number;
  /** Fill exposed corners when rotating by a non-multiple of 90. */
  rotateBackground?: Rgba;
  /** Mirror top-to-bottom. */
  flip?: boolean;
  /** Mirror left-to-right. */
  flop?: boolean;
  /** Arbitrary affine warp: a row-major 2×2 matrix `[a, b, c, d]`. */
  affine?: { matrix: [number, number, number, number]; background?: Rgba };
  /** Pad the edges outward. */
  extend?: {
    top?: number; left?: number; bottom?: number; right?: number;
    background?: Rgba;
    /** How the new pixels are filled. `background` (default), or extend the edge. */
    with?: 'background' | 'copy' | 'repeat' | 'mirror';
  };

  // --- Tone and detail ---
  /** Gaussian blur sigma. */
  blur?: number;
  /** Unsharp-mask sigma. */
  sharpen?: number;
  /** Median filter window size; denoises without softening edges. */
  median?: number;
  /** Gamma correction, 1.0–3.0. */
  gamma?: number;
  /** Levels adjustment `a * input + b`; scalar or per-channel. */
  linear?: { a: number | number[]; b?: number | number[] };
  /** Contrast-limited adaptive histogram equalisation (local contrast). */
  clahe?: { width: number; height: number; maxSlope?: number };
  /** Arbitrary convolution kernel. */
  convolve?: { width: number; height: number; kernel: number[]; scale?: number; offset?: number };
  /** Stretch contrast to the full range. */
  normalize?: boolean;

  // --- Colour ---
  /** Desaturate to greyscale (output stays RGBA). */
  grayscale?: boolean;
  /** Photographic negative. */
  negate?: boolean;
  /** Tint toward a colour, preserving alpha. */
  tint?: Rgba;
  modulate?: ModulateOptions;
  /** Recombine channels through a 3×3 matrix (e.g. sepia). */
  recomb?: [[number, number, number], [number, number, number], [number, number, number]];
  /** Binarise: pixels at or above this luminance become white, the rest black. */
  threshold?: number;

  // --- Morphology ---
  /** Grow foreground by this many pixels. */
  dilate?: number;
  /** Shrink foreground by this many pixels. */
  erode?: number;

  // --- Compositing ---
  /** Overlay one or more images (watermark, badge, montage). */
  composite?: CompositeInput[];

  // --- Finish ---
  /** Make pure-white pixels transparent. */
  unflatten?: boolean;
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
  const sharp = await loadSharp();
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
  if (ops.affine) {
    pipeline = pipeline.affine(ops.affine.matrix, {
      background: ops.affine.background ? rgbaToSharp(ops.affine.background) : { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  if (ops.extend) {
    pipeline = pipeline.extend({
      top: ops.extend.top ?? 0, left: ops.extend.left ?? 0,
      bottom: ops.extend.bottom ?? 0, right: ops.extend.right ?? 0,
      background: ops.extend.background ? rgbaToSharp(ops.extend.background) : { r: 0, g: 0, b: 0, alpha: 0 },
      extendWith: ops.extend.with ?? 'background',
    });
  }

  // --- Tone and detail ---
  if (ops.median && ops.median > 0) pipeline = pipeline.median(ops.median);
  if (ops.blur && ops.blur > 0) pipeline = pipeline.blur(ops.blur);
  if (ops.sharpen && ops.sharpen > 0) pipeline = pipeline.sharpen({ sigma: ops.sharpen });
  if (ops.clahe) pipeline = pipeline.clahe(ops.clahe);
  if (ops.gamma) pipeline = pipeline.gamma(ops.gamma);
  if (ops.linear) pipeline = pipeline.linear(ops.linear.a, ops.linear.b ?? 0);
  if (ops.convolve) pipeline = pipeline.convolve(ops.convolve);
  if (ops.normalize) pipeline = pipeline.normalize();

  // --- Colour ---
  // Desaturate via modulate rather than `.grayscale()`: the latter collapses the
  // working colourspace to a single band, which then breaks the raw-RGBA round
  // trip this pipeline round-trips through. `saturation: 0` produces the same
  // luma-grey while keeping four channels intact.
  if (ops.grayscale) pipeline = pipeline.modulate({ saturation: 0 });
  if (ops.negate) pipeline = pipeline.negate({ alpha: false });
  if (ops.tint) pipeline = pipeline.tint({ r: ops.tint.r, g: ops.tint.g, b: ops.tint.b });
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
  if (ops.recomb) pipeline = pipeline.recomb(ops.recomb);
  // `grayscale: false` keeps threshold per-channel; the default collapses the
  // image to one band, which breaks the four-channel raw round trip (the same
  // failure mode as `.grayscale()`).
  if (ops.threshold !== undefined) {
    pipeline = pipeline.threshold(ops.threshold, { grayscale: false });
  }

  // --- Morphology ---
  if (ops.dilate && ops.dilate > 0) pipeline = pipeline.dilate(ops.dilate);
  if (ops.erode && ops.erode > 0) pipeline = pipeline.erode(ops.erode);

  // --- Compositing (overlays sit on top of the finished pixels) ---
  if (ops.composite && ops.composite.length > 0) {
    pipeline = pipeline.composite(
      ops.composite.map((c) => ({
        input: typeof c.input === 'string' ? c.input : Buffer.from(c.input),
        blend: c.blend,
        gravity: c.gravity,
        top: c.top,
        left: c.left,
        tile: c.tile,
      })),
    );
  }

  // --- Finish ---
  if (ops.unflatten) pipeline = pipeline.unflatten();
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
    // Geometry
    ops.crop || ops.trim || ops.resize || ops.rotate || ops.flip || ops.flop ||
    ops.affine || ops.extend ||
    // Tone and detail
    ops.blur || ops.sharpen || ops.median || ops.gamma || ops.linear ||
    ops.clahe || ops.convolve || ops.normalize ||
    // Colour
    ops.grayscale || ops.negate || ops.tint || ops.modulate || ops.recomb ||
    // Morphology
    ops.dilate || ops.erode ||
    // Compositing
    (ops.composite && ops.composite.length > 0) ||
    // Finish
    ops.unflatten || ops.flatten ||
    // threshold: 0 is a valid, effectful cutoff, so test presence not truthiness.
    ops.threshold !== undefined,
  );
}
