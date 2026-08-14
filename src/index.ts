/**
 * Pixvec — measurable raster ⇄ SVG conversion.
 *
 * This is the **Node entry point**. It re-exports everything from
 * `pixvec/core` and adds the parts that need real codecs: reading image files,
 * rendering SVG back to pixels, re-encoding bitmaps, and the verified lossless
 * guarantee that depends on being able to render.
 *
 * If you are targeting a browser, Deno, Bun, an edge runtime, or you simply do
 * not want a native dependency, import `pixvec/core` instead. It is the same
 * vectorisation and measurement code with no dependencies at all.
 */

// Everything portable, re-exported so a single import works for Node users.
export * from './core.js';

// --- File decoding (libvips) ----------------------------------------------
export {
  decodeRaster,
  looksLikeSvg,
  type DecodeOptions,
  type Decoded,
} from './io/decode.js';

// --- File encoding (libvips) ----------------------------------------------
export {
  encodeRaster,
  formatFromExtension,
  isRasterExtension,
  type EncodeOptions,
} from './io/encode.js';

// --- SVG rendering (resvg) -------------------------------------------------
export {
  rasterizeSvg,
  baseDirFor,
  type RasterizeOptions,
  type RasterizeResult,
} from './io/rasterize.js';

// --- Embedding, which needs a codec to re-encode and a hash to prove it -----
export {
  vectorizeEmbed,
  extractEmbedded,
  type EmbedOptions,
  type EmbedOutput,
  type ExtractedPayload,
} from './vectorize/embed.js';

// --- Asset pipelines (need the resize/encode path, so Node-only) -----------
export {
  faviconSet,
  type FaviconOptions,
  type FaviconSet,
  type GeneratedFile,
} from './pipelines/favicon.js';
export {
  responsiveSet,
  type ResponsiveOptions,
  type ResponsiveSet,
  type ResponsiveVariant,
} from './pipelines/responsive.js';
export {
  traceAnimation,
  type TraceAnimationOptions,
  type AnimationResult,
} from './pipelines/animate.js';

// --- Documents → images (PDF via the optional `mupdf`; Node-only) ----------
export {
  isPdf,
  renderPdfPages,
  countPdfPages,
  type PdfRenderOptions,
} from './io/pdf.js';

// --- Images → one multi-page PDF (Node-only) -------------------------------
export {
  imagesToPdf,
  assembleImagePdf,
  type ImagePdfOptions,
  type JpegPage,
} from './io/images-pdf.js';

// --- Office ⇄ PDF via the user's LibreOffice (nothing bundled; Node-only) ---
export {
  convertOffice,
  findSoffice,
  buildSofficeArgs,
  OFFICE_FORMATS,
  type OfficeConvertOptions,
  type OfficeConvertResult,
} from './io/office.js';

// --- Orchestration, including the verified lossless guarantee --------------
export {
  PRESETS,
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

// --- Build-tool plugin (Vite/Rollup) --------------------------------------
export { pixvecPlugin, type PixvecPluginOptions } from './plugin/vite.js';

// `api.ts` is the source of truth for the version stamped into generated files.
export { VERSION } from './api.js';
