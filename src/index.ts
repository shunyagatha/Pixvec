/**
 * Pixvec — measurable raster <-> SVG conversion.
 *
 * The public surface is deliberately small: load, convert, measure. Every
 * conversion function is pure with respect to the filesystem; only `loadRaster`
 * reads and nothing here writes, so the library composes into whatever pipeline
 * you already have.
 */

export { VERSION, PRESETS } from './api.js';
export {
  loadRaster,
  loadAnyAsRaster,
  vectorize,
  rasterize,
  verifySvg,
  measureFlatness,
  suggestTitle,
  type VectorizeOptions,
  type VectorizeInput,
  type VectorizeModeOption,
  type Preset,
  type RasterizeToBufferOptions,
  type RasterizeOutcome,
} from './api.js';

export { decodeRaster, looksLikeSvg, type DecodeOptions, type Decoded } from './io/decode.js';
export {
  encodeRaster,
  formatFromExtension,
  isRasterExtension,
  type EncodeOptions,
} from './io/encode.js';
export {
  rasterizeSvg,
  baseDirFor,
  type RasterizeOptions,
  type RasterizeResult,
} from './io/rasterize.js';

export { compareImages, ssimPlane, type CompareOptions } from './metrics/index.js';

export { vectorizePixels, countDistinctColors, dominantColor, type PixelVectorizeOptions, type PixelVectorizeOutput } from './vectorize/pixel.js';
export { vectorizeEmbed, type EmbedOptions, type EmbedOutput } from './vectorize/embed.js';
export { trace, TRACE_DEFAULTS, type TraceOptions, type TraceOutput } from './vectorize/trace.js';
export { quantize, quantizeAlpha, NearestColor, type Palette, type QuantizeOptions } from './vectorize/quantize.js';
export { connectedComponents, despeckle, type ComponentMap } from './vectorize/components.js';
export { traceComponents, type Loop } from './vectorize/contour.js';
export { fitLoop, type FitOptions, type FittedPath, type Segment } from './vectorize/fit.js';

export { PathBuilder, num } from './svg/path.js';
export { SvgDoc, fillAttrs, type SvgDocOptions } from './svg/build.js';

export {
  srgbToOklab,
  oklabToSrgb,
  srgbToLab,
  deltaE2000,
  parseCssColor,
  hex,
  shortHex,
  luma709,
} from './color.js';

export {
  createImage,
  premultiply,
  compositeOver,
  isOpaque,
  packRgba,
  unpackRgba,
  colorHistogram,
  subsample,
} from './image.js';

export type {
  RasterImage,
  SourceMeta,
  RasterFormat,
  AlphaMode,
  Rgba,
  Point,
  VectorizeResult,
  VectorizeMode,
  QualityReport,
} from './types.js';
