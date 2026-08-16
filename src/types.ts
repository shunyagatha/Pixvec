/**
 * Core data types shared across Vecline.
 *
 * The canonical in-memory representation is **straight (non-premultiplied) RGBA8
 * in the sRGB colour space**. Every decoder normalises to it and every encoder
 * consumes it, so no module has to guess about premultiplication or gamma.
 */

/** A decoded raster image: straight (non-premultiplied) RGBA8, sRGB. */
export interface RasterImage {
  width: number;
  height: number;
  /** Length is exactly `width * height * 4`. */
  data: Uint8ClampedArray;
}

/**
 * Reject anything that is not a decoded image, at the boundary.
 *
 * The tracers index `source.width`/`source.height` arithmetically and never
 * re-read them, so a value that is merely *absent* does not throw — it
 * propagates as `NaN`/`undefined` all the way to the serialiser and comes back
 * out as `<svg width="undefined" viewBox="0 0 undefined undefined">`: a
 * structurally invalid document that renders as nothing, from a call that
 * reported success. Handing a `Buffer` straight to `trace()` — the natural
 * mistake, since the CLI takes file bytes — does exactly that.
 *
 * A library whose claim is that its output is measured cannot also emit
 * unmeasurable garbage without complaint, so the check is here rather than in
 * each caller.
 */
export function assertRasterImage(value: unknown, fn: string): asserts value is RasterImage {
  const img = value as Partial<RasterImage> | null | undefined;
  const describe = (): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (ArrayBuffer.isView(value)) return `a ${value.constructor.name} of ${value.byteLength} bytes`;
    if (typeof value !== 'object') return `a ${typeof value}`;
    return `an object with keys [${Object.keys(value as object).slice(0, 6).join(', ')}]`;
  };
  // The annotation belongs on the *variable*, not just the arrow: TypeScript
  // only treats a call as never-returning for control-flow narrowing when the
  // callee is a const with an explicit type. Without it, every `img.width`
  // below is reported as possibly-undefined.
  const bad: (why: string) => never = (why) => {
    throw new TypeError(
      `${fn}() expects a decoded RasterImage ({ width, height, data }), but got ${describe()}. ${why} ` +
        'Encoded file bytes must be decoded first — use the `vecline` CLI, or decode to RGBA8 yourself.',
    );
  };

  if (img == null || typeof img !== 'object') bad('It is not an object.');
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height)) {
    bad(`\`width\`/\`height\` must be integers, saw ${String(img.width)}x${String(img.height)}.`);
  }
  if ((img.width as number) < 1 || (img.height as number) < 1) {
    bad(`\`width\`/\`height\` must be positive, saw ${img.width}x${img.height}.`);
  }
  if (!ArrayBuffer.isView(img.data)) bad('`data` is not a typed array.');

  // Length is the one invariant every downstream loop assumes; a short buffer
  // reads past the end as zeroes and silently traces a partly-black image.
  const need = (img.width as number) * (img.height as number) * 4;
  if ((img.data as ArrayBufferView).byteLength !== need) {
    bad(`\`data\` must be exactly width*height*4 = ${need} bytes, saw ${(img.data as ArrayBufferView).byteLength}.`);
  }
}

/** What we could learn about the file before decoding it. */
export interface SourceMeta {
  /** Container format as reported by libvips (`png`, `jpeg`, `webp`, ...). */
  format: string;
  width: number;
  height: number;
  channels: number;
  /** `uchar`, `ushort`, `float`, ... — anything above `uchar` is reduced to 8 bit. */
  depth: string;
  hasAlpha: boolean;
  /** Colour space of the file itself (`srgb`, `cmyk`, `b-w`, ...). */
  space: string;
  /** Pixels per inch, when the container records it. */
  density?: number;
  /** True when an ICC profile was embedded (and therefore honoured on decode). */
  hasProfile: boolean;
  /** Frame count for animated formats; 1 for stills. */
  frames: number;
  /** Size of the encoded file in bytes. */
  bytes: number;
  /** EXIF orientation tag (1–8) if present. */
  orientation?: number;
}

export type RasterFormat =
  | 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff' | 'gif'
  | 'bmp' | 'ico' | 'pnm' | 'tga';

/** Alpha model used when comparing two images. */
export type AlphaMode = 'premultiplied' | 'straight';

/** An RGBA colour with 0–255 components. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Result of any raster -> SVG conversion. */
export interface VectorizeResult {
  svg: string;
  width: number;
  height: number;
  /** Which strategy actually produced the output. */
  mode: VectorizeMode;
  /** Number of `<path>` / `<rect>` / `<image>` elements emitted. */
  shapes: number;
  /** Palette size actually used (0 for `embed`). */
  colors: number;
  /** True when the SVG is provably a bit-exact representation of the input. */
  lossless: boolean;
  /** Populated when verification ran. */
  quality?: QualityReport;
  /** Human-readable notes worth surfacing to the caller. */
  notes: string[];
  /** Wall-clock milliseconds spent. */
  elapsedMs: number;
  /** For `trace`: the parameters the refinement loop settled on. */
  settled?: Record<string, number | string | boolean>;
  /** Populated when a size/complexity budget was requested. */
  budget?: SizeBudgetReport;
}

/**
 * What a size budget cost, measured rather than asserted.
 *
 * A budget without a receipt is just an opaque slider. This records the target,
 * what was actually delivered, and — by rendering both the unconstrained and
 * the final result — exactly how much accuracy was traded away to hit it.
 */
export interface SizeBudgetReport {
  /** Byte ceiling requested, if any. */
  targetBytes?: number;
  /** Anchor-point ceiling requested, if any. */
  targetNodes?: number;
  /** Bytes actually produced. */
  bytes: number;
  /** Anchor points actually produced. */
  nodes: number;
  /** Whether every requested ceiling was met. */
  met: boolean;
  /** Relaxation steps taken (0 = the default settings already fit). */
  steps: number;
  /** Bytes/nodes before any relaxation, for comparison. */
  baselineBytes: number;
  baselineNodes: number;
  /** Mean SSIM of the unconstrained output. */
  baselineSsim?: number;
  /** Mean SSIM actually delivered. */
  ssim?: number;
  /** `ssim - baselineSsim`: negative is what the budget cost you. */
  ssimCost?: number;
}

export type VectorizeMode = 'embed' | 'pixel' | 'trace';

/** Full-reference quality comparison between two same-sized rasters. */
import type { SeverityReport } from './metrics/severity.js';

export interface QualityReport {
  width: number;
  height: number;
  pixels: number;
  /** Pixels that match on all four channels. */
  exactPixels: number;
  /** `exactPixels / pixels`, in [0, 1]. */
  exactRatio: number;
  /** Largest absolute per-channel difference found (0–255). */
  maxChannelDiff: number;
  /** Mean squared error over premultiplied RGBA, in [0, 65025]. */
  mse: number;
  rmse: number;
  /** Peak signal-to-noise ratio in dB; `Infinity` when the images are identical. */
  psnr: number;
  /** Mean of the per-channel SSIM over premultiplied R, G, B. */
  ssim: number;
  /** SSIM over Rec.709 luma. */
  ssimLuma: number;
  /** CIEDE2000 statistics, computed over both images composited on `deltaEBackground`. */
  deltaE: { mean: number; p95: number; max: number };
  deltaEBackground: Rgba;
  alphaMode: AlphaMode;
  /** True when every channel of every pixel matches. */
  lossless: boolean;
  /**
   * Where the error is, not just how much — present when  was asked
   * for. Global aggregates cannot separate a harmless dusting of antialiasing
   * from one solid wrong-coloured region; this clusters the differing pixels so
   * a coherent blob outweighs scattered dust.
   */
  severity?: SeverityReport;
  /**
   * A single geometric-mean score over accuracy, structure and error coherence,
   * in [0, 1]. Geometric so no strong axis can carry a collapsed one.
   */
  composite?: number;
}
