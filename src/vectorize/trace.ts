import { SvgDoc, fillAttrs, strokeAttrs } from '../svg/build.js';
import { shortHex } from '../color.js';
import { PathBuilder } from '../svg/path.js';
import { selectiveBlur } from '../preprocess.js';
import { assertRasterImage, type RasterImage, type Rgba } from '../types.js';
import { adaptiveMinArea, connectedComponents, despeckle, type ComponentMap, type SpeckleScope } from './components.js';
import { traceComponents, type TurnPolicy, type Loop, type LoopBudgetGuard } from './contour.js';
import { fitLoop, type FitOptions } from './fit.js';
import { refineLoop } from './subpixel.js';
import { flattenToSegments } from './merge.js';
import { smoothPreservingEdges } from './smooth.js';
import { NearestColor, quantize, quantizeAlpha, type FillStrategy } from './quantize.js';
import { applyThreshold } from './threshold.js';
import { detectGradients, GRAD_BASE, type GradientPaint } from './gradient.js';
import { detectPrimitive, primitiveSvg } from './primitives.js';

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
  /**
   * Distinct partial-alpha levels to preserve between fully transparent and
   * fully opaque. `1` collapses partial transparency to opaque, but fully
   * transparent pixels are always kept as their own level, so an image with a
   * transparent background still traces on transparency rather than being
   * flattened onto black.
   */
  alphaLevels?: number;
  /** Regions smaller than this many pixels are absorbed into their neighbours. */
  minArea?: number;
  /**
   * Which small regions {@link minArea} may absorb.  (default) takes every
   * one under the cutoff.  takes only those surrounded by a single
   * class — specks floating inside a uniform field — and spares the ones sitting
   * between two regions, which are antialiasing fringe carrying the sub-pixel
   * position of an edge.
   */
  speckleScope?: SpeckleScope;
  /** Douglas–Peucker tolerance in pixels for the structural outline. */
  tolerance?: number;
  /** Maximum Bézier fitting error in pixels. */
  fitError?: number;
  /** Turn angle in degrees above which a vertex becomes a sharp corner. */
  cornerAngle?: number;
  /** Skip curve fitting and emit polygons. */
  polygonOnly?: boolean;
  /**
   * Recognise circles, ellipses, rectangles and sectors, and emit them as
   * `<circle>`, `<ellipse>`, `<rect>` and a `<path>` of true SVG arc commands —
   * smaller, editable as real shapes, and the source of arcs for CAD/DXF export.
   * A sector covers both a pie slice and a donut segment, which is what turns a
   * chart's several hundred Bézier anchors into a handful of arcs. Off by
   * default.
   *
   * A loop is only replaced when the whole of its boundary lies within
   * {@link primitiveError} px of the fitted shape, so the substitution is
   * render-preserving. Loops are judged one at a time, so a colour used by both
   * a slice and its legend swatch still becomes an arc and a rectangle.
   */
  primitives?: boolean;
  /** Residual budget for {@link primitives}, in pixels. Default 1.0. */
  primitiveError?: number;
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
   * Segment the image and flatten each region to its own colour before tracing.
   *
   * The tracer's usual order is quantise, then label connected components — so
   * every pixel that lands in a different palette bin from its neighbours becomes
   * its own region. On a compressed source that is thousands of one-pixel
   * regions, and no later merge recovers a boundary the palette misplaced.
   *
   * This inverts the order. Regions are found on the pixel grid, where each edge
   * weight is a real colour difference, and the palette is then applied to areas
   * that are already whole. Measured on a 100x100 JPEG sticker at a matched
   * region count, against the despeckle-based approach it replaces: SSIM 0.4557
   * -> 0.8329, where a paid competitor scores 0.8500.
   *
   * The value is the merge tolerance in Oklab — a one-pixel region may cross this
   * much colour distance, a hundred-pixel region only a hundredth of it. Useful
   * range is roughly 0.02 to 0.2. 0 (default) skips it.
   */
  segment?: number;
  /** Regions smaller than this are absorbed after {@link segment}. Default 8. */
  segmentMinRegion?: number;
  /**
   * Flatten interiors before quantising, without averaging across a boundary.
   *
   * Perona-Malik diffusion, in [0, 1]. 0 (default) skips it. Strength is scaled by
   * the image's OWN measured interior noise, so a clean logo is barely touched
   * while a compressed JPEG is smoothed hard — the two cases want opposite
   * treatment and a constant serves neither. See `smooth.ts` for the five-subject
   * table this is calibrated against, and for what it explicitly does not do.
   */
  smooth?: number;
  /**
   * Smooth each traced boundary before fitting, inside the pixel grid's own
   * uncertainty. Number of passes; 0 (default) skips it.
   *
   * Distinct from {@link smooth}, and the pair is easy to confuse: `smooth` changes
   * which pixels belong to which region, this changes only where the boundary
   * between them is drawn. A staircase is not evidence of a staircase — it is the
   * grid's way of saying "somewhere within half a pixel of here".
   */
  regularise?: number;
  /** How far a boundary vertex may move from the lattice. Default 0.75px. */
  regulariseBand?: number;
  /**
   * Simplify boundaries with a quantisation-aware straightness test instead of
   * Douglas–Peucker.
   *
   * Defaults to on wherever it is valid — that is, whenever the boundary is
   * still on the pixel lattice (no sub-pixel refinement), the caller has not
   * asked for the lattice verbatim (`tolerance: 0`), and `extendUnder` is off.
   * Exposed because it changes what "the same trace" means: comparing two
   * configurations is only meaningful if both use the same simplifier, and a
   * caller isolating some *other* option needs to be able to pin this one.
   */
  latticeSimplify?: boolean;
  /** Straightness band for {@link latticeSimplify}, in pixels. Default 0.75. */
  latticeBand?: number;
  /**
   * Reduce to two colours by a luminance cutoff before tracing — potrace's mode,
   * for scanned line art and black-on-white logos. A number is a fixed 0–255
   * cutoff; `'auto'` uses Otsu's method. Omitted skips it.
   */
  threshold?: number | 'auto';
  /** With {@link threshold}: dark pixels are the shape on a light ground. Default true. */
  blackOnWhite?: boolean;
  /**
   * Threshold against each pixel's own neighbourhood rather than one cutoff for
   * the whole frame. The fix for a photograph of paper, where one corner is in
   * shadow and no global cutoff can serve both ends of the page.
   */
  adaptive?: boolean;
  /** Neighbourhood side for {@link adaptive}; 0 (default) = an eighth of the shorter side. */
  adaptiveWindow?: number;
  /** Percent below the local mean that counts as ink for {@link adaptive}. Default 15. */
  adaptiveT?: number;
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
  /**
   * Absolute RMS-Oklab ceiling for acceptance. Default 0.015.
   *
   * This is the real quality guarantee. It used to be 0.1, which was effectively
   * inert: the old flat comparison rejected almost everything before the ceiling
   * was ever consulted. Now that the comparison is size-aware (see the gate in
   * `gradient.ts`), the ceiling is what separates a ramp the model genuinely fits
   * from a region that merely got coalesced — so it has to be a real limit.
   * Measured across the corpus: 0.015 keeps every photograph at its previous
   * banding and SSIM, while still admitting the flat-art ramps the old gate
   * wrongly refused.
   */
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
   * Extend each region's fill *under* the regions painted after it, instead of
   * cutting at their shared edge. No antialiasing seam can open at a join that no
   * longer exists, and this is the only mechanism here that actually removes one.
   *
   * **Measured, and the price is much higher than this once claimed.** Two things
   * the earlier docstring said are wrong:
   *
   * - "Render-identical" holds *only at integer magnification*. At 4.000x it is
   *   bit-identical to a plain trace — 0 differing subpixel channels out of
   *   4,194,304 on every corpus shape — because traced coordinates all sit on the
   *   pixel lattice and nothing is antialiased. At 3.902x it is **0.96 dB worse**
   *   on real artwork.
   * - "A shared boundary is traced once rather than twice" is not true in
   *   aggregate. `extendedLoops` masks every class ranked at or after this one, so
   *   the union's boundary is a new and generally longer curve: **3.97x the
   *   anchors** (25,410 -> 100,784) and 3.75x the bytes on the real corpus.
   *
   * Its cost is a range across artwork classes, never one number: -0.03 dB to
   * -0.96 dB, 1.8x to 4.0x anchors. Off by default, and it should stay off unless
   * seam-free output is an explicit requirement — seams are worth only 0.11-0.17 dB
   * of a ~1.4 dB deficit, so paying 4x the geometry to remove them loses.
   *
   * **A planar map is not the cheaper alternative.** One was built and measured: it
   * removes **0 of 31,036** seam pixels. Painter's-algorithm compositing gives
   * whatever lies beneath a join a weight of a(1-a) <= 0.25 regardless of geometry,
   * so two faces whose shared edge is written with character-identical coordinates
   * still leak. Geometric agreement is not what a seam is made of; only overlap
   * (this option) or a renderer with analytic coverage removes one.
   *
   * Also incompatible with {@link subpixel} — see there.
   */
  extendUnder?: boolean;
  /**
   * Move each boundary vertex to where the anti-aliasing says the edge actually
   * fell, before simplification and curve fitting.
   *
   * Crack following can only put vertices on integer lattice points, so a traced
   * outline is a staircase whose every turn is 90°. That is what stops the curve
   * fitter from ever running: a vertex 0.707px off its chord survives any
   * sub-pixel tolerance, and a 90° turn reads as a hard corner, so every span is
   * two points and every fit degrades to a line. Coverage in the boundary pixels
   * says where the edge really was — see `subpixel.ts` — and recovers it to
   * ~0.002px on a synthetic ramp.
   *
   * **On by default**, paired with `precision: 1` — and measurement says it must
   * never be enabled *alone*.
   * On 25 real logos, turning it on and changing nothing else costs **3.29x the
   * gzipped bytes** — worse than its 2.05x raw cost, because it is the integer
   * lattice that compresses: integer coordinates fall from 100% to 18% and the
   * gzip ratio with them, 5.69x to 3.55x. It buys +3.01 dB of edge accuracy and
   * the first curves the default path has ever emitted, but 3.3x the bandwidth
   * for every user is not a default.
   *
   * **It is affordable in company, and that is the part worth knowing.** The
   * `logo` preset runs it and comes out *smaller* than the plain default —
   * 0.68x gzipped, with real curves, at -0.13 dB — because it pairs subpixel
   * with `precision: 1` and `minArea: 8`. Halving the digits attacks exactly the
   * cost subpixel creates, and dropping specks cuts the anchors that carry it.
   * A tolerance sweep alone does not do it: at `minArea: 0, precision: 2`,
   * raising tolerance to 0.6/0.8/1.2 alongside subpixel makes gzipped size
   * *worse* (211 -> 249 -> 258 -> 257 KB) while accuracy falls (10.92 -> 10.55
   * -> 10.24 -> 10.21 dB). Tolerance was the obvious lever and it is the wrong
   * one.
   *
   * So: never enable this by itself expecting a win. The default pairs it with
   * `precision: 1`, which brings the gzipped cost to 2.35x — the price of the
   * first curves this tracer has ever emitted by default. Turn it off with
   * `--no-subpixel` for the old lattice output at a third of the bytes.
   *
   * It cannot change hard-edged output at all: with no anti-aliasing the
   * displacement is exactly zero, so pixel art and sprites are byte-identical
   * either way.
   *
   * Cannot be combined with `extendUnder`, and the combination is now an error
   * rather than a silent downgrade: those loops bound a *union* of classes rather
   * than one class's own pixels, so "inside" cannot be decided from the class map.
   * Asking for both used to return output byte-identical to asking for neither.
   */
  subpixel?: boolean;
  /**
   * Emit one named `<g>` per colour, tagged as an Inkscape/Illustrator layer, so
   * the SVG opens as editable colour layers (weeding/separation-ready) instead
   * of one flattened blob. Off by default.
   */
  groupByColor?: boolean;
  title?: string;
  generator?: string;
  /**
   * Called as each stage begins, with a name and a percentage.
   *
   * The percentage describes position in the *stage list*, not work completed,
   * and the names say which stage — because a bar that invents a countdown is
   * worse than one that names the step. Tracing is a single synchronous call
   * that cannot be subdivided, so this fires at boundaries and nowhere else.
   *
   * It exists so every surface reports the same stages instead of six of them
   * inventing their own vocabulary, or — as the CLI, the playground and the MCP
   * server all did — saying nothing at all for several seconds.
   */
  onProgress?: (stage: string, pct: number) => void;
  /**
   * Asked once, before the boundary loops are built, whether the host can
   * afford them — see {@link LoopBudgetGuard}.
   *
   * Without one, an image too large for the machine ends the process with a raw
   * V8 heap dump and exit 134, discarding everything and saying nothing. The
   * node build supplies a guard by default; a caller can pass its own or `null`
   * to opt out.
   */
  loopBudget?: LoopBudgetGuard;
  /**
   * Abandon the trace at the next stage boundary.
   *
   * Checked between stages rather than inside them, for the same reason: the
   * stages are synchronous. That is enough for the case that matters — a user
   * dragging a slider supersedes a run that is now pointless, and without this
   * the superseded work still runs to completion and the new one queues behind
   * it.
   */
  signal?: { readonly aborted: boolean };
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
  speckleScope: 'all' as SpeckleScope,
  // 0.4, not 1.0. A measured diagnosis (scripts/diagnose-photo.mjs) found the
  // curve fitter, not quantisation, is the dominant loss on photographs — 0.11
  // to 0.24 SSIM — and that a 1px tolerance is *strictly worse* than 0.4 on
  // both accuracy and file size across flat art, logos and photos. The old
  // default's curves drifted up to a pixel and flipped boundary pixels while
  // producing *larger* files than a tighter fit. The one thing a large
  // tolerance buys — few smooth curves on a big arc — is preserved by the
  // `logo`/`lineart` presets, which keep a higher value on purpose.
  //
  // **0.4 is the top of a flat dead zone, not an optimum, and it is kept anyway.**
  // A 131-setting sweep found that every tolerance in (0, 0.44] produces
  // *byte-identical* output — same sha256, 34,084 B, 12,603 segments, zero curves —
  // and that `cornerAngle` and `fitError` are unreachable there: all six
  // cornerAngle values from 45 to 135 give the same sha at tolerance 0.4, and the
  // instrumented fitter shows why. Every one of 12,879 loops takes the
  // `fitterIsDead` shortcut, Douglas-Peucker removes 0.0% of 63,338 lattice
  // points, and `findBreakpoints` is called **zero** times.
  //
  // Raising it to 0.45 wakes the fitter and is worse on both axes at once:
  // -0.03 dB and +44% bytes (68,328 -> 98,189 on the real corpus). Accuracy then
  // falls monotonically to 2.0 while bytes keep climbing to 137,278, because
  // curves cost more characters than the `h`/`v` shorthand they replace.
  //
  // The real reason to keep 0.4 is the one that is easy to miss: it is the only
  // setting where **100% of emitted path coordinates stay integers**. That is what
  // buys the `h`/`v` shorthand, and integers gzip about 5.8x against 2.7x for
  // fractionals — so the lattice is not a limitation being tolerated here, it is
  // load-bearing for file size.
  //
  // THAT PARAGRAPH USED TO END "anything that moves coordinates off it (see
  // `subpixel`) should be opt-in or preset-scoped, and is." That stopped being
  // true when `subpixel` became the default, and the correction is more
  // interesting than the error.
  //
  // Forcing `subpixel: true` really does move coordinates off the lattice, and the
  // dead zone above really does stop describing that path:
  //
  //                    subpixel forced ON        subpixel OFF
  //   logo-tux         73.5% integer, 2,982 cv   100%, 12 cv
  //   vector-tiger     73.2% integer, 23,455 cv  100%, 110 cv
  //   the sticker      62.1% integer, 2,150 cv   100%, 21 cv
  //
  // But that is NOT what ships, because `refineGateFor` (api.ts) turns `subpixel`
  // off wherever measured `interiorNoise` exceeds 0.3 — and every one of those
  // four subjects exceeds it: 0.653, 0.456, 0.796, 5.061. So the shipped default
  // emits 100% integers on all of them, and the dead-zone reasoning still holds
  // for the path users actually get.
  //
  // Worth knowing WHY they all exceed it, because it is not what the limit was
  // calibrated for. On synthetics the measure is clean — flat two-tone 0.0000, a
  // smooth gradient 0.1886, a steep gradient 0.2222, per-pixel grain 4.4445 — so
  // it is not confusing shading with noise. Real artwork reads high because busy
  // pictures have few genuinely interior pixels: the samples that survive the
  // gradient filter still sit beside sub-threshold edges. The limit therefore acts
  // as "is this picture detailed" at least as much as "is this picture noisy".
  //
  // `logo` and `lineart` state `subpixel: true` themselves and are spread after
  // the gate, so they still get refinement. That is the intended escape hatch and
  // it is the one measured to pay: +1.84 dB at -21.2% segments on `logo`.
  tolerance: 0.4,
  fitError: 0.4,
  cornerAngle: 75,
  polygonOnly: false,
  primitives: false,
  primitiveError: 1.0,
  optimize: true,
  // 1, not 2. Sub-pixel refinement moves coordinates off the integer lattice,
  // and it is the lattice that compresses — measured on 25 real logos, turning
  // subpixel on drops integer coordinates from 100% to 18% and the gzip ratio
  // from 5.69x to 3.55x. Halving the digits attacks exactly that cost: 3.29x
  // gzipped becomes 2.35x. Nothing is lost at this precision that the eye or
  // the edge metric can find, because the refinement's own accuracy is ~0.1px.
  //
  // Only `trace` reads this. `pixel` and `exact` build with `new PathBuilder(0)`
  // and are unaffected, so bit-exact output stays bit-exact.
  precision: 1,
  background: true,
  refineIterations: 4,
  strokeWidth: 0,
  // On by default at 0.02, which is the value the two failure modes agree on.
  //
  // It was off while the runt-absorption pass absorbed every small region, which
  // cost logo-tux 0.9884 -> 0.9570 SSIM and visibly eroded its silhouette. Once
  // absorption was restricted to runts that are INSIDE a region rather than on a
  // boundary between two — grain, not anti-aliasing fringe — the cost collapsed:
  //
  //   logo-tux   0.9884 -> 0.9731   17.6 KB -> 14.4 KB
  //   sticker    0.9620 -> 0.9556   11.1 KB -> 9.9 KB
  //
  // 0.015 and 0.006 of SSIM for 18% and 11% of the bytes, and the segmentation is
  // what lets the lattice simplifier run at all on a noisy source, because it
  // establishes the precondition rather than merely passing a test for it.
  // OFF by default, tried twice and rejected twice on measurement.
  //
  // It is a genuine win on some content and a loss on other content, and the
  // published photo row is the case that decides it. On a REAL photograph
  // (photo-cat) it takes 27% off the bytes for 0.97 dB. On the synthetic
  // `photoLike` fixture the published table uses, it is worse on BOTH axes —
  // 49.3 -> 52.6 KB and 31.31 -> 28.82 dB — so it cannot be a default without
  // regressing a published number in the wrong direction.
  //
  // Worth keeping the disagreement rather than picking the flattering half: a
  // synthetic photograph and a real one rank this differently, which is the same
  // trap `bench-scale.mjs` records for preset ranking. The real-photograph result
  // is the more trustworthy one; the published table is the one users read.
  //
  // What it does when asked for, against no segmentation:
  //
  //   logo-tux    41.83 dB / 17.7 KB   (base 42.05 / 17.6)  — free
  //   photo-cat   33.89 dB /  462 KB   (base 34.86 /  636)  — 27% smaller
  //   sticker      30.41 dB / 10.0 KB   (base 30.57 / 11.1)  — 10% smaller
  segment: 0,
  smooth: 0,
  regularise: 0,
  // 0, not 8. The runt-absorption pass is a SIZE threshold, and every measurement
  // in this module says size is the wrong criterion — it was the dominant cost
  // here, not the merge policy it sits beside.
  //
  // Swept on three sources, against no segmentation at all:
  //
  //              mr=0                     mr=8
  //   logo-tux   41.83 dB / 17.7 KB       41.01 dB / 14.4 KB   (base 42.05 / 17.6)
  //   photo-cat  33.89 dB / 462 KB        33.86 dB / 444 KB    (base 34.86 / 636)
  //   sticker     30.41 dB / 10.0 KB       30.37 dB / 9.9 KB   (base 30.57 / 11.1)
  //
  // At 0 the merge alone still takes 27% off a photograph and leaves logo-tux
  // essentially untouched. Raising it buys a further 3-4% of bytes and costs
  // logo-tux 0.8 dB, which is the whole silhouette-erosion failure in one line.
  segmentMinRegion: 0,
  extendUnder: false,
  // On by default as of the curves change. Everything about why this is
  // affordable — and why it is NOT affordable alone — is on the `subpixel`
  // option above. Short version: with `precision: 1` beside it the gzipped cost
  // is 2.35x, against 3.29x on its own, and it is the only thing that makes the
  // curve fitter run. Without it the default emits zero curve commands on real
  // artwork, which is a bitmap in an SVG wrapper.
  subpixel: true,
  groupByColor: false,
  turnPolicy: 'left',
  gradients: false,
  gradientMinArea: 0,
  gradientStepMax: 0.08,
  gradientMargin: 0.1,
  gradientMaxError: 0.015,
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
  // Floored at 2, which is the smallest value `despeckle` acts on at all — it
  // early-returns at `minArea <= 1`. Without the floor this returns 0 for
  // anything under ~158x158 and 1 up to ~256x256, so small images got no
  // cleanup whatsoever, and small images are exactly where stray pixels
  // dominate. Measured on a 100x100 JPEG: 4,438 disjoint regions at 0 against
  // 1,019 at 2, with gzipped size halved (11.1 -> 5.9 KB).
  //
  // The note above records "172x178 JPEG -> 0 (despeckling here costs 0.087
  // SSIM; skip it)". That figure is real and it is the wrong instrument: 1x
  // SSIM against the source rewards reproducing the source's noise, which is
  // precisely what these one-pixel islands are. On the structural measure —
  // does the output still carry detail where the original does — minArea 2
  // holds 98%, against a 90% floor. It is 88% at 4 and 73% at 8, which is why
  // the floor is 2 and not higher.
  //
  // REACHABILITY, stated because the floor above is easy to over-read: this
  // function only runs when `minArea` arrives `undefined`, and `api.ts` spreads
  // `TRACE_DEFAULTS` — which pins `minArea: 0` — over every `vectorize()` call.
  // So through the public API this adaptive rule never fires, and the floor
  // added here changes nothing for CLI or library callers. It applies to direct
  // `trace()` calls only. Pinning `minArea: 0` was a deliberate decision and is
  // not overturned here.
  //
  // Worth measuring before that is revisited: the two known data points point
  // in OPPOSITE directions to this rule. A 100x100 image wants 2 (regions
  // 4,438 -> 1,019 at 98% detail) where the rule gives 0; a 24 MP photograph
  // was measured to prefer 0 where the rule gives 16. If that holds across
  // sizes, the scaling is inverted and the fix is not a floor.
  return Math.max(2, Math.min(16, Math.round(pixels / 50_000)));
}

export function trace(source: RasterImage, opts: TraceOptions = {}): TraceOutput {
  assertRasterImage(source, 'trace');
  const clean = stripUndefined(opts);
  const o = {
    ...TRACE_DEFAULTS,
    minArea: autoMinArea(source.width * source.height),
    ...clean,
  };

  // Refused rather than silently downgraded.
  //
  // `extendUnder` replaces each class's loops with a union's boundary, and
  // sub-pixel refinement needs to know which class is inside — which the class
  // map cannot answer for a union. So the two genuinely cannot be combined. The
  // code handled that by quietly skipping refinement, which meant asking for both
  // returned output byte-identical to asking for neither: measured at 1.36 dB
  // worse on real artwork with all 2,121 curves discarded, and no indication that
  // the option had been ignored.
  //
  // This project's own convention, set when `-m embed -l` stopped silently
  // picking a winner, is that an impossible combination is rejected with an
  // explanation. Both options landed off by default, so nothing can depend on the
  // old behaviour.
  // Zero tolerance is a request for the lattice itself, and sub-pixel placement
  // is the one thing that cannot honour it. `trace(src, { tolerance: 0,
  // polygonOnly: true })` is documented as bit-exact — the vertices land on
  // pixel corners, so re-rasterising reproduces the source exactly — and moving
  // them off the lattice breaks that guarantee outright. Caught by
  // `vectorize.test.ts` the moment subpixel became a default, which is the test
  // earning its keep: nothing else in the suite states that contract.
  if (o.tolerance === 0) o.subpixel = false;

  if (o.subpixel && o.extendUnder) {
    // `extendUnder` wins, and this is no longer an error.
    //
    // It was one while both options were opt-in: asking for two incompatible
    // things deserved an explanation rather than a silent downgrade. That
    // premise died when `subpixel` became a default — `--extend-under` on its
    // own would now throw, blaming the user for a combination they never asked
    // for. `extendUnder` is still always explicit, so it is the one to honour.
    //
    // Not silent: the caller gets `subpixel: false` back in the resolved
    // options, and the trade is documented on both fields. The reason they
    // cannot coexist is unchanged — extendUnder's loops bound a *union* of
    // classes, so "inside" cannot be decided from the class map, which is
    // exactly what coverage refinement needs.
    o.subpixel = false;
  }

  // Progress and cancellation share one helper so a stage cannot report itself
  // without also being a place the caller can bail out. `aborted` is thrown as
  // a plain Error rather than returning a partial result: half a trace is not a
  // smaller trace, it is a wrong one.
  const report = (stage: string, pct: number): void => {
    if (o.signal?.aborted) throw new Error('Trace aborted.');
    o.onProgress?.(stage, pct);
  };

  // --- Preprocess before the tracer ever sees the pixels. ---
  //
  // Order matters: blur removes grain first, then threshold (if requested)
  // collapses to two colours. A blur after thresholding would just soften the
  // clean edge the threshold produced.
  report('Preparing', 2);
  let img = source;
  if (o.blur && o.blur >= 1) {
    img = selectiveBlur(img, { radius: o.blur, delta: o.blurDelta });
  }
  // Ahead of segmentation and quantisation both: flattening interiors first means
  // the region finder meets gradients that have already collapsed, and the palette
  // is not spent on compression noise. See `smooth.ts`.
  if (o.smooth && o.smooth > 0) {
    img = smoothPreservingEdges(img, o.smooth);
  }
  // Before quantisation, deliberately: the whole point is that the palette meets
  // regions that are already coherent. See `segment` on TraceOptions.
  if (o.segment && o.segment > 0) {
    img = flattenToSegments(img, o.segment, o.segmentMinRegion);
  }
  if (opts.threshold !== undefined) {
    img = applyThreshold(img, {
      threshold: o.threshold, blackOnWhite: o.blackOnWhite,
      adaptive: o.adaptive, adaptiveWindow: o.adaptiveWindow, adaptiveT: o.adaptiveT,
    }).image;
  }

  const { width, height } = img;
  const n = width * height;

  // --- Quantise colour and alpha independently. ---
  report('Quantising colour', 10);
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
  report('Finding regions', 40);
  let comps: ComponentMap = connectedComponents(classes, width, height, -1);
  let despeckled = 0;

  // With no explicit `minArea`, pick one from the components actually found.
  // The old default was derived from pixel count alone and could not see that
  // an antialiased logo had shattered into hundreds of edge slivers.
  if (opts.minArea === undefined) {
    o.minArea = Math.max(o.minArea, adaptiveMinArea(comps, width * height));
  }

  if (o.minArea > 1) {
    // Two passes: absorbing one speck can leave its neighbour below threshold.
    for (let pass = 0; pass < 2; pass++) {
      const merged = despeckle(classes, comps, width, height, o.minArea, -1, o.speckleScope);
      if (merged === 0) break;
      despeckled += merged;
      comps = connectedComponents(classes, width, height, -1);
    }
  }

  report('Tracing contours', 55);
  const loopsByComponent = traceComponents(comps.labels, width, height, comps.count, o.turnPolicy, o.loopBudget);
  /** Shared empty stand-in, so releasing a consumed entry allocates nothing. */
  const EMPTY_LOOPS: Loop[] = [];

  /**
   * Trace a class as if it extended *under* everything painted after it.
   *
   * Regions are painted largest-first, so by the time a small region is drawn,
   * the large one beneath it has already been laid down. That means a region's
   * mask does not have to stop at a shared edge: it can run on underneath, and
   * the render is unchanged because the later region repaints those pixels.
   *
   * Two things follow. A boundary shared by two regions is currently traced
   * twice — once as each one's edge — and here it is traced once, by whichever
   * is painted later. And the hairline seam that antialiasing leaves between two
   * abutting shapes cannot appear, because there is no longer a join to leave a
   * gap at; `strokeWidth` exists to paint over exactly that seam.
   *
   * The mask is every pixel whose class is painted at this rank or later, so it
   * is a union, and the loops come from one relabelled pass over it.
   */
  const extendedLoops = (rank: number, rankOfClass: Int32Array): Loop[] => {
    const mask = new Int32Array(width * height).fill(-1);
    for (let p = 0; p < mask.length; p++) {
      const comp = comps.labels[p]!;
      if (comp < 0) continue; // void stays void: transparency must not be filled
      const cls = comps.classes[comp]!;
      if (cls >= 0 && rankOfClass[cls]! >= rank) mask[p] = 0;
    }
    // One label, so every disconnected piece and every hole comes back in a
    // single group — which is what a class's path wants anyway.
    return traceComponents(mask, width, height, 1, o.turnPolicy)[0] ?? [];
  };

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
    // Sub-pixel refinement moves vertices off the grid; without it every
    // boundary vertex is a lattice point and Douglas-Peucker is the wrong tool.
    //
    // Excluded at tolerance 0, which is a request for the lattice itself. This
    // simplifier has no tolerance to honour — its band is the grid's own
    // uncertainty — so it collapses staircases whatever the caller asked for,
    // and `trace(src, { tolerance: 0, polygonOnly: true })` is documented
    // bit-exact. Caught by the suite immediately, which is that test earning its
    // keep for the second time this week.
    //
    // Also excluded under `extendUnder`, and for the structural reason rather
    // than a measured one. That option's whole purpose is that a shared boundary
    // is traced identically from both sides, so no seam can appear. Any
    // simplification applied to each side independently breaks that — the union
    // loop and the class loop beneath it collapse different staircases and stop
    // meeting. Douglas-Peucker only preserved it by removing nothing at the
    // shipped tolerance; the guarantee was resting on the fitter being dead.
    // Measured when this was missed: SSIM 0.9895 against a required 0.9999.
    latticeSimplify: opts.latticeSimplify ?? (!o.subpixel && !o.extendUnder && o.tolerance > 0),
    latticeBand: opts.latticeBand,
    regularise: o.regularise,
    regulariseBand: o.regulariseBand,
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
  // edge. Emitted per path in the path's own fill colour — and at the path's own
  // alpha, since `fill-opacity` does not apply to strokes.
  const strokeFor = (c: Rgba): string => strokeAttrs(c, o.strokeWidth);

  let regions = 0;

  // Rank per class, for the extend-under mask. Built once; a class not present
  // ranks last, which keeps it out of every union.
  let rankOfClass: Int32Array | null = null;
  if (o.extendUnder) {
    let maxClass = 0;
    for (const c of orderedClasses) if (c > maxClass) maxClass = c;
    rankOfClass = new Int32Array(maxClass + 1).fill(orderedClasses.length);
    orderedClasses.forEach((c, i) => { rankOfClass![c] = i; });
  }

  for (const [rank, cls] of orderedClasses.entries()) {
    const components = classComponents.get(cls)!;
    regions += components.length;
    if (cls === backgroundClass) continue;

    const classLoops: Loop[] = [];
    // Extend-under replaces this class's own loops with the union's loops; the
    // background class is skipped above, and a gradient class keeps its own
    // geometry because its paint is not flat.
    const ownLoops = rankOfClass && cls < GRAD_BASE
      ? [extendedLoops(rank, rankOfClass)]
      : components.map((c) => loopsByComponent[c]!);
    for (const group of ownLoops) for (const loop of group) classLoops.push(loop);

    // Release each component's loops as soon as they have been copied out.
    //
    // `traceComponents` builds every loop for every component before this loop
    // starts, and a component belongs to exactly one class, so each entry here
    // is read exactly once and nothing later in this function touches
    // `loopsByComponent` again. Holding all of them for the whole run is pure
    // retention: on a 24 MP photograph it is gigabytes still reachable while
    // the fitter allocates on top of it.
    for (const c of components) loopsByComponent[c] = EMPTY_LOOPS;

    // A region that *is* a circle/ellipse/rectangle/sector emits the true
    // primitive instead of a Bézier outline — smaller, editable as a shape, and
    // the arc source for DXF. Only a class whose every loop is a solid outer
    // boundary is eligible: a loop that encloses a hole must keep its path, or
    // the primitive would paint the hole in.
    //
    // Per loop, not per class. A colour that appears twice — a pie slice and its
    // legend swatch, the commonest thing in a real chart — would otherwise
    // disqualify both, which is exactly how a fitter can pass every synthetic
    // fixture and then never fire on a real chart.
    const eligible = o.primitives && classLoops.length > 0
      && classLoops.every((l) => l.signedArea > 0);
    const prims = classLoops.map((l) =>
      eligible ? detectPrimitive(l.pts, { maxError: o.primitiveError }) : null);

    const path = new PathBuilder(o.precision);
    for (const [i, loop] of classLoops.entries()) {
      if (prims[i]) continue; // emitted as its own element below
      // `!rankOfClass` is belt-and-braces: the subpixel + extendUnder combination
      // is refused above, so this can only be false when subpixel is off anyway.
      // It stays because the two conditions are independent and a future caller of
      // extendedLoops should not silently start refining a union boundary.
      const refined = o.subpixel && !rankOfClass
        ? refineLoop(loop, img, classes, cls).pts
        : loop.pts;
      const fitted = fitLoop(refined, fitOpts);
      if (!fitted) continue;
      path.moveTo(fitted.start.x, fitted.start.y);
      for (const seg of fitted.segments) {
        if (seg.kind === 'line') path.lineTo(seg.x, seg.y);
        else path.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
      }
      path.close();
    }

    const primCount = prims.reduce((k, p) => k + (p ? 1 : 0), 0);
    if (path.isEmpty() && primCount === 0) continue;

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
      const stroke = strokeFor(color);
      const attrs = `${fillAttrs(color)}${stroke}`;
      // Recognised loops become true shapes; whatever is left of the class stays
      // one shared evenodd path, exactly as before.
      const shapes = prims
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => primitiveSvg(p, attrs, o.precision))
        .join('');
      markup = path.isEmpty()
        ? shapes
        : `${shapes}<path fill-rule="evenodd" d="${path.toString()}"${attrs}/>`;
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
