/**
 * `pixvec/vectorize` — the vectorisation engine, on its own.
 *
 * A narrow entry point for consumers who want only raster→SVG and nothing else.
 * Everything here is pure TypeScript with no dependencies, so importing this
 * subpath (rather than the Node entry) keeps a bundle free of libvips and resvg.
 *
 * These same symbols are also re-exported from `pixvec/core`; this barrel exists
 * so a bundler can drop the colour-science and metrics code a caller never
 * touches, and so the intent — "I only need the tracer" — is expressible in the
 * import itself.
 */

export {
  vectorizePixels,
  countDistinctColors,
  dominantColor,
  type PixelVectorizeOptions,
  type PixelVectorizeOutput,
} from './pixel.js';

export {
  vectorizeExact,
  vectorizeExactContours,
  type ExactOptions,
  type ExactOutput,
  type ContourOutput,
} from './exact.js';

export {
  trace,
  autoMinArea,
  TRACE_DEFAULTS,
  type TraceOptions,
  type TraceOutput,
} from './trace.js';

export {
  applyThreshold,
  otsuThreshold,
  type ThresholdOptions,
  type ThresholdResult,
} from './threshold.js';

export {
  quantize,
  quantizeAlpha,
  NearestColor,
  type Palette,
  type QuantizeOptions,
  type FillStrategy,
} from './quantize.js';

export {
  connectedComponents,
  despeckle,
  type ComponentMap,
} from './components.js';

export { traceComponents, type Loop, type TurnPolicy } from './contour.js';

export {
  fitLoop,
  type FitOptions,
  type FittedPath,
  type Segment,
} from './fit.js';

export {
  detectGradients,
  GRAD_BASE,
  GRADIENT_DEFAULTS,
  type GradientTuning,
  type GradientPaint,
  type GradientResult,
} from './gradient.js';
