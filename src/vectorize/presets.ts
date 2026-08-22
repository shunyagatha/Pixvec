/**
 * Presets, and the two signals that decide how they adapt to an image.
 *
 * Split out of `api.ts` (Node-only: pulls in libvips/resvg for file I/O) so
 * that a portable consumer — `vecline/core`, which runs unchanged in a
 * browser worker with no bundler shims — can resolve the SAME preset values
 * and the SAME noise/size-adaptive overrides the CLI uses, rather than a
 * hand-copied approximation that drifts the moment a number here is retuned.
 * Everything below is plain computation over a `RasterImage`; nothing here
 * reads a file, spawns a codec, or touches `node:`.
 */

import { packRgba } from '../image.js';
import type { RasterImage } from '../types.js';
import type { TraceOptions } from './trace.js';

export type Preset = 'auto' | 'logo' | 'lineart' | 'poster' | 'photo' | 'detailed' | 'clean' | 'pixelart' | 'exact';

/**
 * Presets are starting points, not straitjackets — every field stays
 * overridable. They exist because the useful parameter combinations cluster by
 * *what kind of picture it is*, and asking someone to guess a Douglas–Peucker
 * tolerance is a bad interface.
 */
export const PRESETS: Record<Exclude<Preset, 'auto' | 'pixelart' | 'exact'>, TraceOptions> = {
  // Tolerances retuned after the curve-fit diagnosis. `logo` and `lineart` keep
  // a higher value (0.6) because there a large arc should stay a few smooth,
  // editable Béziers rather than a fine polygon — that is the whole point of a
  // logo tracer. `poster`, `photo` and `detailed` favour accuracy, where the
  // measured win is largest; `photo` at the old 1.4 was the worst setting in the
  // whole table.
  // `subpixel` and `precision: 1` are here and nowhere else, and the sweep that
  // decided that is worth recording because three of the five presets failed it.
  //
  // Sub-pixel edge extraction is what lets the curve fitter run at all (see
  // `subpixel.ts`), and on the two presets that already sit above the fitter's
  // engagement threshold it buys a lot for less geometry:
  //
  //   logo      +1.84 dB @4x, +1.68 @3.902x, true segments -21.2%
  //   lineart   +1.92 dB @4x, +1.74 @3.902x, true segments -19.2%
  //
  // It costs bytes — logo x1.80 raw / x2.90 gzip, lineart x2.08 / x3.61 across the
  // twelve corpus inputs — and time, x1.49 and x1.77. That trade is worth taking
  // where someone has said "this is a logo" and wants editable curves.
  //
  // It is NOT worth taking anywhere else, measured rather than assumed:
  //
  // - `detailed` couples tolerance/fitError at 0.3, which is *inside* the fitter's
  //   dead zone, so it emits zero curve segments today. Sub-pixel input there does
  //   not simplify an existing fit, it creates one and pays full price: **more**
  //   geometry (+10.1% true segments), x4.07 raw and x6.66 gzip bytes, x2.83 time,
  //   worse on 12 of 12 inputs — and it loses accuracy on the statistic these
  //   presets were tuned on (photo-cat SSIM 0.8645 -> 0.7003).
  // - `poster` is the same story more mildly: x1.87 raw, x3.53 gzip, only -7.2%
  //   segments, and SSIM down on photographs.
  // - `photo` is untouched on purpose; see its own note below.
  //
  // `precision: 1` is a separate, free win and applies only here for the same
  // reason: -13.3% raw and -17.0% gzip for -0.001 dB. It pays for itself because
  // sub-pixel coordinates are fractional, and a fractional coordinate costs both
  // more characters and worse compression (integers gzip ~5.8x, fractionals ~2.7x).
  // `strokeWidth` was finally MEASURED, having been the documented answer to seams
  // for this project's whole life without a single number attached to it. On the
  // metric alone it looks like an accuracy win:
  //
  //   subject          sw0.25   sw0.5   sw0.75    sw1   sw1.5
  //   logo-tux         +0.025  +0.043  +0.054  +0.054  +0.029
  //   alpha-dice       +0.026  +0.031  +0.023  +0.012  -0.007
  //   vector-tiger     +0.015  +0.027  +0.034  +0.030  -0.009
  //   photo-parrots    +0.015  +0.021  +0.020  +0.016  -0.003
  //   photo-cat        +0.051  +0.085  +0.099  +0.102  +0.089
  //   the sticker      +0.016  +0.021  +0.016  +0.005  -0.046
  //
  // SSIM delta against the same preset at 0. Positive on 6 of 6 at 0.5, for
  // 1.001x-1.028x raw bytes and 1.001x-1.014x gzipped. A strict improvement, which
  // this project almost never finds, and it was sitting switched off.
  //
  // AND IT IS NOT SWITCHED ON, because the table above is not the whole story.
  //
  // Two things killed it after that measurement, both found by looking where the
  // metric could not:
  //
  // 1. IT PAINTS OUTSIDE THE SILHOUETTE. On logo-tux the stroke puts colour into
  //    831 pixels the source says are fully transparent, against 156 without it,
  //    with alpha reaching 183. Composited over white that is invisible, which is
  //    exactly why SSIM improved; over a dark background it is a halo. Transparent
  //    logos are the main thing `--preset logo` is pointed at, and this project has
  //    already shipped one dark-background rendering failure.
  //
  // 2. THE GAIN IS PARTLY SELF-INFLICTED. The preset's own `minArea: 8` and
  //    `tolerance: 0.65` cost accuracy that the stroke then partially repays. Plain
  //    `auto` scores higher on logo-tux than the preset does with the stroke on.
  //
  // So it is a TRADE, not the strict improvement the numbers alone suggested, and
  // a trade whose cost falls on the preset's primary use case. It stays available
  // as an explicit option, which is what it always was.
  //
  // What would make it shippable: a stroke that stops at the silhouette instead of
  // straddling it. The measured win is real between two OPAQUE regions, where the
  // half-covered pixels belong to both; it is only at the outer boundary against
  // transparency that there is nothing on the other side to repair.
  //
  // (0.5 was the value chosen, on its floor rather than its mean: better worst case
  // than 0.75, +0.021 against +0.016, and 1.5 goes negative on three of six.)
  //
  // Deliberately NOT applied to `auto` or the bare trace defaults, though the table
  // shows it would help there too — photo-cat gains the most of any subject. That
  // changes the published README figures and the byte-identity baseline, so it is a
  // separate decision with its own measurement, not a rider on this one.
  //
  // Why a stroke helps at all: it paints the region's own colour back over the
  // half-covered pixels along its boundary, which is where a fill-only mosaic loses
  // coverage. The paid rival ships `stroke-width="2.00"` on its output group for
  // what looks like the same reason.
  //
  // WHICH SETS ITS LIMIT, and a single antialiased disc shows the boundary
  // condition by disagreeing with every row above: 0.9791 at 0, 0.9798 at 0.25,
  // then DOWN to 0.9736 at 0.5 and 0.9462 at 1. The payoff scales with how much of
  // the picture is boundary, so two big shapes gain almost nothing and lose to the
  // overpaint, while artwork with hundreds of small regions gains throughout. Do
  // not expect this to help a simple figure, and do not tune it on one.
  // `colors: 8`, not 16, and the direction is the finding. Every earlier sweep of
  // this preset went UPWARD — 32 and 64 are both worse — so 16 was treated as a
  // floor and never tested from below. It is not a floor. On logo-tux:
  //
  //   colours   6       8      10      12      16
  //   gzip   11,929  12,836  15,459  16,644  19,638
  //   SSIM   0.8872  0.8933  0.8897  0.8906  0.8747
  //
  // 8 is +0.0186 SSIM against 16 at 0.65x the bytes — better on both axes — and
  // rendered it is visibly cleaner: less mottling in the grey shading, smoother
  // edges. Across the flat-art corpus, best-vs-16: logo-tux +0.0186 at 0.65x,
  // vector-tiger +0.0052 at 0.97x, vector-comparison +0.0036 at 0.83x, all strict.
  // vector-source is unchanged because it only contains two real colours.
  //
  // The one loss is alpha-dice, which prefers 16 by 0.008. That is the trade taken:
  // three strict wins and a visible improvement on the preset's namesake case
  // against one modest regression on a subject with far more real inks than a logo.
  //
  // THE OTHER PRESETS WERE SWEPT THE SAME WAY AND MOSTLY LEFT ALONE, because the
  // "tuned only from above" mistake is not universal:
  //
  //   lineart  ships 6   logo-tux prefers 8 (+0.009), vector-comparison prefers 6.
  //                      Mixed, and 6 is right for its actual subject. Unchanged.
  //   poster   ships 32  photo-parrots prefers 32 — correct for its purpose.
  //                      vector-tiger prefers 8, but poster is not for flat art.
  //   detailed ships 48  the auto palette beats every fixed value tried. Unchanged.
  //   clean    ships 16  logo-tux prefers 16; the sticker prefers 6. Unchanged.
  //
  // Only `logo` was mistuned. Recorded so the sweep is not repeated on the rest.
  //
  // A paid rival describes logo-tux with TEN fills, which is what prompted looking
  // down rather than up. Our peak is 8 and its gzip at 6 colours (11,929) lands
  // within seven bytes of theirs (11,936) — the palette was never the reason they
  // score higher, but it was costing us a third of our bytes for nothing.
  //
  // `tolerance`/`fitError` 0.6 was inherited, not swept — unlike `colors`, above,
  // it never had its own measurement. `combineAxes` (subpixel.ts) surfaced why
  // that matters: Douglas-Peucker plus `findBreakpoints`'s hard cosine corner
  // threshold is a genuinely CHAOTIC function of tolerance on a synthetic
  // composite fixture (two circles, a diagonal split) — `test/metrics.test.ts`'s
  // "tuned from below" colour-count regression test swept in steps of 0.01
  // against BOTH the pre-`combineAxes` and post-`combineAxes` geometry and found
  // "8 colours is smaller than 16" flips pass/fail repeatedly across neighbouring
  // tolerances even on the UNCHANGED pre-existing code (fails at 0.53-0.59 and
  // 0.69-0.79; only 0.60-0.68 is a robust pass band). 0.60 sits at the very
  // start of that band, where `combineAxes`'s corrected, sub-pixel-different
  // vertex positions were enough to walk this one fixture across the boundary.
  // 0.65-0.68 is the band both the old and new geometry pass across every
  // step swept — not a coincidence at one operating point, but the middle of a
  // stable region for both.
  //
  // Moved to 0.65 rather than reverting the geometry fix, and checked against
  // real corpus rather than only the synthetic fixture, against the true prior
  // baseline (no combineAxes, tolerance 0.6) rather than an isolated-tolerance
  // comparison that overstates the win: logo-tux 33,343 -> 32,252 bytes (-3.3%)
  // at ssim 0.8913 -> 0.8909 (-0.0004, noise); alpha-dice 253,433 -> 242,822
  // (-4.2%) at ssim 0.8574 -> 0.8553 (-0.0021, still noise-level). Both a real
  // byte win at an accuracy cost too small to matter. The swept range 0.60-0.70
  // in 0.01 steps on real corpus is smooth and monotonic in both bytes and
  // ssim — unlike the synthetic fixture, nothing here is a cliff; 0.65 was not
  // picked at a knife edge.
  logo: {
    colors: 8, minArea: 8, tolerance: 0.65, fitError: 0.65, cornerAngle: 75,
    subpixel: true, precision: 1,
  },
  lineart: {
    colors: 6, minArea: 4, tolerance: 0.6, fitError: 0.6, cornerAngle: 60,
    subpixel: true, precision: 1,
  },
  poster: { colors: 32, minArea: 12, tolerance: 0.5, fitError: 0.5, cornerAngle: 80 },
  // `clean` is the one preset that is not trying to be faithful, and says so.
  //
  // It exists for artwork that arrived damaged — a sticker or logo that was flat
  // colour once, then got shrunk and JPEG'd. Every other preset reproduces that
  // damage accurately. This one spends `smooth` to collapse the compression noise
  // and `segment` to make the palette meet coherent regions, and accepts a lower
  // fidelity score on purpose: scoring against the degraded source rewards
  // reproducing the degradation.
  //
  // Measured at colors 16, filter on versus off:
  //
  //   sticker (noisy JPEG)  0.48x bytes, SSIM -0.0435   <- what this is for
  //   photo-cat             0.64x, -0.1119
  //   logo-tux (clean PNG)  0.77x, -0.0903              <- and why it self-scales
  //
  // The last row is the reason `smooth` is scaled by measured noise instead of
  // being a constant: on a clean source there is nothing to remove, so a fixed
  // strength pays real fidelity for almost no reduction. On a clean input this
  // preset therefore converges toward ordinary `poster` behaviour, which is the
  // correct answer rather than a compromise.
  //
  // What it does NOT do, measured against a paid reconstruction tool on the same
  // sticker: produce redrawn, flat-filled illustration with bold outlines. That
  // recovers the artwork behind the raster using priors about illustrations; this
  // is a filter, and no strength setting turns one into the other — past a point
  // the subject dissolves instead. Recorded so the name is not read as a promise.
  // NOTE the fields that are deliberately absent: tolerance, fitError, cornerAngle.
  // The first version of this preset set them to 0.5/0.5/80 and was WORSE than
  // `auto` — 547 curve segments that speckled every boundary instead of smoothing
  // it, at 28,789 bytes. Removing those three overrides leaves 7 curves and 8,797
  // bytes on the same image, from the same filter.
  //
  // That is the same finding as the curves-by-default rejection, arriving a second
  // time by a different road: the fitter is not short of tolerance, it is being fed
  // boundaries that are still rough, and fitting a rough boundary produces a rough
  // curve. Smoothing the IMAGE is what earns curves later; forcing them earlier
  // just spends bytes on noise. Do not add them back without rendering the result.
  //
  // MOSAIC, added after the three overrides above were re-examined. The reason
  // they failed is now known and it was never the tolerance: crack-following emits
  // axis-aligned unit steps, so an untouched lattice vertex cannot deviate from a
  // chord by less than 1/sqrt(5) = 0.4472136. Above the 0.4 tolerance, so
  // Douglas-Peucker removed NOTHING, every loop took the polygon shortcut and the
  // Schneider fitter never ran once. Raising the tolerance past the dead zone is
  // what produced the 547 speckling curves: it let the fitter loose on a boundary
  // that was still a staircase.
  //
  // `mosaic` fixes the input instead. Each shared boundary is smoothed once, off
  // the lattice, with junctions pinned, and fitted once for both neighbours —
  // which is required, because the fitter is not reversal-symmetric and two faces
  // fitting private copies land up to 2.94px apart. Segment census against the
  // shipped preset and a paid rival:
  //
  //                     clean        mosaic+stroke      rival
  //   logo-tux      0.0% / 6,234    75.8% /  1,714   84.8% /  1,350
  //   alpha-dice   23.9% / 47,044   71.7% / 13,425   78.6% / 11,198
  //
  // WHAT IT COSTS, which is not nothing. On flat art it is a clear win —
  // alpha-dice improves on every axis at once (342,118 -> 225,324 bytes, SSIM
  // 0.8913 -> 0.8974). On PHOTOGRAPHS it is worse on both: over six photographic
  // subjects SSIM falls and gzip roughly doubles, because a photograph has no
  // staircase to remove, only detail. `auto` and `photo` remain the right choice
  // there, and this preset does not claim otherwise.
  //
  // `strokeWidth` is here for a measured reason and not by analogy with the
  // rival. Curved boundaries no longer land on the lattice, so a join antialiases
  // and can leave a hairline: rendered with nothing painted beneath, logo-tux
  // leaks 943 pixels at 2.7x magnification and the stroke takes it to 66,
  // alpha-dice 32 to 0, photo-parrots 284 to 0. This is why the same option
  // measured NEGATIVE as a global default: on lattice-aligned polygons there is no
  // gap to fill and the stroke only fattens the shape. (Those three leak figures
  // are AT WIDTH 1, which this preset no longer ships — see the sweep below. They
  // are kept because they are the argument for having a stroke at all, not the
  // argument for its width; a leak COUNT barely moves with width, only the
  // deficit does, and that is measured under the `interpolate` note further down.)
  //
  // 0.5, AND IT SHIPPED AT 1 FOR A DAY BECAUSE THE WIDTH WAS NEVER SWEPT. The
  // value was chosen on three subjects that all gained, and never varied. Swept
  // properly, N=9, delta SSIM against no stroke at all:
  //
  //   width   mean      subjects harmed   worst subject   gzip
  //   0.25   +0.0119        0 of 9           +0.0014      1.003x
  //   0.50   +0.0159        1 of 9           -0.0020      1.003x
  //   0.75   +0.0133        3 of 9           -0.0102      1.003x
  //   1.00   +0.0064        3 of 9           -0.0223      1.003x
  //
  // 1.0 was the WORST of the four on the mean and tied for worst on subjects
  // harmed, with ten times the downside of 0.5. The three casualties there
  // (jpeg-artifacts -0.0223, motorcycles -0.0219, lighthouse -0.0220) come back to
  // +0.0005, +0.0028 and -0.0020 at half the width. Byte cost is identical at every
  // width, so nothing is being traded for it.
  //
  // 0.5 IS A SWEPT OPTIMUM ON A SMOOTH TRADE, not a threshold where anything
  // physical happens. A draft of this note claimed 0.5 was "where the interior seam
  // hits zero" and that everything above it was spent on the halo; two independent
  // reviews showed that holds only under an undisclosed threshold, and that the
  // project's own magnification instrument puts the optimum at 0 rather than 0.5.
  // The numbers above are the whole case. If no subject may be harmed at all, 0.25
  // is the honest choice and costs 0.0040 of the mean.
  //
  // The general lesson is recorded here because this is the second time it has been
  // paid for: a constant that has only ever been swept UPWARD gets read as a floor.
  // 0.25 and 0.5 were never tried until the losses at 1.0 forced the question.
  //
  // THE RIVAL'S STROKE PASS IS NOT A SEAM COVER, and this comment said it was.
  //
  // The earlier reading here — "a separate pass whose colour is the mean of the
  // two fills, duplicating fill geometry, so a same-colour stroke is the cheap
  // equivalent at 2% of the bytes" — got the mechanism wrong and therefore priced
  // it wrong. It is a COLOUR-INTERPOLATION pass: it reconstructs the antialiased
  // blend along every region boundary, which is information the fills do not
  // carry. A same-colour stroke covers a gap and adds no colour at all, so the two
  // are not substitutes.
  //
  // Measured by deleting only the stroke-only group and asserting the filled
  // element count is unchanged, so this is the pass and not geometry removal:
  //
  //   subject          fills  strokes  strokes that are also a fill   with -> without
  //   logo-tux            10       30          0                      0.9483 -> 0.8994
  //   alpha-dice          40      125          1                      0.9126 -> 0.8962
  //   photo-parrots      124      788          0                      0.8669 -> 0.7077
  //   photo-motorcycles  145     3048          3                      0.8498 -> 0.6275
  //
  // Worth +0.0164 to +0.2223 SSIM across nine subjects, for 25-45% of their bytes.
  // Almost none of their stroke colours appear as a fill anywhere in the file —
  // they are blends, which is the whole point.
  //
  // WHAT THAT MEANS FOR US, stated plainly because it reverses the standing
  // conclusion. Strip their pass and their filled partition scores 0.8994 against
  // our 0.9174: we are 0.0180 AHEAD on regions and colour, and the entire deficit
  // on logo-tux is this one rendering pass. Our `strokeWidth` remains correct for
  // what it does — at width 1 it took leaks 943 -> 66 for 1.9% of bytes, and cost
  // bleed into transparent pixels of 217 -> 765 — but it is not the equivalent of
  // theirs and must not be recorded as one. (Both figures are at width 1; the
  // preset ships 0.5, and what half a width still buys is the +0.0159 mean in the
  // sweep above and the alpha deficit in the `interpolate` note below.)
  //
  // BUILT, as `interpolate`, and DELIBERATELY OFF here. See
  // src/vectorize/interpolate.ts. The table that stood here — six subjects, four
  // gains of +0.0058 to +0.0280 and two losses — is deleted rather than patched,
  // because every figure in it was taken against `strokeWidth: 1`, and this preset
  // now ships 0.5. Not one of those six rows survives re-measurement: the four
  // gains fall to +0.0153 / -0.0025 / +0.0083 / +0.0038 and the two losses become
  // -0.0083 and +0.0030.
  //
  // WHY THAT INVALIDATED IT, and this is the trap to remember. `interpolate`
  // SUPPRESSES the stroke entirely (`strokeFor` in trace.ts), so an on/off
  // comparison changes TWO things: it adds the blend AND it removes the stroke.
  // The old table was therefore never blend-versus-nothing; it was
  // blend-versus-the-worst-of-four-stroke-widths. Re-derived on all nine subjects
  // at the shipping 0.5, as four corners, {interpolate off,on} x {strokeWidth
  // 0.5, 0}. Cells C (on/0.5) and D (on/0) come out BYTE-IDENTICAL on all nine,
  // which states the confound as a fact rather than a risk: with the pass on,
  // `strokeWidth` does nothing at all.
  //
  //   subject           A off/0.5   B off/0     D on      D-A       D-B    D vs blur(A)
  //   logo-tux             0.9076   0.8733   0.9229   +0.0153   +0.0496   +0.0425 CLEARS
  //   photo-lighthouse     0.6821   0.6841   0.6904   +0.0083   +0.0063   +0.0079 CLEARS
  //   photo-jpeg-artifacts 0.5521   0.5517   0.5592   +0.0071   +0.0075   +0.0093 CLEARS
  //   photo-motorcycles    0.5945   0.5917   0.5983   +0.0038   +0.0066   +0.0088 CLEARS
  //   photo-cat            0.8173   0.7789   0.8203   +0.0030   +0.0414   -0.0159 fails
  //   photo-parrots        0.7530   0.7419   0.7513   -0.0017   +0.0094   -0.0146 fails
  //   alpha-dice           0.9203   0.8892   0.9178   -0.0025   +0.0286   -0.0196 fails
  //   photo-portrait       0.6579   0.6416   0.6555   -0.0025   +0.0139   -0.0133 fails
  //   photo-jpeg-source    0.9292   0.9182   0.9209   -0.0083   +0.0027   -0.0113 fails
  //   MEAN                                           +0.0025   +0.0184
  //
  // D-B is what the BLEND is worth: positive on 9 of 9, mean +0.0184. The pass
  // works, and nothing here disputes that. D-A is what it is worth HERE, on top
  // of what already ships, and that is +0.0025 with four subjects harmed —
  // because the 0.5 stroke it suppresses is already collecting a mean +0.0159
  // (A-B, 8 of 9) of the same thing. Two near-substitutes, and the cheap one is
  // already in: the stroke costs 0.3-2% of the bytes where the pass costs 0.5-14%.
  //
  // THE COST LANDS EXACTLY WHERE THE PRESET LIVES. gzip D/A: logo-tux 1.141x,
  // alpha-dice 1.122x, jpeg-source 1.111x — the flat art `clean` exists for —
  // against 1.005x to 1.064x on the six photographs. Raw, logo-tux 18,698 ->
  // 24,221 bytes. It is most expensive precisely where it would have to earn it.
  //
  // "ON FOR FLAT ART, OFF FOR PHOTOGRAPHS" WAS TESTED AND IS FALSE, so nobody
  // builds a content branch for it. The three flat-art subjects disagree with each
  // other — logo-tux +0.0153, alpha-dice -0.0025, jpeg-source -0.0083 — and two of
  // the three lose. alpha-dice is the OTHER transparency subject, the case this
  // preset most exists for, and it prefers the plain stroke.
  //
  // RENDERED AND LOOKED AT, source beside both cells over mid grey, and this is
  // the deciding evidence rather than the table. logo-tux at 10x on the eye and
  // beak: real and visible — the white ring against black and the yellow beak
  // against black gain an intermediate ramp where the fills-only document has a
  // hard step. photo-jpeg-source at 8x: visibly WORSE — every red glyph gains a
  // pink halo and the counters of `a` and `e` fill in, the blend band spreading
  // into white and thickening the type. On the one preset whose job is to clean
  // damaged artwork UP, that is the wrong direction, and SSIM agrees for once.
  // photo-portrait at 4x: indistinguishable, and alpha-dice at 4x only barely
  // distinguishable — a faint softening along the die-face seams and pip edges,
  // which is the same band spreading and matches its -0.0025.
  //
  // IT DOES NOT FIX THE INTERIOR ALPHA HAIRLINE, despite interpolate.ts having
  // claimed the band "recovers both: the ramp and the gap" (now corrected there).
  // Alpha deficit — the sum of 255-alpha over pixels the SOURCE calls fully
  // opaque, which needs no metric at all and cannot be gamed by a candidate:
  //
  //   subject      bare   stroke 0.5   interpolate   stroke 1.0   paid rival
  //   logo-tux   175,892      75,634        68,350       23,770       22,971
  //   alpha-dice  57,036      22,284        22,191        6,434       11,476
  //
  // The pass lands level with the 0.5 stroke it deletes and three times short of a
  // 1.0 stroke. On the worst single pixel of logo-tux it is actively worse: 0/255
  // against the stroke's 32/255, i.e. a fully transparent pixel inside solid
  // artwork. The hairline is a stroke-width question and must not be spent on this
  // one. Note also that the leak COUNT is inert here — 3,656 on logo-tux for bare,
  // stroked and interpolated alike, because alpha 254 counts the same as alpha 0.
  // Only the deficit moves; quote a count without its threshold and it says nothing.
  //
  // WHAT WOULD CHANGE THIS. One subject clearing the blur floor by 0.0425 while
  // five fail it is an argument for an OPTION, which is what this already is, not
  // for a default. A corpus with more logo-tux-shaped subjects — high-contrast
  // flat art on transparency, few classes, long shared boundaries — could move it;
  // N=9 with one strong win and four losses cannot. DO NOT RE-OPEN THIS AGAINST
  // THE STROKE-1 NUMBERS AGAIN: any comparison that does not also measure the
  // stroke-0 corner is measuring the suppression, not the blend.
  //
  // IT DOES NOT FIX THE INTERIOR HAIRLINE, whatever its docstring implies — see
  // `underpaint` below, which does, and which composes with it.
  //
  // THE BLUR CONTROL, and the correction that came with it. An earlier version of
  // this note said a free Gaussian blur outscored everything the project had
  // shipped, on 8 of 9 subjects, and concluded photographic SSIM was untrustworthy.
  // That was a bug in `compareImages` — the alpha gate let a candidate buy a
  // fourth scored channel by varying its own alpha, which any `<filter>` does. On
  // RGB alone the blur was always making things worse. See src/metrics/index.ts.
  //
  // With that fixed, blur's advantage is at most +0.0229 (alpha-dice) and it LOSES
  // on logo-tux, motorcycles, jpeg-artifacts and lighthouse. SSIM mildly favours
  // smoothing, as it is known to; it is not broken here.
  //
  // `npm run blur:control` remains worth running as a floor: a gain inside what a
  // blur buys for free has not been shown to be visible.
  //
  // Colour count stays at 16. The rival describes logo-tux with ten fills and it
  // was worth checking whether that was the advantage; swept at 8, 10, 12 and 16
  // it is an ordinary size-for-fidelity trade and not a free win — mean SSIM over
  // eight subjects runs 0.7406 (16), 0.7357 (12), 0.7327 (10), 0.7316 (8).
  //
  // `optimizeError: 0.75` — the merge pass was inert, and not for the reason its
  // own docstring gave. fit.ts reads `opts.optimizeError ?? opts.fitError`, so
  // `clean` inherited 0.4 and a merged curve had to be no worse than a freshly
  // fitted one. Instrumented, it accepted a fraction of the merges it attempted.
  // Giving it its own budget, corpus-wide over eight subjects:
  //
  //   value   segments   curve%      raw      gzip   mean SSIM
  //    0.4      97,117    67.5%  1,485,348  508,628   0.74064
  //    0.70     85,104    63.1%  1,272,581  453,800   0.73951
  //    0.75     83,296    62.3%  1,239,972  444,371   0.73940
  //    0.80     81,556    61.6%  1,208,231  434,582   0.73899
  //    0.90     77,930    59.8%  1,140,813  417,131   0.73834
  //
  // THERE IS NO PEAK, and an earlier version of this note claimed one. Corpus
  // mean SSIM falls monotonically across the whole sweep; logo-tux alone reads
  // 0.9168 / 0.9173 / 0.9174 / 0.9173 / 0.9166 at 0.4 / 0.70 / 0.75 / 0.80 / 0.90,
  // which is a plateau one ten-thousandth wide, not an optimum — 0.80 matches it
  // while being 3.7% smaller. So 0.75 is a CHOSEN point on a smooth trade and
  // anything in 0.70-0.85 is defensible. It is picked because it takes 74% of the
  // segment gap to the rival (1,714 -> 1,444 on logo-tux) while keeping curve
  // share above 72%, which is the property this preset exists to raise.
  //
  // WHAT IT COSTS. Curve share, and by arithmetic rather than by anything going
  // wrong: merging two curves into one removes one from the numerator and one
  // from the denominator, which lowers any share above 50%. Lines do NOT rise —
  // they fall corpus-wide, so nothing is being flattened into a straight segment.
  // SSIM falls on seven of eight subjects, worst -0.0044 on photo-jpeg-artifacts.
  // logo-tux rises by 0.0006 and that is not worth quoting: a smoother curve
  // landing nearer the antialiased original explains it at least as well as any
  // gain in accuracy.
  //
  // `quadratics: true`. A quadratic is 4 numbers against a cubic's 6, and the
  // reduction is gated on the fitter's OWN error budget rather than on distance
  // from the cubic — so a converted span is no further from the traced points than
  // the cubic it replaced. Measured over all nine subjects:
  //
  //   raw -25.3%, gzip -22.5%, mean SSIM -0.00112, and the SEGMENT COUNT is
  //   identical on every subject (0 mismatches), as is the curve share.
  //
  // That last part is why this is defaulted on where other size wins were not: it
  // is a pure representation change. Nothing is simplified away, no boundary
  // moves further than the budget already allowed, and the picture is the same
  // picture — it is written down more cheaply. Per-subject the SSIM cost runs from
  // +0.0013 (logo-tux, which improves) to -0.0031 (photo-jpeg-source).
  //
  // It shipped opt-in first, deliberately: it adds a third `Segment` kind that
  // reaches the DXF, EPS and PDF writers, and that surface wanted a release of
  // exposure before becoming a default.
  //
  // `underpaint: true`, and it is the only preset that turns it on, because it is
  // the only one aimed at artwork with transparency. What it fixes is a COUNT and
  // not a score: pixels the SOURCE calls fully opaque that render see-through
  // where two of our fills meet. Two abutting elements cover `c` and `1 - c` of
  // the shared pixel and source-over leaves `1 - c + c^2`, which is 0.75 at
  // `c = 0.5`. On opaque artwork the background rectangle hides it; on
  // transparent artwork nothing does, and the leak traces every interior
  // boundary in the picture.
  //
  // Leaks (source-opaque pixel rendered below alpha 250) / of those, INTERIOR
  // ones more than a pixel from the silhouette, where the artwork's own edge
  // cannot explain them / worst alpha / total alpha deficit:
  //
  //   subject      as shipped before          with underpaint        paid rival
  //   logo-tux     3,621 / 3,171 / 32 / 75,466   319 / 0 / 32 / 12,270   387 / 17
  //   alpha-dice   1,350 /   725 /222 / 22,142   243 / 16 /228 /  2,501  567 / 213
  //   other seven      0 /     0            0 /  0                70 - 1,144
  //
  // The interior count goes to ZERO on logo-tux and to 16 on alpha-dice, and both
  // subjects now beat the paid rival, which reaches its own number the same way
  // (an unclipped opaque underlayer) rather than by clipping. The 319 and 243 that
  // remain are all within one pixel of the silhouette, where partial coverage is
  // the correct answer. The 16 interior stragglers on alpha-dice are opaque
  // pixels bordering a TRANSLUCENT class, which the underpaint deliberately does
  // not reach: painting under a translucent region would show through and repaint
  // it. Measured by doing it anyway — alpha-dice's leaks fall to 19 and its SSIM
  // falls with them, 0.9233 -> 0.8936, for 73% more gzip. Fewer leaks and a worse
  // picture is what a gamed count looks like, which is why the renders decided
  // this and not the table.
  //
  // COSTS, and where. gzip x1.040 logo-tux, x1.121 alpha-dice; RAW x1.92 and
  // x1.12, since the `d` data is repeated and gzip eats the repeat only while the
  // document fits its 32K window. Byte-IDENTICAL on the seven opaque subjects —
  // sha1-checked, not assumed — so nothing a photograph does can be blamed on it.
  // SSIM rises where it applies (logo-tux 0.9076 -> 0.9260, alpha-dice
  // 0.9203 -> 0.9233) and moves nowhere else; the alpha-dice gain is inside what
  // a free blur buys, which is why the case here rests on the count.
  //
  // WHY NOT THE CHEAPER-LOOKING VERSIONS. A clip cannot do this: a `<clipPath>`
  // is rasterised into a mask by the same source-over arithmetic, so a mask built
  // from abutting shapes carries the identical deficit, and an opaque band times
  // a 0.75 mask is 0.75. `interpolate` is the clipped version already shipped
  // here and it behaves exactly as that predicts: 844 of logo-tux's 3,171
  // interior leaks, and 2 of alpha-dice's 725. `strokeWidth` only covers the seam once
  // the stroke is wide in DEVICE pixels — which is why the shipped 0.5 looks
  // innocent at 4x and leaks 7,733 interior pixels at 1.37x, the scale a viewer
  // actually reads a logo at. Rendered at 1.37x and 3.902x, both non-integer on
  // purpose: an integer scale puts every lattice edge on a pixel boundary and
  // hides antialiasing entirely.
  //
  // `minArea: 4` STAYS AT 4. Lowering it to 2 was proposed on a 9-of-9 sweep,
  // measured twice against non-circular truth, and REFUTED. This note is here so
  // it is not re-proposed on the same table.
  //
  // WHAT THE KNOB ACTUALLY IS. `despeckle` absorbs every component whose area is
  // strictly BELOW `minArea` (components.ts), so 4 -> 2 is not a nudge along a
  // smooth trade: it is exactly the decision to KEEP EVERY 2- AND 3-PIXEL
  // COMPONENT in the picture. Nothing else changes.
  //
  // THE CASE FOR IT, reproduced exactly. N=9, preset `clean`, SSIM at 1x against
  // each subject's own source:
  //
  //   subject               minArea 1  minArea 2  minArea 3  minArea 4 (ships)
  //   alpha-dice             0.9219     0.9242     0.9237     0.9233   clean PNG
  //   logo-tux               0.9068     0.9283     0.9264     0.9260   clean PNG
  //   photo-cat              0.8175     0.8174     0.8174     0.8173   JPEG
  //   photo-jpeg-artifacts   0.5939     0.5757     0.5634     0.5521   JPEG, heavy
  //   photo-jpeg-source      0.9813     0.9505     0.9340     0.9292   JPEG
  //   photo-lighthouse       0.6925     0.6889     0.6848     0.6821   PNG
  //   photo-motorcycles      0.6242     0.6090     0.6006     0.5945   PNG
  //   photo-parrots          0.7549     0.7542     0.7535     0.7530   PNG
  //   photo-portrait         0.6595     0.6591     0.6582     0.6579   PNG
  //
  //   minArea 2: mean +0.0080, better on 9 of 9, gzip 1.074x, SUBPATHS 1.497x.
  //
  // "9 OF 9" IS NOT A DISTINGUISHING PROPERTY ON THIS INSTRUMENT. Three unrelated
  // levers do the same thing on the same corpus: `segment: 0.01` is +0.0032 on 9 of
  // 9 for 1.026x gzip and 1.045x subpaths, `optimizeError: 0.4` is +0.0019 on 9 of
  // 9 with ZERO added subpaths. Anything that makes the output hug its input more
  // closely wins here, because the reference IS the input. A clean sweep of this
  // table says the candidate hugs harder, not that the picture got better.
  //
  // THE NON-CIRCULAR ARM, which is the one that decided it. corpus/src holds four
  // .svg. THREE are genuine third-party vector originals — vector-tiger
  // (Ghostscript Tiger), vector-comparison (Wikimedia, Inkscape 1.3),
  // vector-source (Inkscape 0.45.1). logo-tux.svg is OUR OWN OUTPUT, first line
  // "<!-- Generated by vecline v2.0.0 -->", and is excluded by name — check the
  // provenance of any .svg before treating it as ground truth. Render each
  // original at 384px, damage it down a JPEG ladder, vectorise THAT, and score at
  // magnification against the original the tracer never saw. N=3 x 4 rungs, and
  // both 4x and 3.902x, because at exactly 4x every lattice edge lands on a pixel
  // boundary and antialiasing vanishes from the score.
  //
  //   minArea 2 minus minArea 4, at 3.902x:      clean     q75     q50     q30
  //     vector-tiger          against TRUTH    +0.0092 +0.0091 +0.0053 +0.0029
  //                           CIRCULAR, 1x     +0.0490 +0.0454 +0.0380 +0.0339
  //     vector-comparison     against TRUTH    +0.0014 +0.0037 +0.0021 +0.0027
  //                           CIRCULAR, 1x     +0.0145 +0.0164 +0.0180 +0.0127
  //     vector-source         against TRUTH    -0.0006 -0.0020 -0.0010 -0.0003
  //                           CIRCULAR, 1x     +0.0031 +0.0091 +0.0130 +0.0165
  //
  // Read the vector-source pair on its own: as damage is added the shipped metric's
  // advantage climbs FIVEFOLD, +0.0031 -> +0.0165, while the same runs are NEGATIVE
  // against the artwork at every rung. The metric and the picture move in opposite
  // directions, and the metric moves further the more damage there is to reproduce.
  // On tiger and comparison the circular figure runs 4.4x to 11.7x the truth
  // figure at every one of the eight rungs, never once agreeing on magnitude.
  // 4x agrees with 3.902x on every conclusion and is uniformly the
  // SMALLER figure, so the integer scale understates the gap.
  //
  // RENDERED AND LOOKED, at 6x-16x. photo-jpeg-source is the +0.0213 row and the
  // second-largest claimed gain: at minArea 4 the red glyphs are clean letterforms
  // with a faint pale wash; at minArea 2 the same glyphs carry a crust of angular
  // mid-pink chips hugging every contour. That crust is the JPEG's own ringing
  // halo, re-encoded as geometry. vector-source at q30 shows it against real truth
  // — the vector 'n' is smooth, minArea 4 is lumpy but continuous, minArea 2 is
  // serrated with terraced grey-and-pink blocks down both stems. It looks dirtier,
  // and truth SSIM agrees while circular SSIM says +0.0165. On the tiger's muzzle
  // minArea 2 BREAKS a continuous dark crease into a dotted chain, so "the lower
  // floor keeps more detail" is not even uniformly true by eye. On photo-lighthouse
  // the two are indistinguishable at the crops tried.
  //
  // WHAT THE ADDED LOOPS ARE. Of the subpaths minArea 2 adds, 38-77% enclose one
  // square pixel or less and 57-84% enclose three or less, per subject
  // (scripts/lib/path-stats.mjs; counting command LETTERS undercounts). Corpus
  // total 1.497x subpaths for 1.074x gzip — the byte axis is the one that moves
  // least, and quoting it alone hides the cost. On the vector originals it is
  // 1.20x-1.39x gzip for 2.4x-2.9x subpaths.
  //
  // THE BLUR FLOOR DOES NOT MOVE. `npm run blur:control` beats the candidate on the
  // same 6 of 9 subjects at minArea 2 as at minArea 4, and photo-jpeg-source reads
  // 0.9505 at minArea 2 against a free ~150-byte blur's 0.9521 — the second-largest
  // claimed gain is still inside what smoothing buys for nothing.
  //
  // THE HONEST COUNTERWEIGHT, recorded rather than buried: on CLEAN input a lower
  // floor recovers real picture. vector-tiger is +0.0092 against clean vector truth
  // at 3.902x, and that arm is non-circular. It is not carried over, because
  // `clean` is documented three screens above as the preset for artwork that
  // ARRIVED DAMAGED, and the damaged arm is where it will actually be pointed. A
  // finding about clean input belongs to a preset aimed at clean input.
  //
  // DO NOT QUOTE detailKept AS AN ARGUMENT FOR EITHER VALUE. bench-scale's
  // destruction tripwire, against clean vector truth at 3.902x, reads 75.9% at
  // minArea 4 and 84.6% at minArea 2 on vector-tiger. Both are under the 90% flag;
  // it does not choose between them, it says the preset's 16-colour palette is
  // losing the tiger's face at either setting.
  //
  // THE "SWEPT ONLY UPWARD" LESSON IS NOW DISCHARGED FOR THIS CONSTANT. `minArea`
  // had only ever been swept up from 4 (8, 16, 40), which is the mistake `colors`
  // and `strokeWidth` each paid for. 1, 2 and 3 have now all been measured from
  // below. 1 is worse on the circular table too (7 of 9; it LOSES logo-tux 0.9068
  // vs 0.9260 and alpha-dice 0.9219 vs 0.9233) and speckles clean flat art. 2 and 3
  // are the milder dose of the same mechanism, not something different in kind.
  //
  // WHAT WOULD CHANGE THIS, and what would not. Not another 1x sweep: that
  // instrument has now been shown to disagree with the artwork by sign. It would
  // take a keep rule that separates a 2-pixel FRAGMENT OF A REAL EDGE from a
  // 2-pixel COMPRESSION ARTEFACT, and area alone does not — shape does not either
  // on this evidence, since vector-source's added loops are 62% elongated and its
  // truth SSIM still falls. A per-image branch is NOT available: `refineGateFor`
  // already branches every explicit preset on `measureFlatness().interiorNoise`,
  // and that signal does not separate these two arms — clean vector-tiger reads
  // 1.0174 and clean logo-tux 0.6535, both far above the 0.3 gate and both ABOVE
  // damaged photo-jpeg-source's 0.5117. Branching minArea on the existing signal
  // would put pristine vector art on the damaged side. See `autoTracePreset`,
  // which already records two content-type guesses that failed the same way.
  clean: {
    colors: 16, minArea: 4, smooth: 1, segment: 0.02,
    mosaic: true, strokeWidth: 0.5, optimizeError: 0.75, quadratics: true,
    underpaint: true,
  },
  // `photo` carries no minArea/tolerance/cornerAngle overrides on purpose. It
  // used to force `minArea: 16, cornerAngle: 90, colors: 64` — the same mistake
  // `autoTracePreset` documents having removed — and `npm run compare` caught
  // the result: a preset named "photo" was *worse than auto on photographs*.
  // Despeckling at 16px erases exactly the fine detail — feathers, hair,
  // foliage — that a photograph is made of, and the extra 16 colours never paid
  // for themselves.
  //
  // Re-measured against the shipped path, because the figures recorded here
  // originally were not reproducible from it. The old arm still reproduces
  // exactly (parrots 0.7868 SSIM / 262 KB, portrait 0.6983 / 439 KB) since it
  // passes an explicit `minArea`. This preset does not, and "no override" no
  // longer means "adaptive": `TRACE_DEFAULTS.minArea` is 0 and is spread over
  // every call site below, while the adaptive floor only applies when `minArea`
  // is `undefined`. So the preset now traces with no despeckling at all.
  //
  // What that actually buys, measured:
  //
  //   parrots   0.8340 SSIM / 640 KB   vs old 0.7868 / 262 KB
  //   portrait  0.9127 SSIM / 1366 KB  vs old 0.6983 / 439 KB
  //
  // Quality is far ahead — the point above still holds, and more strongly than
  // the original numbers suggested. But this is a trade, not a clean sweep: it
  // costs 2.4x to 3.1x the bytes. Any claim that it wins "on every axis at
  // once" is false and should not be restored.
  photo: { colors: 48, gradients: true },
  detailed: { colors: 48, minArea: 2, tolerance: 0.3, fitError: 0.3, cornerAngle: 60 },
};

export interface Flatness {
  distinctColors: number;
  capped: boolean;
  /** Horizontal runs per pixel. Near 0 is flat artwork, near 1 is noise. */
  runRatio: number;
  /**
   * Mean absolute deviation from the local mean, measured only AWAY from edges.
   *
   * This is the precondition for sub-pixel refinement, not a content guess.
   * Refinement recovers where an edge fell by inverting the anti-aliasing
   * coverage across it; that inversion assumes the only variation near a
   * boundary IS coverage. Interior noise is variation that is not, and it gets
   * read as edge displacement.
   */
  interiorNoise: number;
}

/**
 * Two cheap signals separate "artwork" from "photograph" reliably:
 * the number of distinct colours, and how often colour changes along a scanline.
 * A screenshot can have thousands of colours yet still be mostly flat; a
 * gradient-heavy photo has both high counts and high run density.
 */
export function measureFlatness(img: RasterImage, colorCap = 4096): Flatness {
  const seen = new Set<number>();
  const d = img.data;
  let runs = 0;
  let capped = false;
  let prev = -1;

  for (let y = 0; y < img.height; y++) {
    prev = -1;
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const a = d[o + 3];
      const key = a === 0 ? 0 : packRgba(d[o], d[o + 1], d[o + 2], a);
      if (key !== prev) { runs++; prev = key; }
      if (!capped) {
        seen.add(key);
        if (seen.size > colorCap) capped = true;
      }
    }
  }

  // Second pass, off the edges: how much does a pixel differ from its own
  // neighbourhood where there is no boundary to explain it? Cheap, and the only
  // thing that predicts whether refinement will help or hurt.
  //
  // Weighted by alpha, because an invisible pixel's RGB is whatever the encoder
  // happened to leave behind and must not vote. The first pass above already
  // decided this — `a === 0 ? 0 : packRgba(...)` — and this pass did not, so the
  // inconsistency sat inside one function.
  //
  // Measured on corpus/src/alpha-dice.png against a copy with the RGB under every
  // alpha-0 pixel zeroed, verified render-identical by compositing both over three
  // backgrounds: interiorNoise 1.1284 as shipped against 0.2474 cleaned, with
  // REFINE_NOISE_LIMIT at 0.3 sitting between them. Two files that draw the same
  // picture were getting different tracer configurations, decided by 323,179
  // pixels nobody can see — and the note printed to the user named a noise figure
  // that was mostly invisible pixels.
  //
  // Opaque artwork is untouched: at a = 255 the weight is exactly 1, so every
  // number this gate was calibrated against still holds.
  const lum = (x: number, y: number): number => {
    const o = ((y * img.width) + x) * 4;
    return ((d[o] + d[o + 1] + d[o + 2]) / 3) * (d[o + 3] / 255);
  };
  let noiseSum = 0;
  let noiseN = 0;
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const gx = lum(x + 1, y) - lum(x - 1, y);
      const gy = lum(x, y + 1) - lum(x, y - 1);
      if (Math.hypot(gx, gy) > 24) continue;   // a real boundary, not interior
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mean += lum(x + dx, y + dy);
      noiseSum += Math.abs(lum(x, y) - mean / 9);
      noiseN++;
    }
  }

  return {
    distinctColors: seen.size,
    capped,
    runRatio: runs / (img.width * img.height),
    interiorNoise: noiseN > 0 ? noiseSum / noiseN : 0,
  };
}

/**
 * Interior noise above which sub-pixel refinement is switched off.
 *
 * Measured, with the same images clean and re-encoded, so the split is not a
 * content guess:
 *
 *   PNG rendered from vector   0.014 - 0.219   refinement worth +3.01 dB at scale
 *   the same at JPEG q40       0.577 - 1.079   refinement costs 0.03-0.10 SSIM
 *   logo-tux.png               0.799           costs 0.058 SSIM
 *   photo-parrots.png          1.583
 *   a 100x100 JPEG sticker     5.061           costs 0.095 SSIM and 3.6x bytes
 *
 * No overlap: the clean set tops out at 0.219 and the noisy set starts at 0.577.
 * 0.3 sits inside that gap and is deliberately nearer the clean end, because the
 * two mistakes are not symmetric — refining clean input that did not need it
 * costs a little size, while refining noisy input costs accuracy AND 3x the
 * bytes.
 *
 * This replaces a genuinely bad rule. Refinement was previously switched off by
 * `flat.capped`, a >4096 colour count, which JPEG noise trips on a cartoon — so
 * the reported image that motivated curves-by-default went back to zero curves.
 * A colour count is a proxy for content; this is the mechanism's own
 * precondition.
 */
export const REFINE_NOISE_LIMIT = 0.3;

// RETUNE ATTEMPTED AND REJECTED, and the reason is a corpus flip worth keeping.
//
// `bench-scale` on its built-in synthetic set says sub-pixel refinement is worth
// 3.91 dB AND 30% fewer bytes (20.87 against 16.96 at 3.902x, 20,180 B against
// 28,690). Since this limit turns refinement off on most real artwork — logo-tux
// measures 0.653, vector-tiger 0.456 — that looked like the limit was costing
// nearly 4 dB on exactly the pictures it was built for, and like it should rise.
//
// It should not. Re-run against three REAL vector sources, each JPEG-compressed at
// six qualities so only noise varies, scored edge-weighted at 3.902x against the
// vector original the tracer never sees:
//
//   subject                noise range   subpixel delta   bytes
//   vector-tiger           1.54 - 2.84   +0.11 to +0.19   2.01x
//   vector-source          0.34 - 1.28   -0.10 to -0.17   1.94x
//   vector-comparison      1.05 - 1.68   -0.11 to -0.15   2.10x
//
// On two of three it is worse on BOTH axes; on the third it buys under 0.2 dB for
// double the bytes. Four synthetic shapes and three real ones answer the same
// question in opposite directions, which is this project's recurring lesson about
// corpus size, arriving again.
//
// The sharper point: the delta does not track noise AT ALL. vector-tiger stays
// positive from 1.54 to 2.84; vector-source stays negative from 0.34 to 1.28. So
// `interiorNoise` does not predict the sign of the trade on this material, and the
// limit is not separating "refinement helps" from "refinement hurts" the way its
// name implies. It happens to land on the conservative side, which is the right
// call, for a reason other than the stated one.
//
// What would justify moving it: a corpus where the delta actually changes sign
// with noise. That has not been found, and until it is, the honest description of
// this constant is "a conservative default that keeps refinement off unless a
// preset asks for it", not "the noise level above which refinement stops paying".

/**
 * The refinement half of `autoTracePreset`, on its own.
 *
 * Split out so an explicitly chosen preset gets the same measured protection that
 * `auto` gets. Deliberately returns ONLY the refine fields — palette choice stays
 * the preset's business, and a preset that names `subpixel` overrides this by
 * spreading after it.
 */
export function refineGateFor(image: RasterImage): { subpixel?: boolean; latticeSimplify?: boolean } {
  const flat = measureFlatness(image);
  if (flat.interiorNoise <= REFINE_NOISE_LIMIT) return {};
  // Both, together. `latticeSimplify` defaults to `!subpixel`, so switching only
  // subpixel off turns simplification ON and costs MORE bytes than leaving it be.
  return { subpixel: false, latticeSimplify: false };
}

// `clean`'s despeckle floor cannot be one constant — swept across 18 real
// subjects, tolerance for it is a property of CONTENT, not size: two
// subjects at the identical 393,216px resolution differ 10x in what
// minArea:60 costs (photo-motorcycles.png, real mechanical detail,
// -0.136 SSIM; photo-parrots.png, -0.014), so nothing below ~2,000,000px
// can safely move off the conservative default without a working content
// signal, which does not exist yet. At or above that size, every subject
// measured — including a real photograph — tolerated minArea:40 for
// <=0.005 SSIM (confirmed visually indistinguishable, not just by the
// number). That directly answers the reported defect: a 14.9-megapixel
// subject where minArea:4 let JPEG/paper-texture noise through as
// thousands of tiny subpaths (curve fraction 62.0%->99.0%, gzip -40%).
// A 100x100 icon with the SAME defect (minArea:4 fragmenting it into 268
// regions, 43% of shared boundaries collapsing to straight 2-point lines)
// is NOT fixed by this — every minArea tested above 4 visually destroyed
// real content on that specific subject. That is `fitOpen`'s 2-point
// segments only ever being able to express a line, not a despeckle-floor
// problem, and belongs to a separate investigation.
export function cleanMinArea(width: number, height: number): number {
  return width * height >= 2_000_000 ? 40 : 4;
}
