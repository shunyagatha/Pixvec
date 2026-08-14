/**
 * Core data types shared across Graver.
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
}

export type VectorizeMode = 'embed' | 'pixel' | 'trace';

/** Full-reference quality comparison between two same-sized rasters. */
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
}
