import { SvgDoc, fillAttrs } from '../svg/build.js';
import { shortHex } from '../color.js';
import { PathBuilder } from '../svg/path.js';
import { selectiveBlur } from '../preprocess.js';
import type { RasterImage, Rgba } from '../types.js';
import { connectedComponents, despeckle, type ComponentMap } from './components.js';
import { traceComponents, type TurnPolicy } from './contour.js';
import { fitLoop, type FitOptions } from './fit.js';
import { NearestColor, quantize, quantizeAlpha, type FillStrategy } from './quantize.js';
import { applyThreshold } from './threshold.js';
import { detectGradients, GRAD_BASE, type GradientPaint } from './gradient.js';

/**
 * True vectorisation: colour regions become filled paths bounded by curves.
 *
 * The pipeline is quantise → segment → trace → fit, and each stage hands the
 * next one something exact. Contours come off the pixel grid exactly; the only
 * approximation in the whole chain is the final curve fit, and its error is
 * bounded by `fitError` in pixels. That is what makes the output *measurably*
 * close rather than vaguely close.
 *
 * Same-coloured components share one `<path>` with `fill-rule="evenodd"`. That
 * is not just a size optimisation: because every component's own path carries
 * the boundaries of the regions enclosed within it, a component never paints
 * over its own holes, and nesting resolves correctly no matter what order the
 * layers are drawn in.
 */

export interface TraceOptions {
  /** Maximum palette size. */
  colors?: number;
  /** Distinct alpha levels to preserve. 1 means "flatten to fully opaque". */
  alphaLevels?: number;
  /** Regions smaller than this many pixels are absorbed into their neighbours. */
  minArea?: number;
  /** Douglas–Peucker tolerance in pixels for the structural outline. */
  tolerance?: number;
  /** Maximum Bézier fitting error in pixels. */
  fitError?: number;
  /** Turn angle in degrees above which a vertex becomes a sharp corner. */
  cornerAngle?: number;
  /** Skip curve fitting and emit polygons. */
  polygonOnly?: boolean;
  /** Merge adjacent curves where one fits both. Default on. */
  optimize?: boolean;
  /** Error budget for a curve merge. Defaults to `fitError`. */
  optimizeError?: number;
  /** Decimal places kept in path coordinates. */
  precision?: number;
  /** Collapse the dominant colour into one full-canvas rectangle. */
  background?: boolean;
  /** Lloyd relaxation passes during palette construction. */
  refineIterations?: number;
  /**
   * How each palette colour is picked from its cluster — potrace's `fillStrategy`.
   * `mean` (default) averages and then perceptually polishes; `dominant` takes
   * the most common colour; `median` the per-channel median. See {@link FillStrategy}.
   */
  fillStrategy?: FillStrategy;
  /**
   * Trace to exactly these colours (brand palette / spot colours) instead of an
   * auto-computed palette. Every pixel maps to its nearest supplied colour in
   * Oklab. Overrides {@link colors}.
   */
  fixedPalette?: Rgba[];
  /**
   * Selective blur radius applied before quantisation. Removes sensor noise and
   * JPEG grain that would otherwise fragment a flat region into speckle
   * contours, while preserving edges. 0 (default) skips it.
   */
  blur?: number;
  /** Edge-preservation threshold for {@link blur}. Default 20. */
  blurDelta?: number;
  /**
   * Reduce to two colours by a luminance cutoff before tracing — potrace's mode,
   * for scanned line art and black-on-white logos. A number is a fixed 0–255
   * cutoff; `'auto'` uses Otsu's method. Omitted skips it.
   */
  threshold?: number | 'auto';
  /** With {@link threshold}: dark pixels are the shape on a light ground. Default true. */
  blackOnWhite?: boolean;
  /**
   * Reconstruct smooth colour ramps as SVG gradients instead of flat bands.
   * Off by default. A region only becomes a gradient when the gradient's actual
   * rendered output beats the flat bands it replaces (measured per pixel in
   * Oklab), so flat art and hard edges are never affected.
   */
  gradients?: boolean;
  /** Smallest region worth de-banding, in pixels. 0 (default) auto-scales. */
  gradientMinArea?: number;
  /** Largest Oklab step between neighbouring bands that may coalesce. Default 0.08. */
  gradientStepMax?: number;
  /** Fractional error reduction a gradient must clear to beat flat. Default 0.1. */
  gradientMargin?: number;
  /** Absolute RMS-Oklab ceiling for acceptance. Default 0.1. */
  gradientMaxError?: number;
  /** Maximum colour stops per gradient (placed adaptively). Default 16. */
  gradientStops?: number;
  /**
   * How to resolve a diagonal self-touch between two cells of the same region —
   * potrace's `turnPolicy`. `left` (default) always keeps the arms apart, which
   * is what most images want; `right` always joins them; `majority`/`minority`
   * decide from the surrounding pixels. Only matters at checkerboard saddles.
   */
  turnPolicy?: TurnPolicy;
  /**
   * Snap near-axis right-angle corners to an exact 90° so rectangular features —
   * screenshots, UI, pixel art — stay crisp. imagetracerjs's `rightangleenhance`,
   * generalised to a tolerance. Off by default. See {@link rightAngleThreshold}.
   */
  rightAngleEnhance?: boolean;
  /** Degrees of slack for {@link rightAngleEnhance}. Default 12. */
  rightAngleThreshold?: number;
  /**
   * Stroke every path in its own fill colour, at this width in pixels.
   *
   * This is imagetracerjs's trick for hiding the hairline gap that can appear
   * between two abutting colour regions: a thin same-colour stroke overpaints
   * the seam. 0 (default) emits fill-only paths. A value around 1 is typical.
   */
  strokeWidth?: number;
  /**
   * Emit one named `<g>` per colour, tagged as an Inkscape/Illustrator layer, so
   * the SVG opens as editable colour layers (weeding/separation-ready) instead
   * of one flattened blob. Off by default.
   */
  groupByColor?: boolean;
  title?: string;
  generator?: string;
}

export interface TraceOutput {
  svg: string;
  shapes: number;
  colors: number;
  /** Connected regions found before any were merged into a shared path. */
  regions: number;
  /** Regions absorbed by the despeckle pass. */
  despeckled: number;
}

export const TRACE_DEFAULTS = {
  colors: 16,
  alphaLevels: 8,
  minArea: 0,
  // 0.4, not 1.0. A measured diagnosis (scripts/diagnose-photo.mjs) found the
  // curve fitter, not quantisation, is the dominant loss on photographs — 0.11
  // to 0.24 SSIM — and that a 1px tolerance is *strictly worse* than 0.4 on
  // both accuracy and file size across flat art, logos and photos. The old
  // default's curves drifted up to a pixel and flipped boundary pixels while
  // producing *larger* files than a tighter fit. The one thing a large
  // tolerance buys — few smooth curves on a big arc — is preserved by the
  // `logo`/`lineart` presets, which keep a higher value on purpose.
  tolerance: 0.4,
  fitError: 0.4,
  cornerAngle: 75,
  polygonOnly: false,
  optimize: true,
  precision: 2,
  background: true,
  refineIterations: 4,
  strokeWidth: 0,
  groupByColor: false,
  turnPolicy: 'left',
  gradients: false,
  gradientMinArea: 0,
  gradientStepMax: 0.08,
  gradientMargin: 0.1,
  gradientMaxError: 0.1,
  gradientStops: 16,
} as const;

/**
 * Default speck threshold, scaled to the image.
 *
 * A fixed threshold cannot be right for both a 170px thumbnail and a 12-megapixel
 * photograph: at 170px a two-pixel region is a real feature, at 12MP it is noise.
 * Measured across the corpus, `pixels / 50000` lands on the free side of that
 * trade every time —
 *
 *   172x178 JPEG   ->  0  (despeckling here costs 0.087 SSIM; skip it)
 *   265x314 logo   ->  2  (57% smaller for 0.0001 SSIM)
 *   768x512 photo  ->  8  (53% smaller for 0.006 SSIM)
 *   800x600 alpha  -> 10  (37% smaller, and 0.004 SSIM *better*)
 *
 * Values of 1 or below disable the pass, which is what small images want.
 */
export function autoMinArea(pixels: number): number {
  return Math.min(16, Math.round(pixels / 50_000));
}

export function trace(source: RasterImage, opts: TraceOptions = {}): TraceOutput {
  const clean = stripUndefined(opts);
  const o = {
    ...TRACE_DEFAULTS,
    minArea: autoMinArea(source.width * source.height),
    ...clean,
  };

  // --- Preprocess before the tracer ever sees the pixels. ---
  //
  // Order matters: blur removes grain first, then threshold (if requested)
  // collapses to two colours. A blur after thresholding would just soften the
  // clean edge the threshold produced.
  let img = source;
  if (o.blur && o.blur >= 1) {
    img = selectiveBlur(img, { radius: o.blur, delta: o.blurDelta });
  }
  if (opts.threshold !== undefined) {
    img = applyThreshold(img, { threshold: o.threshold, blackOnWhite: o.blackOnWhite }).image;
  }

  const { width, height } = img;
  const n = width * height;

  // --- Quantise colour and alpha independently. ---
  const alphaLevels = quantizeAlpha(img, Math.max(1, o.alphaLevels));
  const palette = quantize(img, o.colors, {
    refineIterations: o.refineIterations,
    fillStrategy: o.fillStrategy,
    fixedPalette: o.fixedPalette,
  });
  const nearest = new NearestColor(palette, n);

  const levelCount = alphaLevels.length;
  let classes: Int32Array = new Int32Array(n);
  let hasVoid = false;

  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const aIdx = nearestLevel(alphaLevels, img.data[off + 3]);
    if (alphaLevels[aIdx] === 0) {
      classes[i] = -1;
      hasVoid = true;
      continue;
    }
    const cIdx = nearest.index(img.data[off], img.data[off + 1], img.data[off + 2]);
    classes[i] = cIdx * levelCount + aIdx;
  }

  // --- Reconstruct smooth ramps as gradients, before segmentation. ---
  //
  // Rewriting the class map here — turning each accepted ramp into one synthetic
  // class — lets the unchanged segment/trace/fit/emit pipeline treat a gradient
  // as an ordinary region, so holes, winding and seams are handled by code that
  // already works. When nothing is accepted the map is unchanged and the output
  // is byte-for-byte the flat tracer's.
  let gradientPaints: Map<number, GradientPaint> | null = null;
  if (o.gradients) {
    const g = detectGradients(img, classes, palette, alphaLevels, levelCount, width, height, {
      gradients: o.gradients,
      gradientMinArea: o.gradientMinArea,
      gradientStepMax: o.gradientStepMax,
      gradientMargin: o.gradientMargin,
      gradientMaxError: o.gradientMaxError,
      gradientStops: o.gradientStops,
    });
    classes = g.classes;
    gradientPaints = g.paints.size > 0 ? g.paints : null;
  }

  // --- Segment, optionally removing specks. ---
  let comps: ComponentMap = connectedComponents(classes, width, height, -1);
  let despeckled = 0;
  if (o.minArea > 1) {
    // Two passes: absorbing one speck can leave its neighbour below threshold.
    for (let pass = 0; pass < 2; pass++) {
      const merged = despeckle(classes, comps, width, height, o.minArea, -1);
      if (merged === 0) break;
      despeckled += merged;
      comps = connectedComponents(classes, width, height, -1);
    }
  }

  const loopsByComponent = traceComponents(comps.labels, width, height, comps.count, o.turnPolicy);

  // --- Group components by class so one path serves each colour. ---
  const classArea = new Map<number, number>();
  const classComponents = new Map<number, number[]>();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    classArea.set(cls, (classArea.get(cls) ?? 0) + comps.areas[c]);
    let list = classComponents.get(cls);
    if (!list) { list = []; classComponents.set(cls, list); }
    list.push(c);
  }

  // Largest class first, so fine detail is drawn over broad fields of colour.
  const orderedClasses = [...classArea.keys()].sort(
    (a, b) => (classArea.get(b) ?? 0) - (classArea.get(a) ?? 0) || a - b,
  );

  const doc = new SvgDoc({
    width,
    height,
    generator: o.generator,
    title: o.title,
  });

  // A background rectangle is only sound when nothing is transparent; otherwise
  // it would paint over regions that must stay clear. A gradient region is never
  // collapsed to a flat rectangle — that would throw away the ramp — so a
  // synthetic gradient class is disqualified as the background.
  const backgroundClass =
    o.background && !hasVoid && orderedClasses.length > 1 && orderedClasses[0] < GRAD_BASE
      ? orderedClasses[0] : -1;
  if (backgroundClass >= 0) {
    const bg = classColor(backgroundClass, palette, alphaLevels, levelCount);
    if (o.groupByColor) {
      doc.addLayer(`${shortHex(bg.r, bg.g, bg.b)} (background)`, 'layer-background',
        `<path d="M0 0h${width}v${height}H0z"${fillAttrs(bg)}/>`);
    } else {
      doc.addBackground(bg);
    }
  }

  const fitOpts: FitOptions = {
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    polygonOnly: o.polygonOnly,
    optimize: o.optimize,
    optimizeError: o.optimizeError,
    rightAngleEnhance: o.rightAngleEnhance,
    rightAngleThreshold: o.rightAngleThreshold,
  };

  // A same-colour stroke of a pixel or so overpaints the hairline seam that can
  // appear between two abutting regions when a renderer antialiases their shared
  // edge. Emitted per path in the path's own fill colour.
  const strokeFor = (svgColor: string): string =>
    o.strokeWidth > 0 ? ` stroke="${svgColor}" stroke-width="${o.strokeWidth}"` : '';

  let regions = 0;

  for (const cls of orderedClasses) {
    const components = classComponents.get(cls)!;
    regions += components.length;
    if (cls === backgroundClass) continue;

    const path = new PathBuilder(o.precision);
    for (const c of components) {
      for (const loop of loopsByComponent[c]) {
        const fitted = fitLoop(loop.pts, fitOpts);
        if (!fitted) continue;
        path.moveTo(fitted.start.x, fitted.start.y);
        for (const seg of fitted.segments) {
          if (seg.kind === 'line') path.lineTo(seg.x, seg.y);
          else path.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
        }
        path.close();
      }
    }

    if (path.isEmpty()) continue;

    // Build the path markup, then either drop it straight in or wrap it in a
    // named layer. An accepted gradient region paints with its `<linearGradient>`
    // (registered once here, the only time its class is emitted) instead of a
    // flat fill.
    let markup: string;
    let label: string;
    const paint = gradientPaints?.get(cls);
    if (paint) {
      doc.addDef(paint.def);
      const op = paint.alpha < 1 ? ` fill-opacity="${+paint.alpha.toFixed(3)}"` : '';
      markup = `<path fill-rule="evenodd" d="${path.toString()}" fill="${paint.ref}"${op}/>`;
      label = paint.ref.replace(/^url\(#/, '').replace(/\)$/, '');
    } else {
      const color = classColor(cls, palette, alphaLevels, levelCount);
      const stroke = strokeFor(shortHex(color.r, color.g, color.b));
      markup = `<path fill-rule="evenodd" d="${path.toString()}"${fillAttrs(color)}${stroke}/>`;
      // Include the alpha in the label when it is below opaque, so one colour at
      // two alpha levels does not produce two indistinguishable separations.
      label = color.a < 255 ? `${shortHex(color.r, color.g, color.b)}@${color.a}` : shortHex(color.r, color.g, color.b);
    }

    if (o.groupByColor) {
      // Key the id off the class, which is unique, so the document never carries
      // two `<g>`s with the same id (invalid SVG) when colours repeat across alpha.
      doc.addLayer(label, `layer-${cls}`, markup);
    } else {
      doc.add(markup);
    }
  }

  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: classArea.size,
    regions,
    despeckled,
  };
}

/** One standalone SVG carrying a single colour, for print/vinyl separations. */
export interface Separation {
  /** The layer's colour label (short hex, or the background note). */
  color: string;
  /** A self-contained SVG document with only this colour's geometry. */
  svg: string;
}

/**
 * Trace to one standalone SVG per colour — what a screen-print, vinyl (Cricut/
 * Silhouette) or DTF workflow needs, where every colour is a separate physical
 * screen or cut layer. Runs the layered tracer once and splits its layers into
 * self-contained files, so it costs no more than a normal trace.
 */
export function traceSeparations(source: RasterImage, opts: TraceOptions = {}): Separation[] {
  const { svg } = trace(source, { ...opts, groupByColor: true });
  const open = svg.match(/<svg [^>]*>/)?.[0] ?? '<svg xmlns="http://www.w3.org/2000/svg">';
  const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? '';
  const out: Separation[] = [];
  const re = /<g inkscape:groupmode="layer" inkscape:label="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    out.push({ color: m[1], svg: `${open}${defs}${m[2]}</svg>\n` });
  }
  return out;
}

function classColor(
  cls: number,
  palette: { rgb: Uint8Array },
  alphaLevels: Uint8Array,
  levelCount: number,
): Rgba {
  const colorIdx = Math.floor(cls / levelCount);
  const alphaIdx = cls % levelCount;
  return {
    r: palette.rgb[colorIdx * 3],
    g: palette.rgb[colorIdx * 3 + 1],
    b: palette.rgb[colorIdx * 3 + 2],
    a: alphaLevels[alphaIdx],
  };
}

/** Index of the closest available alpha level. Levels are sorted ascending. */
function nearestLevel(levels: Uint8Array, value: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i] - value);
    if (d < bestD) { bestD = d; best = i; }
    else if (d > bestD) break; // sorted, so the distance only grows from here
  }
  return best;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
