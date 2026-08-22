import type { RasterImage } from '../types.js';

/**
 * A surgical corrector for a Gibbs-ringing / resize-sharpening OVERSHOOT
 * signature in the raw source, run once, before ANY of classification —
 * `collapseFringeAlpha`, `quantize`, `connectedComponents` all read this
 * pass's output, not the untouched source.
 *
 * **Why upstream of classification, when `refine-source.ts` already denoises
 * for measurement.** That pass (see its own doc comment) hands `refineLoop`/
 * `refineOpenArc` a cleaner copy of the source to SAMPLE, but only after a
 * boundary's LATTICE position has already been decided by `quantize`/
 * `connectedComponents` against the untouched pixels. On
 * `yoyokd14-calm-7149117_1920.png`'s cyclist silhouette that is provably not
 * where the defect lives: a per-point displacement probe on the real
 * pipeline found the raw coverage-projection signal itself has stdev 0.568
 * against a possible range of about 1, with ~13% of consecutive points
 * flipping the SIGN of their displacement. That is per-pixel noise baked into
 * the raster the whole pipeline reads, not a geometric correction being
 * clipped downstream, and no amount of measurement-side smoothing recovers
 * information that was never captured cleanly at the pixel level.
 *
 * **The specific, measured signature.** A short (2-3px) transition on this
 * exact edge contains a pixel BRIGHTER than either true plateau — e.g. a
 * `rgb(255,250,34)` sample sitting between a `rgb(232,215,30)` fill and
 * black, one raw sample away from the crossing. That is the textbook
 * Gibbs-phenomenon overshoot: on a genuine antialiasing ramp between two flat
 * colours, every intermediate sample lies ON the segment between them
 * (monotonic coverage blending can only interpolate, never overshoot); this
 * pixel sits PAST one end of that segment, continuing the same linear trend
 * too far.
 *
 * **The correction is that literal geometric test, not a per-channel box
 * clamp.** An early prototype flagged any pixel outside the per-channel
 * `[min(A,B), max(A,B)]` box and measured two real false-positive classes on
 * this exact image before the colinearity gate below was added:
 *
 *  - A pixel deep inside a thin dark stroke (a letter in "KEEP CALM") can
 *    read as "outside the range" of two plateaus found by walking outward in
 *    an axis that happens to exit the SAME stroke on both sides into the
 *    background — the stroke itself is real content, not ringing, but a
 *    per-channel box test cannot see the difference.
 *  - A pixel on an unrelated boundary (grey shading against a yellow fill
 *    elsewhere in the same image) failed a per-channel box test in exactly
 *    one channel because it belongs to a DIFFERENT local transition than the
 *    plateau pair the walk happened to find, not because it overshoots the
 *    pair it was compared against.
 *
 * Both are rejected by requiring the candidate to be genuinely COLINEAR with
 * the `A -> B` segment (a small perpendicular residual) before checking
 * whether it is extrapolated past an endpoint — real ringing sits almost
 * exactly on the line the true edge already draws, just too far along it; a
 * pixel that belongs to some other local structure does not. Measured
 * directly on this image: the true overshoot at `(1148, 697)` has a
 * colinearity residual of ~101 (squared, combined channels) against an A-B
 * separation of ~100,949; the thin-stroke false positive measured ~2,198 —
 * over 20x larger — against a similar-scale separation. See
 * {@link RESID_MAX_SQ}.
 *
 * **Two flanking plateaus, not one fixed reach.** For each of 4 axes
 * (horizontal, vertical, both diagonals) through a candidate pixel, this
 * walks outward in both directions looking for a run of 3 mutually-close
 * samples — not 2, because a slowly-varying real ramp can have one locally
 * flat DERIVATIVE sample by coincidence, and a single stable pair cannot
 * tell that apart from a genuine plateau; a second consecutive stable delta
 * can. See {@link walkToPlateau}.
 *
 * **Provably narrow.** Every gate below is a precondition, evaluated on the
 * untouched source, and any one failing leaves the pixel byte-identical to
 * the input:
 *
 *  1. A cheap 8-neighbour equality pre-check skips any pixel that already
 *     matches its whole (in-bounds) neighbourhood — flat interior, the
 *     overwhelming majority of most images, costs one comparison per pixel.
 *  2. Both directions along an axis must resolve to a genuine plateau within
 *     {@link DESPIKE_MAX_REACH} steps — a real gradient background (no flat
 *     colour to find) or a region edge closer than that never enters the
 *     rest of the test at all.
 *  3. The two plateaus must be meaningfully different colours
 *     ({@link MIN_CONTRAST_SQ}) — two samples of the SAME background either
 *     side of a real, distinct feature (a stroke, a dot) is not "two
 *     plateaus bounding a transition", and is rejected before any geometry
 *     is computed.
 *  4. The candidate must be genuinely colinear with those two plateaus
 *     ({@link RESID_MAX_SQ}).
 *  5. The candidate's projection onto that line must fall PAST an endpoint,
 *     by more than a noise floor ({@link OVERSHOOT_MIN_SQ}).
 *
 * A pixel that clears all five is corrected by projecting it back onto the
 * segment — clamping its interpolation parameter to `[0, 1]` — using
 * whichever of the (up to 4) axes measured the largest overshoot. Every
 * other pixel is copied through unchanged, byte for byte; this function
 * never allocates a modified colour for a pixel that did not clear every
 * gate.
 *
 * **What this cannot do.** It cannot merge or split a region: two pixels
 * that were on opposite sides of a real, high-contrast colour step stay on
 * opposite sides, because a genuinely different colour is either accepted
 * as one of the two plateaus (leaving both endpoints exactly where they
 * were) or fails the colinearity/overshoot gates and is left untouched. It
 * cannot invent a boundary where none exists: the walk that finds "two
 * plateaus" requires an actual contrast step nearby (gate 3), so a uniform
 * region can never manufacture a spurious pair to be corrected against.
 *
 * **Full-canvas coverage, including the 1px border.** The candidate loop
 * visits every pixel, `(0,0)` through `(width-1,height-1)` inclusive; the
 * plateau walk ({@link walkToPlateau}) already bounds-checks and returns
 * `-1` for a direction that runs off the image before finding a plateau, so
 * a border pixel simply fails gate 2 on any axis that needs an out-of-range
 * neighbour — it is never a crash or an out-of-bounds read, only a pixel
 * with fewer usable axes to test.
 */

/** Premultiplied-RGB + alpha squared distance between two pixels' raw bytes.
 * Premultiplying keeps a fully- or near-fully-transparent pixel's colour from
 * contributing: raw RGB under alpha 0 is compositing-irrelevant and often
 * garbage a PNG encoder left behind, and comparing it as if it carried real
 * signal manufactures "edges" that were never visible. A transparent pixel's
 * premultiplied channel is always ~0 regardless of its raw byte value, which
 * is what removes that whole false-positive class rather than special-casing
 * it. */
function pmDeltaSq(data: Uint8ClampedArray, offA: number, offB: number): number {
  const aa = data[offA + 3]! / 255, ba = data[offB + 3]! / 255;
  const dr = data[offA]! * aa - data[offB]! * ba;
  const dg = data[offA + 1]! * aa - data[offB + 1]! * ba;
  const db = data[offA + 2]! * aa - data[offB + 2]! * ba;
  const da = data[offA + 3]! - data[offB + 3]!;
  return dr * dr + dg * dg + db * db + da * da;
}

/**
 * How far a plateau search may walk before giving up. Deliberately much
 * smaller than `subpixel.ts`'s `MAX_PLATEAU_REACH` (12): that walk is bounded
 * by a known region label and can safely search further, but this pass runs
 * BEFORE classification exists, so nothing stops a longer walk from crossing
 * clean through a thin real feature (a hairline stroke, a serif) and finding
 * the WRONG pair of plateaus either side of it. The diagnosed overshoot
 * resolves within 2-3px; 6 leaves that a wide margin without inviting a walk
 * to cross a stroke thicker than a couple of pixels.
 */
const DESPIKE_MAX_REACH = 6;

/**
 * Two consecutive samples this close (premultiplied, summed squared channel
 * delta) count as "no more ramp here". Same units and same value as
 * `subpixel.ts`'s `PLATEAU_EPS_SQ`, chosen there above the ~2-per-channel
 * jitter measured between neighbouring same-region pixels on real corpus
 * photos.
 */
const EPS_SQ = 16;

/**
 * The two flanking plateaus found either side of a candidate must differ by
 * at least this much (premultiplied, summed squared channel delta) before
 * they are treated as a real transition worth checking a pixel against.
 *
 * Rejects the case measured directly on `yoyokd14`'s "KEEP CALM" text: a
 * black letter-stroke pixel, walked outward on an axis that exits the SAME
 * stroke on both sides, finds white background as BOTH "A" and "B" —
 * contrast ~0, not two distinct plateaus. 3,000 sits comfortably above
 * ordinary compression/dithering contrast between adjacent shades (tens to
 * low hundreds in these units) and comfortably below a real colour step
 * (measured 56,691 on a soft white/teal edge and ~100,000 on the black/
 * yellow edge this pass targets).
 */
const MIN_CONTRAST_SQ = 3000;

/**
 * Squared perpendicular distance (premultiplied 4-channel) a candidate may
 * sit from the A-B line and still be treated as "the same ramp, extrapolated
 * too far" rather than "a different local feature that happens to fail a
 * per-channel box test".
 *
 * Measured directly on `yoyokd14`: the true overshoot at `(1148, 697)` has
 * a residual of ~101 against an A-B separation of ~100,949 (about 0.1%); a
 * false-positive candidate found by an earlier per-channel-only prototype —
 * a grey shading pixel compared against an unrelated black/yellow plateau
 * pair reached by the walk — measured ~2,198, over 20x larger, at a
 * comparable separation. 300 sits between the two with real margin on both
 * sides.
 */
const RESID_MAX_SQ = 300;

/**
 * How far past an endpoint (squared, in the same "distance along the A-B
 * line" units as the contrast/residual constants above) a candidate must
 * project before it is worth correcting at all. Filters ordinary one- or
 * two-byte jitter at a ramp's true end from being treated as an overshoot;
 * the diagnosed defect measures 1,770-2,171 in these units at its worst
 * points on this image, well clear of this floor.
 */
const OVERSHOOT_MIN_SQ = 500;

const DESPIKE_DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [0, 1], [1, 1], [1, -1],
];

/**
 * Walk outward from `(x0, y0)` in direction `(dx, dy)`, NOT including
 * `(x0, y0)` itself, looking for the first run of three mutually-close
 * samples — two consecutive stable deltas, not one. A single stable pair is
 * not enough: a slowly-varying real ramp can have one locally flat
 * derivative sample by coincidence (this was measured to false-positive on a
 * shallow, near-tangent antialiased curve on this exact corpus image before
 * the second consecutive delta was required). Returns the offset of the
 * nearest sample of that trio (closest to the candidate), or -1 if no such
 * run is found within {@link DESPIKE_MAX_REACH} steps or the walk leaves the
 * image.
 *
 * Deliberately excludes the candidate pixel from every comparison: including
 * it (as `subpixel.ts`'s `findPlateau` does, correctly, for its own
 * different purpose — see that function's doc comment) would let a
 * genuinely spiking pixel bias the very walk meant to find a plateau
 * independent of it.
 */
function walkToPlateau(
  data: Uint8ClampedArray, width: number, height: number,
  x0: number, y0: number, dx: number, dy: number,
): number {
  const offs: number[] = [];
  for (let step = 1; step <= DESPIKE_MAX_REACH + 2; step++) {
    const x = x0 + dx * step, y = y0 + dy * step;
    if (x < 0 || y < 0 || x >= width || y >= height) break;
    offs.push((y * width + x) * 4);
  }
  for (let i = 0; i + 2 < offs.length; i++) {
    if (
      pmDeltaSq(data, offs[i]!, offs[i + 1]!) <= EPS_SQ &&
      pmDeltaSq(data, offs[i + 1]!, offs[i + 2]!) <= EPS_SQ
    ) {
      return offs[i]!;
    }
  }
  return -1;
}

interface AxisResult {
  excessSq: number;
  /** Corrected RGBA for this pixel, already unpremultiplied and clamped. */
  r: number; g: number; b: number; a: number;
}

const A4 = new Float64Array(4);
const B4 = new Float64Array(4);
const P4 = new Float64Array(4);
const AB4 = new Float64Array(4);

function premultiply(data: Uint8ClampedArray, off: number, out: Float64Array): void {
  const a = data[off + 3]!;
  out[0] = data[off]! * a / 255;
  out[1] = data[off + 1]! * a / 255;
  out[2] = data[off + 2]! * a / 255;
  out[3] = a;
}

/** Evaluate one axis through a candidate pixel; `null` if any gate fails. */
function evalAxis(
  data: Uint8ClampedArray, width: number, height: number,
  x: number, y: number, dx: number, dy: number,
): AxisResult | null {
  const offA = walkToPlateau(data, width, height, x, y, -dx, -dy);
  const offB = walkToPlateau(data, width, height, x, y, dx, dy);
  if (offA < 0 || offB < 0) return null;
  if (pmDeltaSq(data, offA, offB) < MIN_CONTRAST_SQ) return null;

  premultiply(data, offA, A4);
  premultiply(data, offB, B4);
  const p = (y * width + x) * 4;
  premultiply(data, p, P4);
  let dot = 0, abSq = 0;
  for (let c = 0; c < 4; c++) {
    AB4[c] = B4[c]! - A4[c]!;
    dot += (P4[c]! - A4[c]!) * AB4[c]!;
    abSq += AB4[c]! * AB4[c]!;
  }
  if (abSq === 0) return null;
  const t = dot / abSq;
  if (t >= 0 && t <= 1) return null; // inside the ramp: not an overshoot

  let residSq = 0;
  for (let c = 0; c < 4; c++) {
    const proj = A4[c]! + t * AB4[c]!;
    const d = P4[c]! - proj;
    residSq += d * d;
  }
  if (residSq > RESID_MAX_SQ) return null;

  const excessAlong = t < 0 ? -t * Math.sqrt(abSq) : (t - 1) * Math.sqrt(abSq);
  const excessSq = excessAlong * excessAlong;
  if (excessSq < OVERSHOOT_MIN_SQ) return null;

  const tc = t < 0 ? 0 : 1;
  const ca = A4[3]! + tc * AB4[3]!;
  if (ca <= 0) return { excessSq, r: 0, g: 0, b: 0, a: 0 };
  const cr = A4[0]! + tc * AB4[0]!;
  const cg = A4[1]! + tc * AB4[1]!;
  const cb = A4[2]! + tc * AB4[2]!;
  return { excessSq, r: (cr * 255) / ca, g: (cg * 255) / ca, b: (cb * 255) / ca, a: ca };
}

/**
 * Whether every IN-BOUNDS neighbour of `(x, y)` (up to 8; fewer at a canvas
 * edge/corner) is byte-identical to it — a cheap necessary precondition for
 * skipping the walk entirely. If every neighbour that exists already
 * matches, any axis through this pixel would find `A === B === P` (or fail
 * the contrast gate outright) wherever that axis's neighbours are the ones
 * checked here, so the full test could only ever return "no correction" for
 * those axes; the remaining axes still get the full walk. An out-of-range
 * neighbour is simply skipped, never read: this must stay bounds-safe since
 * the candidate loop now visits the full canvas, border included.
 */
function matchesWholeNeighbourhood(
  data: Uint8ClampedArray, width: number, height: number, p: number, x: number, y: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = (ny * width + nx) * 4;
      if (
        data[n] !== data[p] || data[n + 1] !== data[p + 1] ||
        data[n + 2] !== data[p + 2] || data[n + 3] !== data[p + 3]
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Correct the Gibbs-ringing overshoot signature described in this module's
 * doc comment, everywhere it is found in `img`, before any classification
 * reads the raster. Pixels that do not clear every gate above are copied
 * through byte-identical; only a flagged pixel's own 4 bytes are ever
 * rewritten, and it is corrected using whichever axis measured the strongest
 * evidence (largest {@link AxisResult.excessSq}).
 *
 * Visits the FULL canvas, `(0,0)` through `(width-1,height-1)` inclusive —
 * a pixel on the 1px border is not skipped. `walkToPlateau` already
 * bounds-checks and degrades to "no plateau found" for a direction that runs
 * off-image, and `matchesWholeNeighbourhood` only ever reads in-bounds
 * neighbours, so nothing here reads past the array.
 */
export function despikeRinging(img: RasterImage): RasterImage {
  const { width, height, data } = img;
  if (width < 3 || height < 3) return img;

  let touched = false;
  const out = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (matchesWholeNeighbourhood(data, width, height, p, x, y)) continue;

      let best: AxisResult | null = null;
      for (const [dx, dy] of DESPIKE_DIRS) {
        const r = evalAxis(data, width, height, x, y, dx, dy);
        if (r && (!best || r.excessSq > best.excessSq)) best = r;
      }
      if (best) {
        touched = true;
        out[p] = best.r; out[p + 1] = best.g; out[p + 2] = best.b; out[p + 3] = best.a;
      }
    }
  }

  return touched ? { width, height, data: out } : img;
}
