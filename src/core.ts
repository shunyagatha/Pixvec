/**
 * Vecline core — the portable half.
 *
 * Everything exported here is plain TypeScript with **no dependencies and no
 * Node built-ins**. It runs unchanged in Node, Deno, Bun, a browser, a service
 * worker, or an edge runtime, and bundles without native modules.
 *
 * ```ts
 * import { vectorizeExact } from 'vecline/core';
 *
 * // In a browser, straight from a canvas:
 * const { data, width, height } = ctx.getImageData(0, 0, w, h);
 * const { svg } = vectorizeExact({ width, height, data });
 * ```
 *
 * The contract is a plain `RasterImage` — `{ width, height, data }` where `data`
 * is straight (non-premultiplied) RGBA8. That is byte-for-byte the same layout
 * as the browser's `ImageData`, so canvas pixels can be handed over directly
 * with no conversion.
 *
 * **What is not here, and why.** Reading PNG/JPEG/WebP files, rendering an SVG
 * back to pixels, and re-encoding a bitmap all require real codecs. Those live
 * in the main `vecline` entry point, which pulls in libvips and resvg and
 * therefore only runs on Node. Verification (`--verify`, the lossless
 * guarantee) needs a renderer, so it lives there too.
 *
 * The BMP, ICO, PNM and TGA decoders *are* here: they are implemented from
 * scratch in this package and need nothing external.
 */

// --- Types -----------------------------------------------------------------
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
  SizeBudgetReport,
} from './types.js';

// --- Colour science --------------------------------------------------------
export {
  srgbToLinear,
  linearToSrgb,
  srgbToOklab,
  oklabToSrgb,
  srgbToLab,
  deltaE2000,
  luma709,
  hex,
  shortHex,
  parseCssColor,
} from './color.js';

// --- Pixel buffers ---------------------------------------------------------
export {
  createImage,
  sameSize,
  premultiply,
  compositeOver,
  isOpaque,
  packRgba,
  unpackRgba,
  colorHistogram,
  subsample,
} from './image.js';

// --- Background removal ---------------------------------------------------
export {
  removeBackground,
  detectBackgroundColor,
  type RemoveBackgroundOptions,
  type RemoveBackgroundResult,
} from './background.js';

// --- Quality metrics -------------------------------------------------------
export { compareImages, ssimPlane, type CompareOptions } from './metrics/index.js';

// --- Perceptual visual-regression diff (pure) ------------------------------
export { diffImages, type DiffOptions, type DiffResult } from './diff.js';

// --- SVG construction ------------------------------------------------------
export { PathBuilder, num } from './svg/path.js';
export { SvgDoc, fillAttrs, escapeText, escapeAttr, type SvgDocOptions } from './svg/build.js';
export { optimizeSvg, type OptimizeOptions } from './svg/optimize.js';
export { measureSvgComplexity, countPathNodes, type SvgComplexity } from './svg/budget.js';

// --- Vectorisation ---------------------------------------------------------
export {
  vectorizePixels,
  countDistinctColors,
  dominantColor,
  type PixelVectorizeOptions,
  type PixelVectorizeOutput,
} from './vectorize/pixel.js';

export {
  vectorizeExact,
  vectorizeExactContours,
  type ExactOptions,
  type ExactOutput,
  type ContourOutput,
} from './vectorize/exact.js';

export {
  trace,
  traceSeparations,
  TRACE_DEFAULTS,
  type TraceOptions,
  type TraceOutput,
  type Separation,
} from './vectorize/trace.js';

// --- Pre-tracing pixel filters, all pure ------------------------------------
export { selectiveBlur, type BlurOptions } from './preprocess.js';
export {
  applyThreshold,
  otsuThreshold,
  type ThresholdOptions,
  type ThresholdResult,
} from './vectorize/threshold.js';

// --- Vectorisation internals, for building your own pipeline ---------------
export {
  quantize,
  quantizeAlpha,
  NearestColor,
  extractPalette,
  paletteToCssVars,
  type Palette,
  type QuantizeOptions,
  type FillStrategy,
  type PaletteEntry,
} from './vectorize/quantize.js';

export {
  connectedComponents,
  despeckle,
  adaptiveMinArea,
  type ComponentMap,
} from './vectorize/components.js';

export { traceComponents, type Loop, type TurnPolicy } from './vectorize/contour.js';

export {
  centerlineTrace,
  centerlinePolylines,
  type CenterlineOptions,
  type CenterlineOutput,
} from './vectorize/centerline.js';

export {
  fitLoop,
  type FitOptions,
  type FittedPath,
  type Segment,
} from './vectorize/fit.js';

export {
  detectPrimitive,
  primitiveSvg,
  type Primitive,
  type PrimitiveOptions,
} from './vectorize/primitives.js';

export {
  detectGradients,
  GRAD_BASE,
  GRADIENT_DEFAULTS,
  type GradientTuning,
  type GradientPaint,
  type GradientResult,
} from './vectorize/gradient.js';

// --- Format codecs written from scratch, so they need no libvips -----------
//
// The decoders *and* the matching encoders both live here, so a browser or edge
// consumer of vecline/core can round-trip BMP, ICO, PNM and TGA with no native
// dependency. Exporting only the decoders (as an earlier version did) made the
// "square conversion matrix" claim false for the portable build: those callers
// could read the four formats but not write them.
export {
  decodeBmp,
  decodeIco,
  decodePnm,
  decodeTga,
  decodeFallback,
  decodeTgaFallback,
  sniffFallbackFormat,
  listIcoEntries,
  isBmp,
  isIco,
  isPnm,
  isTga,
  encodeBmp,
  encodePnm,
  encodeTga,
  encodeIco,
  encodeIcoDib,
  type FallbackFormat,
  type SignatureFormat,
  type FallbackResult,
  type IcoEntry,
  type BmpEncodeOptions,
  type PnmEncodeOptions,
  type TgaEncodeOptions,
  type IcoEntryInput,
} from './io/formats/index.js';

// --- Preprocessing that stays pure -----------------------------------------
export { autoMinArea } from './vectorize/trace.js';

// --- Conversion routing (pure) ---------------------------------------------
// "Given these input bytes and this desired output, what kind of conversion is
// this?" — the question any converter UI answers, not just the CLI.
export { chooseConvertRoute, type ConvertRoute } from './io/route.js';

// --- Byte helpers, useful when feeding the decoders ------------------------
export { toBase64, fromBase64, bytesEqual, latin1 } from './io/formats/bytes.js';

// --- Pluggable codec registry ----------------------------------------------
// The socket for formats this package does not ship a codec for (HEIC, JPEG XL,
// JPEG 2000): register your own WASM decoder/encoder and it plugs into the same
// pipeline. Pure — it only holds functions — so it belongs in the core.
export {
  registerDecoder,
  registerEncoder,
  unregisterDecoder,
  unregisterEncoder,
  findDecoder,
  findEncoder,
  registeredFormats,
  type CustomDecoder,
  type CustomEncoder,
} from './codecs.js';

// --- SVG → framework component codegen (pure) ------------------------------
export { toComponent, type Framework, type ComponentOptions } from './emit/component.js';

// --- SVG sprite / symbol sheets (pure) -------------------------------------
export { svgSprite, type SpriteItem, type SpriteOptions } from './emit/sprite.js';

// --- Content-aware smart crop (pure) ---------------------------------------
export { smartCrop, cropImage, type SmartCropOptions, type CropRect } from './crop.js';

// --- Animated SVG assembly (pure) ------------------------------------------
export { framesToAnimatedSvg, type AnimateOptions } from './emit/animate.js';

// --- Lazy-load placeholders (pure) -----------------------------------------
export { blurHash, lqipSvg, type LqipOptions } from './placeholder/index.js';

// --- Non-SVG vector exporters: DXF / EPS / PDF (pure) ----------------------
// Structured Bézier geometry plus writers for the CAD/CNC/print formats every
// other JS tracer skips. All pure text — no libvips, no resvg.
export {
  traceGeometry,
  toDxf,
  toEps,
  toPdf,
  toGcode,
  type TraceGeometry,
  type GeometryPath,
  type DxfOptions,
  type EpsOptions,
  type PdfOptions,
  type GcodeOptions,
} from './io/export/index.js';

/** Version of the package this build came from. */
export const VERSION = '1.40.1';
