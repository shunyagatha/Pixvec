import { SvgDoc, fillAttrs, strokeAttrs } from '../svg/build.js';
import { shortHex } from '../color.js';
import { PathBuilder } from '../svg/path.js';
import { selectiveBlur } from '../preprocess.js';
import { assertRasterImage, type RasterImage, type Rgba } from '../types.js';
import { adaptiveMinArea, connectedComponents, despeckle, type ComponentMap, type SpeckleScope } from './components.js';
import { traceComponents, type TurnPolicy, type Loop, type LoopBudgetGuard } from './contour.js';
import { fitLoop, flattenPath, type FitOptions, type FittedPath } from './fit.js';
import { refineLoop } from './subpixel.js';
import { refineSourceFor } from './refine-source.js';
import { despikeRinging } from './despike.js';
import { flattenToSegments } from './merge.js';
import { smoothPreservingEdges } from './smooth.js';
import { regulariseAgreeing } from './junctions.js';
import { decomposeToArcs, fitFaces, type Arc } from './arcs.js';
import { NearestColor, quantize, quantizeAlpha, collapseFringeAlpha, type FillStrategy } from './quantize.js';
import { applyThreshold } from './threshold.js';
import { detectGradients, GRAD_BASE, type GradientPaint } from './gradient.js';
import { detectPrimitive, primitiveSvg } from './primitives.js';
import { classAdjacency, clipPathDef, interpolationLayer } from './interpolate.js';

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
  /**
   * Smallest extent, in pixels, a region may have and still be promoted to a
   * primitive. Default 12.
   *
   * Not a recognisability floor — a 4px disc is perfectly recognisable. It is a
   * BYTE floor, and it exists because promotion is not free: a primitive leaves
   * the class's shared `<path>` and becomes its own element, repeating
   * `fill`/`fill-opacity`/`stroke`/`stroke-width` — 60 to 110 bytes — where
   * inside the path it cost only its `d`. Below roughly this size the element
   * costs more than the geometry it replaced.
   *
   * Measured over the nine-subject corpus at `clean`: with no floor, promotion
   * fires 41 times on alpha-dice and 118 on photo-jpeg-artifacts, every one of
   * them a speck of radius 1.3-3.6 px, and the corpus grows 0.19% while SSIM
   * falls on six subjects. At 12 the corpus SHRINKS 0.10%, seven of nine
   * subjects come back byte-identical, and a chart of real primitives keeps
   * every promotion it had (13 on the dashboard fixture, -23.3% bytes).
   */
  primitiveMinExtent?: number;
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
   * Correct a resize/sharpening Gibbs-ringing overshoot in the raw source —
   * a pixel whose value lies past a true plateau on either side of it, on a
   * short antialiasing ramp — before classification (`collapseFringeAlpha`,
   * `quantize`, `connectedComponents`, the contour itself) ever sees the
   * raster. See `despike.ts` for the exact, narrowly-gated signature this
   * targets and the measurements behind each threshold: every gate is a
   * precondition evaluated on the untouched source, so a pixel this cannot
   * confidently identify as the specific overshoot signature is left
   * byte-identical. Off by default, opt-in — validated on a 9-subject corpus
   * plus the target defect image with zero interior-leak or topology
   * regressions and no corner-rounding, but not yet exercised on a wide
   * enough corpus to default it on for every caller.
   */
  despike?: boolean;
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
   * Trace shared boundaries once and let both neighbours reference the result,
   * instead of giving each region a private copy of every edge it shares.
   *
   * This is what makes curve fitting safe on a mosaic. The fitter is not
   * reversal-symmetric — the same run of points fitted backwards comes out as a
   * different NUMBER of curves, up to 2.94px away — so two faces fitting their own
   * copies of one boundary tear apart along it. Fitting each arc once removes that
   * possibility rather than bounding it. See `arcs.ts`.
   *
   * Implies junction retention in the contour walk, and supersedes `regularise`,
   * whose per-loop smoothing this does per-arc with the endpoints pinned. It also
   * raises `regularise` to at least 2, because an untouched lattice boundary
   * cannot leave the Douglas-Peucker dead zone and the mosaic would emit polygons
   * under a curve fitter's name.
   */
  mosaic?: boolean;
  /**
   * Write a quadratic (`q`) instead of a cubic (`c`) wherever one describes the
   * same span within the error budget the cubic already had to pass. Off by
   * default.
   *
   * Four numbers against six, and on a traced boundary most cubics are barely
   * cubic — measured over the corpus at `--preset clean`, 44.7% of the 116,983
   * emitted cubics sit within 0.1px of their best quadratic. It is a pure
   * serialisation change: no boundary moves, no region is added or removed, and
   * every replacement is checked against the ORIGINAL traced points rather than
   * against the cubic it replaces. See `reduceToQuadratics` in fit.ts for why
   * that distinction is the whole of the correctness argument.
   */
  quadratics?: boolean;
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
   * Borrowed from imagetracerjs as a way to hide the hairline gap between two
   * abutting colour regions, and described that way here for years with no number
   * attached to it. It has now been measured, and it is better and worse than the
   * description suggested.
   *
   * BETTER: it is an accuracy gain, not merely a cosmetic patch. SSIM delta
   * against the same configuration at 0, on the `logo` preset:
   *
   *   subject          sw0.25   sw0.5   sw0.75    sw1   sw1.5
   *   logo-tux         +0.025  +0.043  +0.054  +0.054  +0.029
   *   alpha-dice       +0.026  +0.031  +0.023  +0.012  -0.007
   *   vector-tiger     +0.015  +0.027  +0.034  +0.030  -0.009
   *   photo-parrots    +0.015  +0.021  +0.020  +0.016  -0.003
   *   photo-cat        +0.051  +0.085  +0.099  +0.102  +0.089
   *   a JPEG sticker   +0.016  +0.021  +0.016  +0.005  -0.046
   *
   * Positive on 6 of 6 at 0.5, for 1.001x-1.028x raw bytes. The mechanism is that
   * it repaints the region's own colour over the half-covered pixels along its
   * boundary, which is where a fill-only mosaic loses coverage.
   *
   * WORSE: it paints OUTSIDE THE SILHOUETTE. On logo-tux it colours 831 pixels the
   * source says are fully transparent, against 156 without it, with alpha reaching
   * 183. Composited over white that is invisible — which is exactly why the SSIM
   * above improves — and over anything dark it is a halo. That is why no preset
   * turns it on, despite the table.
   *
   * AND IT DOES NOT SCALE THE WAY YOU WOULD GUESS. The payoff tracks how much of
   * the picture IS boundary, so a single antialiased disc contradicts every row
   * above: 0.9791 / 0.9798 / 0.9736 / 0.9618 / 0.9462 across the same sweep,
   * peaking at 0.25 and negative by 0.5. Do not tune this on a simple figure.
   *
   * WHAT DECIDES IT: whether the geometry is ON THE LATTICE. That was missing from
   * every version of this note above, and it reconciles them.
   *
   * A polygon traced from crack-following has integer coordinates, so at integer
   * magnification a join antialiases to nothing and there is no gap to fill — the
   * stroke can only fatten the shape, which is why this measured NEGATIVE on 26 of
   * 32 subjects as a global default. Curved output does not land on the lattice, so
   * joins really do leave a hairline, and the stroke really does repaint it.
   *
   * Rendered with nothing painted beneath, so a seam shows rather than blending
   * into a backing rect, `mosaic` leaks these pixels at 2.7x magnification:
   *
   *   logo-tux       943 -> 66      alpha-dice   32 -> 0      photo-parrots 284 -> 0
   *
   * for 1.9% more bytes and +0.0405 SSIM on logo-tux. `clean` therefore ships it on
   * and nothing else does. On a noisy JPEG it still loses — photo-jpeg-artifacts
   * goes 0.5597 -> 0.5363 — because there the boundary is noise and thickening
   * noise is not an improvement.
   *
   * 0 (default) emits fill-only paths. 0.5 is the value the corpus supports where
   * the artwork is opaque and lattice-aligned; 1 is what curved output wants.
   */
  strokeWidth?: number;
  /**
   * Reconstruct the antialiased blend along every boundary between two colour
   * classes — the information a partition of flat fills cannot carry.
   *
   * Where two regions meet, the source raster has a one- or two-pixel ramp
   * between their colours and a flat partition has a step. This paints the mean
   * of the two fills into that band, UNDER the fills, so it is visible only at
   * their antialiased fringe.
   *
   * It reconstructs the RAMP. It does NOT close the interior alpha hairline that
   * opens where two abutting antialiased fills fail to cover their shared pixel —
   * measured, it lands level with the 0.5 stroke it suppresses and leaves the
   * worst pixel on logo-tux fully transparent. See the alpha-deficit table under
   * `interpolate` in the `clean` preset note in api.ts.
   *
   * IT CARRIES NO COORDINATES. Each class already emits one path; this gives it
   * an id, `<use>`s it for the fill, and paints each adjacent pair's band by
   * stroking one class's outline clipped to the other's territory. The cost is
   * the number of adjacent class PAIRS, not the number of boundary arcs — 41 to
   * 653 against 256 to 12,473 on the corpus. See `interpolate.ts` for the shape
   * and for what it gives up against one stroked path per arc.
   *
   * Measured at `clean` over the nine-subject corpus, against the same document
   * with neither this nor {@link strokeWidth} — dSSIM at 1x through resvg, and
   * gzipped bytes relative to that same fills-only document. The right-hand pair
   * is one open stroked path per interior arc, grouped by blend colour, which is
   * the mechanism the paid rival ships and the one this replaces:
   *
   *                        this pass      one path per arc   arcs / class pairs
   *   logo-tux             +0.0502 1.12x  +0.0630 1.37x         416 /  76
   *   alpha-dice           +0.0287 1.11x  +0.0170 1.73x       3,868 / 653
   *   photo-jpeg-source    +0.0026 1.11x  +0.0034 1.52x         256 /  41
   *   photo-parrots        +0.0096 1.03x  +0.0098 1.67x       1,878 /  99
   *   photo-portrait       +0.0144 1.03x  +0.0145 1.64x       1,878 / 106
   *   photo-lighthouse     +0.0065 1.02x  +0.0065 1.73x       5,878 / 105
   *   photo-jpeg-artifacts +0.0078 1.05x  +0.0077 1.78x       3,098 / 119
   *   photo-cat            +0.0422 1.01x  +0.0454 1.59x       5,435 /  77
   *   photo-motorcycles    +0.0063 1.01x  +0.0064 1.84x      12,473 / 119
   *   mean                 +0.0187 1.06x  +0.0193 1.65x
   *
   * 97% of the accuracy for 8% of the extra bytes. Only logo-tux, the flattest and
   * highest-contrast subject, prefers the arcs by a real margin.
   *
   * That table survives the #101 metric fix — re-derived on the corrected gate it
   * reads +0.0496 / +0.0286 / +0.0027 / +0.0094 / +0.0139 / +0.0063 / +0.0075 /
   * +0.0414 / +0.0066 in the same order, mean +0.0184 against +0.0187.
   *
   * IT IS OFF EVERYWHERE, `clean` INCLUDED, AND THE REASON IS NOT THIS TABLE.
   * Against a bare document the pass wins on 9 of 9. Against what `clean` actually
   * ships — the same document with `strokeWidth: 0.5`, which this pass suppresses —
   * it is worth a mean +0.0025 over nine subjects and HARMS four of them, because
   * the stroke is already collecting a mean +0.0159 of the same thing for a
   * twentieth of the bytes. It also costs the most (1.11x-1.14x gzip) on exactly
   * the flat art the preset targets. The full four-corner table, the render
   * observations and the alpha-deficit numbers are in the `clean` note in api.ts;
   * read them before proposing this as a default again.
   *
   * It suppresses {@link strokeWidth}: the same-colour stroke repaints, in one
   * flat colour, the band this has just filled with the interpolated one. With the
   * pass on, `strokeWidth` therefore has NO effect whatever — the documents are
   * byte-identical on all nine subjects — which is why an on/off comparison of
   * this option is confounded unless the stroke-0 corner is measured too.
   */
  interpolate?: boolean;
  /**
   * Band width for {@link interpolate}, in user units. Defaults to 1.5, or 1
   * where the image carries translucent pixels.
   *
   * 1.5 is the corpus optimum on 6 of 9 subjects; alpha-dice, photo-jpeg-artifacts
   * and photo-motorcycles prefer 1. The alpha case is compositing algebra rather
   * than a per-subject fit — under a fill of alpha `a` the band contributes with
   * weight `(1 - a)` across its whole width instead of hiding beneath — so that
   * one is a rule; the other two are the ordinary spread of a corpus, and the
   * default costs them 0.0008 and 0.0031.
   */
  interpolateWidth?: number;
  /**
   * Paint the opaque silhouette once, underneath everything, so an interior seam
   * cannot be see-through.
   *
   * THE DEFECT. Two abutting fills are rasterised as two elements, so at their
   * shared edge each covers a fraction `c` and `1 - c` of the pixel and
   * source-over leaves `1 - c + c^2` — 0.75 at `c = 0.5`, never 1 except at the
   * ends. Where a background rectangle lies beneath (any artwork with no
   * transparency) nobody sees it. Where the artwork HAS transparency there is no
   * rectangle, so pixels the source calls fully opaque render see-through, in a
   * network tracing every interior boundary. Counted on `clean` — a pixel the
   * SOURCE calls fully opaque that renders below alpha 250, of which the INTERIOR
   * ones are more than a step from the silhouette so the artwork's own edge
   * cannot explain them:
   *
   *   logo-tux    3,621 leaks / 3,171 interior     ->    319 / 0
   *   alpha-dice  1,350 leaks /   725 interior     ->    243 / 16
   *   paid rival  387 / 17 and 567 / 213           (we now beat it on both)
   *
   * The seven opaque corpus subjects are at 0 before and after; the rival leaks
   * 163-1,146 on them, because it paints no background rectangle.
   *
   * WHY IT IS ONE PATH AND NOT A CLIP. Subpaths of a SINGLE path element do not
   * composite against each other — the rasteriser resolves the whole path to one
   * coverage value per pixel — so a path holding every opaque class's subpaths
   * has no interior seams at all. A clip cannot do this: a `<clipPath>` is
   * rasterised into a mask by the same source-over arithmetic, so a mask built
   * from abutting shapes carries the identical deficit and multiplying an opaque
   * band by a 0.75 mask gives 0.75. {@link interpolate}, which clips one class's
   * outline to its neighbour, removes 844 of logo-tux's 3,171 interior leaks and
   * 2 of alpha-dice's 725 — it reconstructs the colour ramp, which is a different
   * job, and its own docstring should not be read as claiming this one.
   *
   * WHY THE UNION IS EXACT. Each class path is `fill-rule="evenodd"` and the
   * classes are disjoint, so for any point the crossing parity of the
   * concatenation is the sum, mod 2, of the per-class parities — which is 1
   * exactly inside an opaque class and 0 everywhere else, holes and nesting
   * included. The underpaint therefore cannot extend one sub-pixel beyond the
   * fills it sits under: it is their outline, not an approximation of it, so it
   * cannot halo. A union re-traced from the class map could not promise that.
   *
   * WHAT IT COSTS. The `d` data is repeated, and gzip eats the repeat only while
   * the document fits its 32K window: logo-tux x1.040 gzipped but x1.93 RAW,
   * alpha-dice x1.121 gzipped and x1.115 raw. Quote both — an editor holds the
   * raw file.
   *
   * WHAT SCALE IT MATTERS AT, which is not the one you would check. A
   * `strokeWidth` of 0.5 user units is 2 device pixels at 4x and covers the seam
   * there, so the defect LOOKS absent under magnification and is at its worst at
   * 1x-2x, where artwork is actually read: 3,171 interior leaks at 1x, 7,733 at
   * 1.37x, 0 at 3.902x. Measured at non-integer scales on purpose — an integer
   * scale puts every lattice edge on a pixel boundary and antialiases nothing.
   * With the stroke removed the seam is there at every scale (6,597 interior at
   * 3.902x), which is what says it is geometry and not a sampling accident.
   *
   * ONLY WHERE IT IS NEEDED. Refused unless the image has transparent pixels,
   * because otherwise the background rectangle already does this job for nothing
   * — so on the seven opaque corpus subjects the document is byte-identical.
   * Refused under {@link groupByColor} (a separation must stand alone) and under
   * {@link extendUnder} (which removes the seam by overlapping instead).
   * Translucent classes are excluded, and that exclusion is measured rather than
   * assumed: including them takes alpha-dice's leaks to 19 and its SSIM from
   * 0.9233 to 0.8936, for 73% more gzip, because an opaque silhouette under a
   * translucent region shows through and repaints it. Fewer leaks and a worse
   * picture is the shape of a metric being gamed, so the count is not the only
   * thing this is allowed to optimise. The 16 interior leaks left on alpha-dice
   * are opaque pixels bordering a translucent class, which is exactly the case
   * this refuses to reach.
   *
   * On by default in `clean` and off everywhere else. Composes with
   * {@link interpolate} — it sits below that layer and neither suppresses the
   * other — but the two are not additive on the defect: the blend removes none
   * of it, so the underpaint does the same work either way.
   */
  underpaint?: boolean;
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
   * Cannot be combined with `extendUnder`: those loops bound a *union* of classes
   * rather than one class's own pixels, so "inside" cannot be decided from the
   * class map. `extendUnder` wins, and the trace returns a note saying so — this
   * used to claim the combination was "an error", which it has not been since
   * `subpixel` became a default and throwing would have blamed a caller who never
   * asked for it. Asking for both used to return output byte-identical to asking
   * for neither, with nothing said at all.
   *
   * Superseded the same way, and for a longer time without a word, by
   * {@link regularise} and {@link mosaic} — see the note block in `trace`.
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
   * Emit `width`/`height` on the root `<svg>`, in addition to `viewBox`. On by
   * default, for compatibility with tools that size an inserted vector from
   * its own intrinsic attributes rather than its container.
   *
   * The cost of leaving it on: a browser opening the file directly with no
   * surrounding page renders it at that literal pixel size — for a real
   * photograph that is routinely bigger than the viewport, so the file needs
   * zooming out to see at all, even though the geometry inside is exactly as
   * resolution-independent either way. `viewBox` alone is enough for any
   * consumer that sizes the element itself (an `<img>` under `width:100%`,
   * an `<svg>` inline in a page, this project's own Studio), and lets a
   * standalone file scale to fit its viewer the way `viewBox`-only markup
   * does. Set `false` for that behaviour.
   */
  emitDimensions?: boolean;
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
  /**
   * What the resolver decided on the caller's behalf, in sentences.
   *
   * This exists because the alternative kept being chosen by accident. Two
   * options in this file supersede `subpixel`, which is a DEFAULT — so a caller
   * who asks for one of them and nothing else has refinement removed without ever
   * having mentioned it. Before this channel there was nowhere to say so:
   * `TraceOutput` carried no options back, so the older claim that a downgrade was
   * "not silent, the caller gets `subpixel: false` back in the resolved options"
   * described a return value that did not exist.
   *
   * `vectorize` forwards these into `VectorizeResult.notes`, which the CLI prints.
   */
  notes: string[];
}

export const TRACE_DEFAULTS = {
  colors: 16,
  alphaLevels: 8,
  // Opt-in, not on by default: proven to resolve the diagnosed Gibbs-ringing
  // staircase defect with zero interior-leak/topology regressions on the
  // 9-subject corpus, but that corpus is not wide enough on its own to make
  // this the default for every caller. See `despike.ts` and the `despike`
  // option's own doc comment.
  despike: false,
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
  // **0.4 is inside a flat dead zone, not an optimum, and it is kept anyway.**
  // A 131-setting sweep found that every tolerance in the zone produces
  // *byte-identical* output — same sha256, 34,084 B, 12,603 segments, zero curves —
  // and that `cornerAngle` and `fitError` are unreachable there: all six
  // cornerAngle values from 45 to 135 give the same sha at tolerance 0.4, and the
  // instrumented fitter shows why. Every one of 12,879 loops takes the
  // `fitterIsDead` shortcut, Douglas-Peucker removes 0.0% of 63,338 lattice
  // points, and `findBreakpoints` is called **zero** times.
  //
  // THE ZONE'S TOP IS NOT 0.44. That was this comment rounding a measurement off,
  // and the real bound is arithmetic rather than empirical: crack-following emits
  // axis-aligned unit steps, so an interior lattice vertex that is not collinear
  // with the chord is |cross| / |chord| away from it with an integer numerator,
  // and the smallest such distance a collinear-collapsed run can produce is over
  // the chord (2, 1) — 1 / sqrt(5) = 0.4472135954999579. `douglasPeucker` keeps a
  // vertex on `dist > tolerance`, so 1/sqrt(5) is itself the first LIVE tolerance
  // and everything strictly below it is dead. The zone is (0, 1/sqrt(5)).
  //
  // Swept on the 4,025 real lattice loops of logo-tux at 16 colours, with
  // `latticeSimplify` off so Douglas-Peucker is the only simplifier:
  //
  //   tolerance                                curves    lines
  //   0.001 … 0.44721359549995787 (1 ulp below)     0   21,093
  //   0.4472135954999579  (= 1/sqrt(5))         3,697   17,263
  //   0.5                                       4,182   16,770
  //
  // One ulp is the whole cliff. 0.4 is not sitting near an edge, it is sitting
  // 0.047 below one — which is why every value from 0.001 to 0.44 is the same
  // file, and why raising the default to 0.45 rather than 0.4472136 was never the
  // meaningful part of the change.
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
  primitiveMinExtent: 12,
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
  // Off everywhere, `clean` included, and re-confirmed after `clean`'s stroke
  // moved from 1 to 0.5. Against a document with no seam paint at all it is worth
  // +0.0184 mean SSIM for +5.5% gzip and wins on 9 of 9 subjects. Against what
  // `clean` actually ships — the same document with the 0.5 stroke this pass
  // SUPPRESSES — it is worth +0.0025 mean and HARMS 4 of 9, because the stroke is
  // already collecting +0.0159 of the same thing for a twentieth of the bytes.
  // The four-corner table, the blur floor and the render notes are in api.ts.
  interpolate: false,
  // OFF here and ON in `clean`, which is the only preset that meets its
  // precondition — artwork with transparency, where no background rectangle
  // exists to hide an interior seam. It is a no-op on opaque input, so the
  // default costs nothing to leave off; see the option's own note.
  underpaint: false,
  // OFF by default, tried twice and rejected twice on measurement.
  //
  // A second block used to sit above this one opening "On by default at 0.02",
  // with its own table of runt-absorption figures. It never described shipped
  // behaviour: `segment` was introduced at 0 (#85) and has never held another
  // value here — `git log -S` finds no commit that set it otherwise. Two adjacent
  // comments disagreeing about a default is worse than either alone, so the one
  // the code contradicts is gone. 0.02 is what the `clean` preset asks for, and
  // that is where the case for it belongs.
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
  mosaic: false,
  quadratics: false,
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

  /** Downgrades the caller did not ask for, reported rather than left to be found. */
  const notes: string[] = [];

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
    notes.push(
      'Sub-pixel refinement was turned off because --extend-under was requested: ' +
        'those loops bound a union of colour classes, so "inside" cannot be decided ' +
        'from the class map, which is what refinement needs.',
    );
  }

  // BOTH SHARED-BOUNDARY PATHS SUPERSEDE `subpixel`, and neither used to say so.
  //
  // This is the same defect class as the `extendUnder` clash above — a silent
  // downgrade of a default — and it was harder to see, because the decision is not
  // made here. It emerges 300 lines below at `const refined =`, where
  // `sharedGeometry` wins the `??`. Measured on logo-tux, with `latticeSimplify`
  // pinned so only refinement varies, `subpixel` on and off give the SAME sha256
  // at `regularise` 2 and at 4, while at `regularise: 0` they differ by 81,097
  // against 27,473 bytes. The flag stops meaning anything, silently.
  //
  //  - Under `regularise > 0` the refinement never runs at all: `shared ?? …`
  //    short-circuits, so `refineLoop` is called 509 times at the default and 0
  //    times at `regularise: 2`.
  //  - Under `mosaic` it runs and is thrown away, because every face is assembled
  //    from arcs that were already fitted once — 166 calls on logo-tux under
  //    `--preset clean`, about 23 ms of a 277 ms trace, for output byte-identical
  //    to the same run with `subpixel: false`.
  //
  // A note rather than a throw, and rather than forcing `subpixel: false`:
  //
  //  - Throwing would blame a caller who only ever typed `--regularise 2`, since
  //    `subpixel` is on by default. That is exactly the argument that turned the
  //    `extendUnder` clash above from an error into a downgrade.
  //  - Clearing the flag would not be neutral either: `latticeSimplify` defaults
  //    to `!o.subpixel`, so setting it false here silently switches the lattice
  //    simplifier ON, taking `regularise: 2` on logo-tux from 52,295 to 60,031
  //    bytes. A message that changed the output would be a worse fix than the
  //    silence it replaces.
  //
  // So the geometry is untouched and the consequence is stated.
  if (o.subpixel && ((o.regularise ?? 0) > 0 || o.mosaic === true)) {
    const cause = o.mosaic === true
      ? 'the `mosaic` option, which --preset clean turns on, fits each shared boundary '
        + 'once and assembles every face from those arcs'
      : 'the `regularise` option smooths each shared boundary once with junctions pinned';
    notes.push(
      `Sub-pixel refinement had no effect on this trace: ${cause}, and that shared ` +
        'geometry replaces the refined vertices for every loop. The output is ' +
        'byte-identical with subpixel off; refinement applies only where each region ' +
        'is fitted from its own copy of the boundary.',
    );
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
  // Ahead of EVERYTHING, including collapseFringeAlpha: a resize/sharpening
  // Gibbs-ringing overshoot is a property of the raw raster itself, not of
  // any decision this pipeline makes about it, so classification should see
  // the corrected pixels — not just refinement, which is all `refine-source.ts`
  // downstream of this can reach. Surgical by construction: see despike.ts's
  // own doc comment for the gates that keep it from ever touching real
  // antialiasing, thin strokes, or unrelated edges. Opt-in (see the
  // `despike` option's own doc comment for why it defaults off).
  if (o.despike) img = despikeRinging(img);
  // Ahead of everything else, deliberately: collapsing antialiasing-ramp
  // fringe alpha levels into their nearest real neighbour before blur/smooth/
  // segment ever see the image means those passes shape the corrected ramp,
  // not the original one. Doing this later, at classification time, measured
  // as a regression on genuine translucency — see collapseFringeAlpha's own
  // doc comment for why order matters here.
  img = collapseFringeAlpha(img, Math.max(1, o.alphaLevels));
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

  // A denoised copy of `img`, read ONLY by the sub-pixel coverage sampling in
  // `refineLoop`/`refineOpenArc` below — never by classification, and never by
  // anything above this point. See `refine-source.ts` for why: a resized/
  // compressed source can have pixel-level noise (sharpening ringing, JPEG
  // blocking) riding on top of a genuine antialiasing ramp, and reading that
  // noise as if it were signal is what defeats simplification even after
  // coverage refinement runs. Computed only when something below will actually
  // read it — `refineLoop` behind `o.subpixel`, `refineOpenArc` (via
  // `mosaicFitBase.image`) whenever mosaic assembly runs regardless of
  // `subpixel`, matching the note above about sub-pixel refinement paths that
  // supersede the flag — and band-limited to `comps.labels`' FINAL boundaries
  // (after despeckling), so the filter never runs on a component that
  // despeckling is about to erase.
  const needsRefineSource = o.subpixel === true || o.mosaic === true;
  const refineSource = needsRefineSource ? refineSourceFor(img, comps.labels) : img;

  report('Tracing contours', 55);
  // `regularise` needs junctions to survive the collinear collapse, or two runs
  // either side of one merge and stop matching what the neighbour sees.
  const shareBoundaries = (o.regularise ?? 0) > 0;
  const mosaic = o.mosaic === true;
  const loopsByComponent = traceComponents(
    comps.labels, width, height, comps.count, o.turnPolicy, o.loopBudget,
    shareBoundaries || mosaic,
  );
  // Smooth each shared boundary ONCE, before anything reads a loop's shape.
  // Independent per-loop smoothing moves two neighbours' copies of the same edge
  // apart and the background shows through; see arcs.ts.
  const sharedGeometry = shareBoundaries
    ? regulariseAgreeing(
        loopsByComponent, comps.labels, width, height,
        o.regularise ?? 0, o.regulariseBand ?? 0.75,
      )
    : undefined;
  // Fit every shared boundary ONCE, then assemble each face from the results.
  // The alternative is each face fitting its own copy, which the reversal
  // measurement in arcs.ts rules out for anything that emits curves.
  //
  // The decomposition is built once and reused below for the underpaint's own,
  // separately-budgeted pass over the same arcs — arc topology does not depend
  // on the error budget, only refitting does.
  const mosaicDec = mosaic
    ? decomposeToArcs(loopsByComponent, comps.labels, width, height)
    : undefined;
  const mosaicFitBase = {
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    optimize: o.optimize,
    quadratics: o.quadratics,
    // Recover real sub-pixel edge evidence for open interior arcs before they
    // are fitted, so a shared boundary with nothing between its two junctions
    // is not forced to a straight line when the source image's antialiasing
    // says otherwise. See `refineOpenArc` in subpixel.ts. The denoised
    // measurement copy, not `img` itself — see `refine-source.ts`.
    image: refineSource,
    labels: comps.labels,
    // `mosaic` implies smoothing, and the floor is not a preference.
    //
    // Crack-following emits axis-aligned unit steps only, so an untouched
    // lattice vertex cannot deviate from a chord by less than 1/sqrt(5) =
    // 0.4472136 — above the 0.4 tolerance, so Douglas-Peucker removes nothing
    // and every arc comes out a polygon. Measured on logo-tux: 0 passes gives
    // 0 curves at 18,297 bytes; one pass gives 306 at 30,606.
    //
    // Two rather than one because the second is nearly free and the sweep
    // flattens immediately after: across passes 1 to 8 at bands 0.5, 0.75 and
    // 1.0, SSIM spans 0.8740 to 0.8804 and never orders them consistently.
    // A caller asking for more gets more.
    regularise: Math.max(o.regularise ?? 0, 2),
    regulariseBand: o.regulariseBand ?? 0.75,
  };
  // A vertex where 3 or more DISTINCT regions meet is a genuine multi-region
  // T-junction: two or more independently-fitted open arcs converge on one
  // shared, immovable endpoint. Each may fit well within its own budget, but
  // nothing else verifies that the UNION of their swept areas covers every
  // pixel touching the junction — when the true available area at a tight
  // pinch is only about a pixel wide, several near-budget curves can jointly
  // leave a hairline gap there even though none individually violates its own
  // budget. Confirmed on a synthetic tightly-packed-blobs fixture: the leaking
  // pixel's own corner is exactly such a vertex (crackDegree 3, 3 distinct
  // classes), and the leak is unaffected by the merge budget alone.
  //
  // This is not the same test as `crackDegree !== 2` (junctions.ts): a
  // same-pair checkerboard saddle also has crackDegree != 2 without being a
  // real third region, so distinctness is measured by CLASS (colour) here
  // instead of raw component id. Two same-coloured, unrelated components both
  // bordering void is common in any busy image and already shares one evenodd
  // path (built per class, not per component) — there is no cross-fill seam
  // between them to protect against. Raw-component-id distinctness flagged
  // essentially every open arc in a real mosaic as junction-touching, which
  // re-imposes the whole-document cost of tightening every arc's budget
  // through a side door.
  //
  // A translucent alpha-quantisation fringe class is folded into one shared
  // bucket rather than counted as its own distinct region: it shares the fill
  // colour of whichever opaque region it borders and is never itself something
  // a competing fill paints solidly, so it cannot be the third region a real
  // pinch needs.
  //
  // Outside the canvas frame shares void's own sentinel rather than getting a
  // distinct one: "nothing painted here" is the same fact on either side of
  // the border. Treating them as two different regions made every arc that
  // merely touches the image edge look like a hard junction — measured on the
  // mandated subjects, over 97% of open arcs on art that runs to the frame
  // edge — reproducing the same whole-document cost through a different door.
  const isOpaqueClass = (cls: number): boolean => alphaLevels[cls % levelCount] === 255;
  const hardJunctionVertex = (vx: number, vy: number): boolean => {
    const cell = (cx: number, cy: number): number => {
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return -1; // outside frame == void
      const comp = comps.labels[cy * width + cx]!;
      if (comp < 0) return -1; // void stays its own class
      const cls = comps.classes[comp]!;
      return isOpaqueClass(cls) ? cls : -2; // any translucent fringe, shared bucket
    };
    const tl = cell(vx - 1, vy - 1), tr = cell(vx, vy - 1);
    const bl = cell(vx - 1, vy), br = cell(vx, vy);
    return new Set([tl, tr, bl, br]).size >= 3;
  };
  // A closed arc (per `decomposeToArcs`) carries no junction at all — only an
  // open arc's two endpoints can be shared with a neighbour.
  const arcTouchesHardJunction = (arc: Arc): boolean => {
    if (arc.closed) return false;
    const n = arc.pts.length / 2;
    return hardJunctionVertex(arc.pts[0]!, arc.pts[1]!)
      || hardJunctionVertex(arc.pts[(n - 1) * 2]!, arc.pts[(n - 1) * 2 + 1]!);
  };
  const mosaicFaces = mosaicDec
    ? fitFaces(mosaicDec, {
        ...mosaicFitBase,
        optimizeError: o.optimizeError,
        // An arc touching a hard junction is fit at the un-widened `fitError`
        // instead of `optimizeError`: the merge pass's extra slack is exactly
        // what lets several near-budget arcs jointly leave a hairline gap at a
        // tight pinch. Every other arc — the overwhelming majority of any real
        // document — keeps the full widened budget.
        isJunctionArc: arcTouchesHardJunction,
        junctionOptimizeError: mosaicFitBase.fitError,
      })
    : undefined;
  // The visible fills' merge pass runs at `optimizeError` — `clean` widens
  // this to 0.75, a deliberate, measured byte saving (see that option's own
  // docstring) — but the underpaint silhouette must guarantee full coverage
  // underneath every neighbour's fill, and that widened slack is exactly what
  // can leave a gap the visible geometry itself never shows (its own neighbour
  // repaints over it). So underpaint gets its own fit of the same arcs, held
  // to the un-widened `fitError` every split already had to satisfy — one
  // extra `fitFaces` pass over the arcs already decomposed above, decoupling
  // "what geometry is cheapest to render" from "what geometry underpaint needs
  // to guarantee coverage".
  //
  // Measured directly at this budget (no further tightening beyond
  // `fitError`): two mandated subjects and two adversarial calligraphic-curl
  // fixtures all reach 0 interior leaks at both 1x and 3.902x scale, for 1/4
  // to 1/3 the byte cost of a tighter `fitError / 4` floor tried first and
  // found unnecessary once this pass and the junction fix above were both in
  // place.
  const underpaintEligible =
    mosaic && o.underpaint === true && hasVoid && !o.groupByColor && !o.extendUnder;
  const underMosaicFaces = underpaintEligible && mosaicDec
    ? fitFaces(mosaicDec, { ...mosaicFitBase, optimizeError: o.fitError })
    : undefined;

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

  // The interpolation pass reads the class grid and re-uses the class paths, so
  // it is refused where a class is not one flat path: `extendUnder` replaces a
  // class's geometry with a union that no longer follows its own boundary, and
  // `groupByColor` exists to be split into standalone separations, which a
  // document of cross-references cannot survive. Gradient and primitive classes
  // opt out individually below rather than disqualifying the whole document.
  const interpolate = o.interpolate === true && !o.extendUnder && !o.groupByColor;
  const doc = new SvgDoc({
    width,
    height,
    generator: o.generator,
    title: o.title,
    emitDimensions: o.emitDimensions,
    // Inherited, so one attribute serves every `<clipPath>` the pass adds; stating
    // it is not optional, because neither resvg nor librsvg falls back to the
    // referenced path's own `fill-rule` when clipping. Harmless when the pass
    // ends up adding no clip path at all — the property reaches nothing else.
    rootAttrs: interpolate ? ['clip-rule="evenodd"'] : undefined,
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

  // The opaque silhouette underpaint. Refused where a background rectangle
  // already covers every interior seam (no transparency), where the document is
  // split into standalone separations, and where `extendUnder` has removed the
  // seams by overlapping instead. See the option's note for the compositing
  // algebra and for why no clip-based variant can work.
  const underpaint = o.underpaint === true && hasVoid && !o.groupByColor && !o.extendUnder;
  // Below the interpolation layer as well as below every fill: the blend band is
  // meant to be seen in the gap, and painting the silhouette over it would hide
  // exactly what that layer emits. Both slots are claimed before the fills for
  // the same reason — the content is only known once the classes have emitted.
  const underSlot = underpaint ? doc.reserve() : -1;
  /** Each opaque class's `d`, concatenated into the one underpaint path. */
  const underParts: string[] = [];
  /** The largest opaque class's colour, which is the underpaint's fill. */
  let underFill: Rgba | null = null;

  // The interpolation layer belongs here — over the background rectangle, under
  // every fill — but its content is the set of classes that actually emitted a
  // referenceable path, which is only known once they have. Claim the position
  // now and supply the markup after the loop.
  const interpSlot = interpolate ? doc.reserve() : -1;
  const interpPathId = new Map<number, string>();

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
    // Always 0, and the `shareBoundaries ? 0 : o.regularise` that used to stand
    // here could not have been anything else. `shareBoundaries` is DEFINED as
    // `(o.regularise ?? 0) > 0`, so the true arm passed 0 and the false arm passed
    // a value that is 0 or less — and `regulariseClosed` returns immediately on
    // `passes <= 0`. Instrumented on logo-tux: across `regularise` 0, 2 and 6, all
    // 509 `fitLoop` calls arrive with `regularise: 0` and `regulariseClosed` is
    // entered 0 times. The branch was a decision the code had already made.
    //
    // The reason it is 0 is unchanged and still right: shared-boundary smoothing
    // already smoothed every run once with junctions pinned, and a second
    // closed-loop pass here would move those junctions and undo the agreement the
    // first pass exists to create.
    //
    // `regulariseClosed` is NOT dead code. `fitFaces` (arcs.ts) routes
    // junction-free closed arcs to it with at least 2 passes — 6 of them under
    // `--preset clean`, 17 at `regularise: 6` — it is simply not reachable from
    // this options object.
    regularise: 0,
    regulariseBand: o.regulariseBand,
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    polygonOnly: o.polygonOnly,
    optimize: o.optimize,
    optimizeError: o.optimizeError,
    quadratics: o.quadratics,
    rightAngleEnhance: o.rightAngleEnhance,
    rightAngleThreshold: o.rightAngleThreshold,
  };

  // The non-mosaic fallback of the tight underpaint-only fit: same as
  // `fitOpts` but never widened past `fitError`. See `underMosaicFaces` above
  // for the mosaic case, which is the one every leak this pass was validated
  // against actually takes.
  const underFitOpts: FitOptions = { ...fitOpts, optimizeError: o.fitError };

  // A same-colour stroke of a pixel or so overpaints the hairline seam that can
  // appear between two abutting regions when a renderer antialiases their shared
  // edge. Emitted per path in the path's own fill colour — and at the path's own
  // alpha, since `fill-opacity` does not apply to strokes.
  //
  // Suppressed under `interpolate`, and the two are not complementary: the
  // same-colour stroke repaints, in one flat colour, the very band the
  // interpolation layer has just filled with the blend. Measured on the corpus,
  // running both is worse than the interpolation alone on 7 of 9 subjects —
  // mean SSIM 0.7471 against 0.7606, and 0.8870 against 0.9182 on alpha-dice.
  //
  // THOSE FIGURES ARE AT `strokeWidth: 1`, which `clean` no longer ships, so the
  // rule was re-tested at 0.5 by env-gating this very line, measuring, and
  // reverting. It survives, less comfortably than the paragraph above claims.
  // Against the shipping fills-plus-stroke document, over nine subjects:
  //
  //   pass + stroke 0.5   mean +0.0012, harmed 3 of 9. logo-tux +0.0229 — the
  //                       best figure this project has on that subject — but
  //                       alpha-dice -0.0160 and motorcycles -0.0060.
  //   pass + stroke 1.0   mean -0.0111, harmed 7 of 9, worst -0.0337 (alpha-dice).
  //
  // So combining is still not a free win at either width and this line stands.
  //
  // NOTE FOR ANYONE CHANGING EITHER OPTION: this line is why a naive on/off
  // comparison of `interpolate` is confounded. With the pass on, `strokeWidth`
  // has no effect at all — the emitted documents are byte-identical on all nine
  // subjects — so "the blend helped" and "removing the stroke helped" are the
  // same measurement unless the stroke-0 corner is measured too. See the
  // four-corner table in the `clean` preset note in api.ts.
  const strokeFor = (c: Rgba): string => strokeAttrs(c, interpolate ? 0 : o.strokeWidth);

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

    // The geometry a loop finally becomes, computed once per loop.
    //
    // `!rankOfClass` is belt-and-braces: the subpixel + extendUnder combination
    // is refused above, so this can only be false when subpixel is off anyway.
    // It stays because the two conditions are independent and a future caller of
    // extendedLoops should not silently start refining a union boundary.
    // Shared-boundary geometry wins where it exists: it is the only version both
    // neighbours agree on, and the per-loop paths below cannot produce that.
    // Under `mosaic` the face was already assembled from arcs that were each
    // fitted once, so re-fitting here would throw away the agreement.
    const fitFor = (loop: Loop): FittedPath | null => {
      const shared = sharedGeometry?.get(loop);
      const refined = shared ?? (o.subpixel && !rankOfClass
        ? refineLoop(loop, refineSource, classes, cls).pts
        : loop.pts);
      return mosaicFaces?.get(loop) ?? fitLoop(refined, fitOpts);
    };

    // The same loop, refit at the tight underpaint budget instead of reusing
    // the visible fill's (possibly `optimizeError`-widened) geometry.
    // `refined`/`shared` are recomputed identically to `fitFor` — they do not
    // depend on the error budget, only the refit does.
    const underFitFor = (loop: Loop): FittedPath | null => {
      const shared = sharedGeometry?.get(loop);
      const refined = shared ?? (o.subpixel && !rankOfClass
        ? refineLoop(loop, refineSource, classes, cls).pts
        : loop.pts);
      return underMosaicFaces?.get(loop) ?? fitLoop(refined, underFitOpts);
    };

    // Ask the primitive fitters about the curve that will actually be EMITTED,
    // not about the lattice staircase behind it.
    //
    // Crack-following walks pixel corners, so a rasterised disc arrives as a
    // staircase whose worst vertex sits 1.16-1.44 px off the disc it came from —
    // above any residual budget that a false positive would also have to clear.
    // Judging the fitted path instead measures the substitution being proposed:
    // "how far is the curve I am about to write from this circle", which is the
    // question the trade actually turns on.
    //
    // Held in an array rather than recomputed because emission below needs the
    // same object; only built when primitives are on, so the default path keeps
    // fitting one loop at a time.
    const fittedByLoop: Array<FittedPath | null> = eligible ? classLoops.map(fitFor) : [];
    const prims = classLoops.map((l, i) => {
      if (!eligible) return null;
      const f = fittedByLoop[i];
      return detectPrimitive(f ? flattenPath(f) : l.pts, {
        maxError: o.primitiveError,
        minExtent: o.primitiveMinExtent,
      });
    });

    const path = new PathBuilder(o.precision);
    // The same non-primitive loops, refit tight, built in lockstep with
    // `path` — only actually populated (see the `underpaint` guard below) so
    // the extra fit cost is not paid on documents that never use it.
    const underPath = underpaintEligible ? new PathBuilder(o.precision) : null;
    const appendTo = (builder: PathBuilder, fitted: FittedPath): void => {
      builder.moveTo(fitted.start.x, fitted.start.y);
      for (const seg of fitted.segments) {
        if (seg.kind === 'line') builder.lineTo(seg.x, seg.y);
        else if (seg.kind === 'quad') builder.quadTo(seg.x1, seg.y1, seg.x, seg.y);
        else builder.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
      }
      builder.close();
    };
    for (const [i, loop] of classLoops.entries()) {
      if (prims[i]) continue; // emitted as its own element below
      const fitted = eligible ? fittedByLoop[i] : fitFor(loop);
      if (!fitted) continue;
      appendTo(path, fitted);
      if (underPath) {
        const underFitted = underFitFor(loop);
        if (underFitted) appendTo(underPath, underFitted);
      }
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
    // Collect this class's outline for the underpaint, opaque classes only. A
    // loop that left as a primitive is not in `path` and so takes no part; what
    // remains is still a disjoint subset of the opaque pixels, which is all the
    // parity argument needs.
    const collectUnder = (a: number): boolean => {
      if (!underpaint || a < 255 || path.isEmpty()) return false;
      // The tight-budget geometry when it exists (built in lockstep above,
      // non-empty whenever `path` is), the shared loose one otherwise —
      // unchanged fallback for anything `underpaintEligible` did not cover
      // (non-mosaic documents).
      underParts.push(underPath && !underPath.isEmpty() ? underPath.toString() : path.toString());
      return true;
    };
    if (paint) {
      collectUnder(Math.round(paint.alpha * 255));
      doc.addDef(paint.def);
      const op = paint.alpha < 1 ? ` fill-opacity="${+paint.alpha.toFixed(3)}"` : '';
      markup = `<path fill-rule="evenodd" d="${path.toString()}" fill="${paint.ref}"${op}/>`;
      label = paint.ref.replace(/^url\(#/, '').replace(/\)$/, '');
    } else {
      const color = classColor(cls, palette, alphaLevels, levelCount);
      // Classes arrive largest-first, so the first opaque contributor is the
      // largest one — the colour with most boundary to be seen against.
      if (collectUnder(color.a) && underFill === null) underFill = color;
      const stroke = strokeFor(color);
      const attrs = `${fillAttrs(color)}${stroke}`;
      // Recognised loops become true shapes; whatever is left of the class stays
      // one shared evenodd path, exactly as before.
      const shapes = prims
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => primitiveSvg(p, attrs, o.precision))
        .join('');
      // Under `interpolate` a class that is exactly one path keeps its geometry
      // where it was and merely gains an id, so the interpolation layer can
      // stroke and clip against it without repeating a single coordinate. A class
      // that emitted primitives is not one path, so it keeps the plain form and
      // simply takes no part in the layer.
      //
      // The fill moves onto a wrapping `<g>` rather than staying on the path, for
      // two reasons. The layer's `<use>` elements must inherit `fill="none"` from
      // the layer, and a `fill` set directly on the referenced path would beat
      // that and repaint the whole region. And a renderer that cannot follow
      // `href` still draws every fill from a real `<path>`, so the document
      // degrades to the fills-only version rather than to a blank canvas — which
      // publishing the geometry in `<defs>` and drawing it through `<use>` would
      // have risked.
      const referenceable = interpolate && primCount === 0 && !path.isEmpty();
      if (referenceable) {
        const id = `i${interpPathId.size}`;
        interpPathId.set(cls, id);
        markup = `<g${attrs}><path id="${id}" fill-rule="evenodd" d="${path.toString()}"/></g>`;
      } else {
        markup = path.isEmpty()
          ? shapes
          : `${shapes}<path fill-rule="evenodd" d="${path.toString()}"${attrs}/>`;
      }
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

  // One element, one `d`, no clip, no stroke. `evenodd` is what makes the
  // concatenation exact rather than approximate — see the option's note. Nothing
  // is emitted when no opaque class carried a flat colour to paint it in, which
  // is the all-gradient and all-translucent case.
  //
  // The id is not decoration. This element paints no region of its own — it is a
  // copy of the fills above it — so anything taking a census of the document's
  // faces must skip it or every edge acquires a twin that is its own duplicate
  // and every count doubles. `scripts/lib/svg-structure.mjs` skips it by this id,
  // and an editor shows a reader what the layer is for. 18 bytes, once.
  if (underpaint && underFill !== null) {
    doc.fill(underSlot,
      `<path id="underpaint" fill-rule="evenodd" d="${underParts.join('')}"${fillAttrs(underFill)}/>`);
  }

  if (interpolate && interpPathId.size > 1) {
    // 1.5 user units, or 1 where anything is translucent: under a fill of alpha
    // `a` the band shows through with weight `(1 - a)` across its whole width
    // rather than hiding beneath, so widening it paints the picture instead of
    // filling the seam. That is compositing algebra, not a per-subject fit.
    const translucent = [...alphaLevels].some((a) => a > 0 && a < 255);
    const layer = interpolationLayer({
      adjacency: classAdjacency(classes, width, height),
      pathId: interpPathId,
      colorOf: (cls) => classColor(cls, palette, alphaLevels, levelCount),
      backgroundClass,
      width: o.interpolateWidth ?? (translucent ? 1 : 1.5),
    });
    for (const cls of layer.clipClasses) doc.addDef(clipPathDef(interpPathId.get(cls)!));
    doc.fill(interpSlot, layer.markup);
  }

  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: classArea.size,
    regions,
    despeckled,
    notes,
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
