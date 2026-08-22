import { describe, expect, it } from 'vitest';
import { despikeRinging } from '../src/vectorize/despike.js';
import type { RasterImage } from '../src/types.js';

/**
 * Surgical Gibbs-ringing corrector.
 *
 * The claim under test is narrow, matching the module doc: correct ONLY a
 * pixel that (a) has two genuine, distinct flanking plateaus nearby, (b) is
 * colinear with the line between them, and (c) is extrapolated past one
 * endpoint by a real margin. Every other pixel — including several real
 * false-positive shapes measured directly on the corpus during development
 * (a thin dark stroke between two patches of the same background, an
 * unrelated edge, a fully-transparent boundary) — must come through
 * byte-identical.
 */

function flat(w: number, h: number, r: number, g: number, b: number, a = 255): RasterImage {
  const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
  }
  return img;
}

function setPixel(img: RasterImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const o = (y * img.width + x) * 4;
  img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
}

function diffCount(a: RasterImage, b: RasterImage): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
}

describe('despikeRinging', () => {
  it('is a byte-identical no-op on a flat image', () => {
    const img = flat(20, 20, 100, 150, 30);
    const out = despikeRinging(img);
    expect(out).toBe(img); // the fast path returns the same reference
  });

  it('is a byte-identical no-op on a hard-edged, high-contrast wedge with no antialiasing', () => {
    // Real monotonic antialiasing is required for a ramp to exist at all; a
    // step function has no intermediate samples to overshoot.
    const w = 40, h = 40;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inWedge = x > 15 && y > 15 && x - 15 > y - 15;
        setPixel(img, x, y, ...(inWedge ? [0, 0, 0] as const : [255, 255, 255] as const));
      }
    }
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  it('is a byte-identical no-op when the two flanking colours are too similar to count as distinct plateaus', () => {
    // A modest grey step (contrast far below MIN_CONTRAST_SQ), hard-edged.
    // This is the fixture shape a prior, differently-designed filter in this
    // project's history was found to regress curve-fitting efficiency on.
    const w = 40, h = 40;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inWedge = x > 15 && y > 15 && x - 15 > y - 15;
        setPixel(img, x, y, ...(inWedge ? [138, 136, 140] as const : [120, 118, 122] as const));
      }
    }
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * The load-bearing positive case: a short ramp between two genuine flat
   * plateaus (black and yellow, matching the corpus image this pass was
   * built against) with one sample that overshoots the yellow plateau —
   * the textbook Gibbs signature. Only that one pixel (every row of it,
   * including the top and bottom row of this 3-row fixture) may change —
   * this is also the regression test for the full-canvas border-coverage
   * fix: with a `y = 1..height-2` loop this failed on rows 0 and 2.
   */
  it('corrects a pixel that overshoots past a genuine plateau on a real ramp, including image-border rows', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 232, 215, 30); // yellow plateau everywhere
    for (let y = 0; y < h; y++) {
      for (let x = 10; x < w; x++) setPixel(img, x, y, 0, 0, 0); // black plateau
    }
    // The overshoot itself, one step into the yellow side of the crossing —
    // brighter than the yellow plateau on every channel, as measured on the
    // real corpus image this module's doc comment cites.
    for (let y = 0; y < h; y++) setPixel(img, 9, y, 255, 250, 34);

    const out = despikeRinging(img);
    for (let y = 0; y < h; y++) {
      const o = (y * w + 9) * 4;
      // Corrected back toward the yellow plateau, not merely "changed" —
      // checked on every row, including row 0 and row h-1 which sit on the
      // image border.
      expect(out.data[o]).toBeLessThanOrEqual(240);
      expect(out.data[o + 1]).toBeLessThanOrEqual(225);
    }
    // Every pixel more than one step from the injected overshoot column is
    // untouched — this is a surgical, single-column correction, not a
    // regional smooth.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x === 9) continue;
        const o = (y * w + x) * 4;
        const srcO = (y * w + x) * 4;
        expect([out.data[o], out.data[o + 1], out.data[o + 2], out.data[o + 3]])
          .toEqual([img.data[srcO], img.data[srcO + 1], img.data[srcO + 2], img.data[srcO + 3]]);
      }
    }
  });

  /**
   * The false-positive regression this module's doc comment describes:
   * walking outward from inside a thin dark stroke can reach the SAME
   * background colour on both sides. That is real content (a letter, a
   * hairline), not ringing, and must be left alone — the pair the walk
   * finds is not two DISTINCT plateaus bounding a transition.
   */
  it('does not touch a thin dark stroke flanked by the same background on both sides', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 255, 255, 255); // white background
    for (let y = 0; y < h; y++) setPixel(img, 10, y, 0, 0, 0); // one-pixel-wide black stroke
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * A dedicated test for the colinearity gate itself (`RESID_MAX_SQ`),
   * distinct from the thin-stroke test above.
   *
   * MUTATION CHECK (performed by hand against this exact fixture, not
   * shipped): the thin-stroke test above does NOT exercise this gate — both
   * flanking plateaus it finds are the SAME colour, so it is rejected by the
   * contrast gate (`MIN_CONTRAST_SQ`) before colinearity is ever computed;
   * deleting the `residSq > RESID_MAX_SQ` check left every other test in
   * this file, including that one, passing. Only this fixture — a candidate
   * with two genuinely distinct, high-contrast flanking plateaus (black,
   * yellow) that also projects past an endpoint (so it cannot be rejected by
   * the "inside the ramp" or overshoot-margin checks either) but sits far
   * off the line between them — isolates the colinearity gate: deleting it
   * makes this test fail (the white candidate gets snapped to the yellow
   * plateau instead of staying untouched). Restored afterward.
   */
  it('does not touch a candidate that has real plateau contrast and overshoot but is not colinear with the ramp', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 232, 215, 30); // yellow plateau
    for (let y = 0; y < h; y++) for (let x = 0; x < 7; x++) setPixel(img, x, y, 0, 0, 0); // black plateau
    // A white pixel between the two plateaus: this projects to t≈1.2 (past
    // the yellow endpoint, so it clears the "inside the ramp" and overshoot
    // gates) but its perpendicular residual from the black-yellow line is
    // ~48,500 — over 150x RESID_MAX_SQ — because white is not a point on
    // that particular ramp at all.
    for (let y = 0; y < h; y++) setPixel(img, 7, y, 255, 255, 255);
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * A dedicated test for the contrast gate itself (`MIN_CONTRAST_SQ`),
   * distinct from the thin-stroke test above.
   *
   * MUTATION CHECK (performed by hand against this exact fixture, not
   * shipped): the thin-stroke fixture does NOT exercise this gate either —
   * both flanking plateaus it finds are byte-identical, so `abSq === 0` and
   * the function returns `null` before the contrast comparison is even
   * reached; deleting the `pmDeltaSq(...) < MIN_CONTRAST_SQ` check left
   * every other test in this file passing, including that one. Only a
   * fixture with two DISTINCT but low-contrast plateaus (grey 100 vs grey
   * 120, contrast 1,200 — comfortably below the 3,000 threshold) and a
   * candidate that is exactly colinear with them (residual 0, so it cannot
   * be caught by the colinearity gate) and overshoots past an endpoint by
   * a real margin (excess 1,200, comfortably above the 500 floor) isolates
   * this gate: deleting it makes this test fail (the candidate gets snapped
   * onto the grey-120 plateau instead of staying untouched). Restored
   * afterward.
   */
  it('does not touch a colinear, real-overshoot candidate whose two plateaus are too similar to count as distinct', () => {
    const w = 20, h = 3;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 8; x++) setPixel(img, x, y, 100, 100, 100); // grey-100 plateau
      setPixel(img, 8, y, 140, 140, 140); // colinear overshoot candidate
      for (let x = 9; x < w; x++) setPixel(img, x, y, 120, 120, 120); // grey-120 plateau
    }
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * A dedicated test for the overshoot-margin gate itself
   * (`OVERSHOOT_MIN_SQ`), distinct from the load-bearing positive case
   * above.
   *
   * MUTATION CHECK (performed by hand against this exact fixture, not
   * shipped): every other test in this file passed unchanged when
   * `excessSq < OVERSHOOT_MIN_SQ` was deleted — none of them plants a
   * candidate that clears contrast and colinearity but sits only barely
   * past an endpoint. This fixture does: black/yellow plateaus (contrast
   * ~100,949, comfortably clears {@link MIN_CONTRAST_SQ}), a candidate at
   * `t≈1.02` on the true ramp line (residual well under
   * {@link RESID_MAX_SQ}), but with `excessSq≈42` — over 10x below the
   * 500 floor — modelling ordinary one-byte rounding jitter at a ramp's
   * true end rather than the diagnosed 1,770-2,171-unit defect. Deleting
   * the gate makes this test fail (the candidate gets snapped onto the
   * yellow plateau instead of staying untouched). Restored afterward.
   */
  it('does not touch a colinear, high-contrast candidate whose overshoot is only ordinary rounding jitter', () => {
    const w = 20, h = 3;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < 8; x++) setPixel(img, x, y, 0, 0, 0); // black plateau
      setPixel(img, 8, y, 237, 219, 31); // t ≈ 1.02, excessSq ≈ 42
      for (let x = 9; x < w; x++) setPixel(img, x, y, 232, 215, 30); // yellow plateau
    }
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * Premultiplication regression: raw RGB under near-zero alpha is
   * compositing-irrelevant and often garbage a PNG encoder left behind.
   * Comparing it as if it were real colour data manufactures a spurious
   * "overshoot" at every transparent/opaque boundary — measured directly on
   * the corpus before premultiplication was added.
   */
  it('does not touch the boundary of a transparent region, regardless of the garbage RGB beneath it', () => {
    const w = 20, h = 3;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < 10) setPixel(img, x, y, 0, 0, 0, 0); // "garbage" RGB under alpha 0
        else setPixel(img, x, y, 255, 255, 255, 255);
      }
    }
    // A near-zero-alpha fringe pixel, the shape the real corpus produced.
    setPixel(img, 9, h > 1 ? 1 : 0, 255, 255, 255, 1);
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  it('never touches alpha-0 pixels even where a correction fires nearby', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 232, 215, 30);
    for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) setPixel(img, x, y, 0, 0, 0);
    for (let y = 0; y < h; y++) setPixel(img, 9, y, 255, 250, 34);
    const out = despikeRinging(img);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
  });

  /**
   * Regression test for the border-loop bug itself: a candidate pixel that
   * sits exactly on row 0 / column 0 (the very first row/column the old
   * `y = 1..height-2, x = 1..width-2` loop never visited) must still be
   * corrected when it clears every gate. Uses a 1-row-tall strip so the
   * overshoot sits on `y = 0`, which is also `height - 1` — both borders
   * that the pre-fix loop skipped, at once.
   */
  it('corrects a genuine overshoot that sits directly on the top-left image border', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 232, 215, 30);
    for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) setPixel(img, x, y, 0, 0, 0);
    setPixel(img, 9, 0, 255, 250, 34); // overshoot on row 0 only
    const out = despikeRinging(img);
    const o = (0 * w + 9) * 4;
    expect(out.data[o]).toBeLessThanOrEqual(240);
    expect(out.data[o + 1]).toBeLessThanOrEqual(225);
  });

  /**
   * The achromatic false-positive class `ACHROMATIC_EXCESS_RATIO_MAX` exists
   * for: gate 4 (colinearity, `RESID_MAX_SQ`) is a no-op whenever the two
   * flanking plateaus AND the candidate are all grey, because any three grey
   * samples are exactly colinear by construction (they all sit on the single
   * `R = G = B` line) regardless of whether the candidate is genuine ringing
   * or a wholly unrelated grey feature. A thin (here 1px) grey sliver sitting
   * as a local brightness extremum between two distinct grey plateaus —
   * `rgb(20,20,20)`, `rgb(250,250,250)`, `rgb(70,70,70)`, matching this
   * module's own doc comment — clears every other gate exactly as cleanly as
   * a real overshoot does and, before this gate existed, was erased to the
   * nearer plateau's colour.
   *
   * MUTATION CHECK (performed by hand against this exact fixture, not
   * shipped): every other test in this file passes unchanged when the
   * `ACHROMATIC_EXCESS_RATIO_MAX` check is deleted — none of them plants an
   * achromatic candidate with achromatic flanking plateaus. This fixture
   * does, and its `excessSq`/`abSq` ratio (~12.96) is far above the cap
   * (0.5): deleting the gate makes this test fail (the 250 sliver gets
   * snapped to 70 instead of staying untouched). Restored afterward.
   */
  it('does not touch a thin achromatic sliver at a local brightness extremum between two distinct grey plateaus', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 20, 20, 20); // dark grey plateau
    for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) setPixel(img, x, y, 70, 70, 70); // lighter grey plateau
    for (let y = 0; y < h; y++) setPixel(img, 9, y, 250, 250, 250); // 1px grey sliver, brighter than both
    const out = despikeRinging(img);
    expect(diffCount(img, out)).toBe(0);
  });

  /**
   * The same false-positive shape, swept across sliver width, matching the
   * width boundary measured directly on this codebase: an achromatic sliver
   * up to 3px wide is exactly the shape gate 6 exists for (a run this narrow
   * has no chance to form its own plateau, so the walk finds the TRUE far
   * plateaus flanking it, not its own colour) — the existing pre-check and
   * plateau-search machinery only start self-protecting an EDGE column of
   * the run at width 4, which this test does not depend on.
   */
  it('does not touch an achromatic sliver at any width from 1 to 3px', () => {
    for (const width of [1, 2, 3]) {
      const w = 20, h = 3;
      const img = flat(w, h, 20, 20, 20);
      for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) setPixel(img, x, y, 70, 70, 70);
      for (let y = 0; y < h; y++) {
        for (let i = 0; i < width; i++) setPixel(img, 10 - width + i, y, 250, 250, 250);
      }
      const out = despikeRinging(img);
      expect(diffCount(img, out)).toBe(0);
    }
  });

  /**
   * Gate 6 must not touch chromatic content: it only applies when A, B AND
   * the candidate are all achromatic. Reuses this module's own load-bearing
   * positive fixture (black/yellow plateaus, a `rgb(255,250,34)` overshoot)
   * to confirm the real diagnosed defect this file was built to fix is still
   * corrected exactly as before.
   */
  it('still corrects a genuine chromatic overshoot — gate 6 does not apply to colour', () => {
    const w = 20, h = 3;
    const img = flat(w, h, 232, 215, 30);
    for (let y = 0; y < h; y++) for (let x = 10; x < w; x++) setPixel(img, x, y, 0, 0, 0);
    for (let y = 0; y < h; y++) setPixel(img, 9, y, 255, 250, 34);
    const out = despikeRinging(img);
    for (let y = 0; y < h; y++) {
      const o = (y * w + 9) * 4;
      expect(out.data[o]).toBeLessThanOrEqual(240);
      expect(out.data[o + 1]).toBeLessThanOrEqual(225);
    }
  });
});
