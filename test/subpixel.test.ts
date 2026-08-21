import { describe, expect, it } from 'vitest';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents, type Loop } from '../src/vectorize/contour.js';
import {
  refineLoop, refineOpenArc, cornerCuts, smoothVertexDisplacements,
} from '../src/vectorize/subpixel.js';
import { fitLoop } from '../src/vectorize/fit.js';
import type { RasterImage } from '../src/types.js';

/**
 * Sub-pixel edge extraction.
 *
 * The claim under test is narrow and checkable: coverage in the boundary pixels
 * says where the edge actually fell, and the estimator recovers it. So the tests
 * are built around edges whose true position is *known by construction* rather
 * than around whether some output looks better.
 */

/**
 * A field split by a vertical edge at a known sub-pixel x.
 *
 * The region (black) is `x < edgeX`. Pixel column k spans [k, k+1], so its
 * coverage by the region is `clamp(edgeX - k, 0, 1)` — which is exactly what an
 * antialiasing rasteriser would produce, and exactly what the estimator has to
 * invert.
 */
function verticalEdge(w: number, h: number, edgeX: number): RasterImage {
  const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const coverage = Math.min(1, Math.max(0, edgeX - x));
      const v = Math.round(255 * (1 - coverage));
      const o = (y * w + x) * 4;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  return img;
}

/** Classify by the nearer of the two pure colours — the quantiser's decision. */
function classifyDark(img: RasterImage): Int32Array {
  const classes = new Int32Array(img.width * img.height);
  for (let i = 0; i < classes.length; i++) classes[i] = img.data[i * 4] < 128 ? 1 : 0;
  return classes;
}

/** The outer boundary of class 1, or null when there is none. */
function outerLoop(img: RasterImage, classes: Int32Array): Loop | null {
  const comps = connectedComponents(classes, img.width, img.height, -1);
  const all = traceComponents(comps.labels, img.width, img.height, comps.count);
  for (let c = 0; c < comps.count; c++) {
    if (comps.classes[c] !== 1) continue;
    for (const loop of all[c] ?? []) if (loop.signedArea > 0) return loop;
  }
  return null;
}

describe('refineLoop', () => {
  // Positions either side of the half-pixel mark, so the crack boundary lands on
  // both sides of the true edge and the estimator has to correct in both
  // directions — not only shrink.
  const POSITIONS = [3, 3.15, 3.3, 3.5, 3.7, 3.85, 4, 4.4];

  it.each(POSITIONS)('recovers a vertical edge at x=%s to within 0.01px', (edgeX) => {
    const img = verticalEdge(12, 6, edgeX);
    const classes = classifyDark(img);
    const loop = outerLoop(img, classes)!;
    expect(loop).not.toBeNull();

    const refined = refineLoop(loop, img, classes, 1);
    const xs: number[] = [];
    for (let i = 0; i < refined.pts.length; i += 2) xs.push(refined.pts[i]);
    // The right-hand extreme of the boundary is the edge under test.
    expect(Math.max(...xs)).toBeCloseTo(edgeX, 2);
  });

  it('corrects the crack boundary in both directions', () => {
    // At 3.7 the quantiser rounds the boundary pixel into the region, so the
    // crack sits at 4 — *past* the true edge. Refinement has to pull it back, not
    // only push it out, which a one-sided estimator would fail.
    const img = verticalEdge(12, 6, 3.7);
    const classes = classifyDark(img);
    const loop = outerLoop(img, classes)!;
    const crackMax = Math.max(...Array.from(loop.pts).filter((_, i) => i % 2 === 0));
    expect(crackMax).toBe(4);

    const refined = refineLoop(loop, img, classes, 1);
    const xs: number[] = [];
    for (let i = 0; i < refined.pts.length; i += 2) xs.push(refined.pts[i]);
    expect(Math.max(...xs)).toBeLessThan(crackMax);
    expect(Math.max(...xs)).toBeCloseTo(3.7, 2);
  });

  /**
   * The shipping gate.
   *
   * With no anti-aliasing the inside pixel is fully covered and the outside pixel
   * not at all, so the displacement is exactly zero. Pixel art and sprites must
   * come through untouched — their lattice vertices are already the exact answer,
   * and "improving" them would be a regression, not a gain.
   */
  it('leaves a hard-edged sprite exactly where it was', () => {
    const w = 14, h = 14;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const classes = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // A plus sign: outer corners, inner concave corners, and no soft pixel.
        const inside = (x >= 5 && x < 9) || (y >= 5 && y < 9);
        const o = (y * w + x) * 4;
        const v = inside ? 0 : 255;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
        classes[y * w + x] = inside ? 1 : 0;
      }
    }

    const loop = outerLoop(img, classes)!;
    const refined = refineLoop(loop, img, classes, 1);
    expect(refined.moved).toBe(0);
    for (let i = 0; i < refined.pts.length; i++) {
      expect(Number.isInteger(refined.pts[i])).toBe(true);
    }
    // Densification must preserve the shape, so the densified vertices are the
    // original ones plus the collinear points between them.
    for (let i = 0; i < loop.pts.length; i += 2) {
      let found = false;
      for (let j = 0; j < refined.pts.length; j += 2) {
        if (refined.pts[j] === loop.pts[i] && refined.pts[j + 1] === loop.pts[i + 1]) { found = true; break; }
      }
      expect(found, `original vertex ${loop.pts[i]},${loop.pts[i + 1]} missing`).toBe(true);
    }
  });

  /**
   * A region touching the frame has no outside pixel to measure.
   *
   * The first version read past the image, so `data[negative]` came back
   * `undefined`, and the resulting NaN propagated into the vertex and then into
   * both its neighbours through the corner averaging. Every coordinate here must
   * be finite.
   */
  it('produces no NaN when the region touches every frame edge', () => {
    const w = 10, h = 10;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const classes = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255;
      classes[i] = 1; // the region is the whole canvas
    }
    const loop = outerLoop(img, classes)!;
    const refined = refineLoop(loop, img, classes, 1);
    for (let i = 0; i < refined.pts.length; i++) {
      expect(Number.isFinite(refined.pts[i]), `index ${i} is not finite`).toBe(true);
    }
    // Nothing measurable, so nothing should have moved.
    expect(refined.moved).toBe(0);
  });

  it('refuses to move a boundary between two indistinguishable colours', () => {
    // This test used to use a HARD edge one level apart, 128 | 129, and it passed
    // with `MIN_CONTRAST_SQ` deleted. On a hard edge the estimator gives
    // d = 1 + 0 - 1 = 0 exactly, so control leaves at `if (d === 0) continue`
    // and never reaches the contrast floor at all. The rule that decides whether
    // coverage is recoverable or is just 8-bit rounding had no effective test.
    //
    // Reaching it needs the opposite pair of conditions: anti-aliasing PRESENT, so
    // d is non-zero and the estimator would otherwise act, with the two sides too
    // close together to trust. The floor is 3*3*4 = 36 in summed squared RGBA
    // distance, so a grey step of 3 sits at 27 and a step of 4 at 48.
    //
    // Verified to discriminate: with the floor removed, the delta-3 case moves 9
    // vertices instead of 0.
    const antialiasedStep = (delta: number) => {
      const w = 16, h = 8, edgeX = 8.35;
      const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      const classes = new Int32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const coverage = Math.max(0, Math.min(1, edgeX - x));
          const v = Math.round(128 + delta * (1 - coverage));
          const o = (y * w + x) * 4;
          img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
          classes[y * w + x] = v <= 128 + delta / 2 ? 1 : 0;
        }
      }
      return { img, classes };
    };

    // 3*3*3 = 27, below the floor: leave the lattice alone.
    const below = antialiasedStep(3);
    expect(refineLoop(outerLoop(below.img, below.classes)!, below.img, below.classes, 1).moved).toBe(0);

    // 3*4*4 = 48, above it: the same geometry, now worth reading.
    const above = antialiasedStep(4);
    expect(refineLoop(outerLoop(above.img, above.classes)!, above.img, above.classes, 1).moved).toBeGreaterThan(0);
  });

  it('leaves a hard edge alone because there is no coverage to read', () => {
    // The original fixture, kept for what it actually tests: zero anti-aliasing
    // means zero displacement, via `d === 0` rather than via the contrast floor.
    const w = 10, h = 6;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const classes = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const v = x < 4 ? 128 : 129;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
        classes[y * w + x] = x < 4 ? 1 : 0;
      }
    }
    expect(refineLoop(outerLoop(img, classes)!, img, classes, 1).moved).toBe(0);
  });

  it('hands the fitter something it accepts', () => {
    // The whole point is that this drops in at the Int32Array -> Float64Array
    // seam, so the output must be usable by fitLoop unchanged.
    const img = verticalEdge(24, 24, 8.35);
    const classes = classifyDark(img);
    const loop = outerLoop(img, classes)!;
    const refined = refineLoop(loop, img, classes, 1);
    const fitted = fitLoop(refined.pts, {
      tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: true,
    });
    expect(fitted).not.toBeNull();
    expect(fitted!.segments.length).toBeGreaterThan(0);
    for (const seg of fitted!.segments) {
      expect(Number.isFinite(seg.x)).toBe(true);
      expect(Number.isFinite(seg.y)).toBe(true);
    }
  });

  it('lets the curve fitter engage, which a lattice staircase does not', () => {
    // A large smooth circle: on the lattice every turn is 90 degrees, so
    // findBreakpoints marks every anchor a corner and every span degrades to a
    // line. The measured consequence is zero curve segments. With sub-pixel
    // input the same fitter, unchanged, produces curves.
    const w = 96, h = 96, cx = 48, cy = 48, r = 34;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const classes = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Analytic coverage by supersampling, so the anti-aliasing is honest.
        let hit = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const px = x + (sx + 0.5) / 4 - cx;
            const py = y + (sy + 0.5) / 4 - cy;
            if (px * px + py * py <= r * r) hit++;
          }
        }
        const coverage = hit / 16;
        const v = Math.round(255 * (1 - coverage));
        const o = (y * w + x) * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
        classes[y * w + x] = coverage >= 0.5 ? 1 : 0;
      }
    }

    const loop = outerLoop(img, classes)!;
    const opts = { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: true };
    const curves = (pts: Int32Array | Float64Array): number =>
      (fitLoop(pts, opts)?.segments ?? []).filter((s) => s.kind === 'curve').length;

    const onLattice = curves(loop.pts);
    const onSubpixel = curves(refineLoop(loop, img, classes, 1).pts);

    expect(onLattice).toBe(0);
    expect(onSubpixel).toBeGreaterThan(0);
  });
});

describe('refineOpenArc', () => {
  /**
   * `findPlateau`'s walk out from a boundary is bounded by the region map, not
   * only by pixel value: it must stop the instant it would leave the component
   * being measured, because a thin region (a 1-2px bicycle spoke, in production)
   * can be narrower than the walk's reach. Without that guard, refining one edge
   * of a thin stroke would read contaminated "pure colour" samples from whatever
   * lies past the stroke's *other* edge.
   *
   * `findPlateau` itself is module-private, so this drives it through the public
   * `refineOpenArc` entry point with a synthetic thin stroke, built so the walk
   * cannot plateau on pixel value alone before it would reach the far side:
   *
   *   rows 0-12  label 0  flat v=255              (near-outside, both variants)
   *   rows 13-19 label 1  v = 180 - (row-13)*30    (the stroke under test, `cls`,
   *                                                 partial coverage at row 13
   *                                                 ramping down to pure black
   *                                                 by row 19)
   *   rows 20-29 label 2  flat, DIFFERS by variant  (far side, past the stroke)
   *
   * The arc under test is the boundary crack at row 13 (label 0 above it, label
   * 1 below), refined with `cls = 1`. Its inward walk starts at row 13 and steps
   * downward through the stroke; every step inside the stroke changes value by
   * 30 (delta² = 2700, far above the plateau epsilon), so nothing but the region
   * guard can stop it before row 20 — where the two variants diverge.
   *
   * The two variants are byte-identical from row 0 through row 19 (everything
   * the guard should ever let the walk see) and differ only at row 20 and
   * beyond. So: guard intact -> the walk never reaches row 20 -> refining the
   * near edge is unaffected by what the far side looks like -> identical output.
   * Guard broken -> the walk reads row 20's differing value as part of its
   * "pure colour" reference -> the two variants diverge.
   */
  function thinStrokeFixture(farValue: number): { img: RasterImage; labels: Int32Array } {
    const width = 6, height = 30;
    const img: RasterImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    const labels = new Int32Array(width * height);

    for (let y = 0; y < height; y++) {
      let label: number, v: number;
      if (y < 13) { label = 0; v = 255; }
      else if (y < 20) { label = 1; v = 180 - (y - 13) * 30; }
      else { label = 2; v = farValue; }

      for (let x = 0; x < width; x++) {
        labels[y * width + x] = label;
        const o = (y * width + x) * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
      }
    }
    return { img, labels };
  }

  it("does not let a thin stroke's near-edge refinement see past its far edge", () => {
    // A short, locally-straight run of the row-13 crack: x=0..4, y=13 constant.
    const pts = [0, 13, 1, 13, 2, 13, 3, 13, 4, 13];

    // Two arbitrary, distinct far-side values — chosen only so that if the
    // guard is lost, the walk would (a) find genuine, non-zero-contrast
    // "plateaus" out there rather than accidentally colliding with the
    // near-outside colour, and (b) land on two different projected shifts
    // that are not both clamped to the same MAX_SHIFT ceiling, so a mutation
    // shows up as unequal output rather than being masked by clamping.
    const variantA = thinStrokeFixture(140);
    const variantB = thinStrokeFixture(60);

    const refinedA = refineOpenArc(pts, variantA.img, variantA.labels, 1);
    const refinedB = refineOpenArc(pts, variantB.img, variantB.labels, 1);

    // Sanity: there is real anti-aliasing signal for this arc to act on at all,
    // or the invariant below would hold trivially for the wrong reason.
    expect(refinedA.moved).toBeGreaterThan(0);

    expect(Array.from(refinedB.pts)).toEqual(Array.from(refinedA.pts));
  });
});

describe('subpixel + extendUnder', () => {
  it('lets extendUnder win instead of throwing, now that subpixel is a default', async () => {
    const { trace } = await import('../src/vectorize/trace.js');
    const { flatArtwork } = await import('./fixtures.js');

    // This used to throw, and that was right while both were opt-in: asking for
    // two incompatible things deserved an explanation rather than a silent
    // downgrade. Once `subpixel` became a default the error would have fired on
    // `--extend-under` alone, blaming the user for a combination they never
    // asked for. `extendUnder` is always explicit, so it is the one to honour.
    const source = flatArtwork(48, 36);
    expect(() => trace(source, { subpixel: true, extendUnder: true })).not.toThrow();

    // And it really is extendUnder that ran: identical to asking for extendUnder
    // with refinement explicitly off, not to a refined trace.
    // And it really is extendUnder that ran: identical to asking for extendUnder
    // with refinement explicitly off.
    const both = trace(source, { subpixel: true, extendUnder: true }).svg;
    expect(both).toBe(trace(source, { subpixel: false, extendUnder: true }).svg);

    // Deliberately NOT asserting that it differs from a refined plain trace.
    // `flatArtwork` is hard-edged, and refinement provably cannot move a vertex
    // where there is no anti-aliasing to read — so the two are identical here
    // for a reason that has nothing to do with the precedence being tested.
    // Asserting a difference would only encode the fixture's flatness.
  });
});

/**
 * The two shared-boundary options make `subpixel` a no-op, and until now said
 * nothing about it.
 *
 * The fixture is anti-aliased on purpose. Refinement provably cannot move a
 * vertex where there is no coverage to read, so a hard-edged fixture would make
 * every arm identical for a reason that has nothing to do with the precedence
 * under test — the trap already recorded in the `extendUnder` case above. The
 * first assertion is therefore the control: on THIS image, with nothing shared
 * turned on, refinement changes the output. Only then does "identical" mean
 * anything in the arms that follow.
 */
describe('subpixel superseded by shared-boundary geometry', () => {
  /** A disc with genuine partial coverage at its rim, so refinement has work. */
  function antialiasedDisc(size = 56): RasterImage {
    const img: RasterImage = {
      width: size, height: size, data: new Uint8ClampedArray(size * size * 4),
    };
    const c = (size - 1) / 2;
    const r = size * 0.36;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // 4x4 supersample, so rim pixels carry fractional coverage.
        let hit = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const px = x + (sx + 0.5) / 4;
            const py = y + (sy + 0.5) / 4;
            if ((px - c) ** 2 + (py - c) ** 2 <= r * r) hit++;
          }
        }
        const v = Math.round(255 * (1 - hit / 16));
        const o = (y * size + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    return img;
  }

  // `latticeSimplify` is pinned in every arm below. Its default is `!subpixel`,
  // so leaving it alone would swap simplifiers at the same moment it swaps
  // refinement and the comparison would measure both at once.
  const BASE = { colors: 4, latticeSimplify: false } as const;

  it('changes the output when nothing is shared — the control', async () => {
    const { trace } = await import('../src/vectorize/trace.js');
    const source = antialiasedDisc();

    const on = trace(source, { ...BASE, subpixel: true });
    const off = trace(source, { ...BASE, subpixel: false });
    expect(on.svg).not.toBe(off.svg);
    expect(on.notes).toEqual([]);
    expect(off.notes).toEqual([]);
  });

  it('says so under regularise, where refinement never runs', async () => {
    const { trace } = await import('../src/vectorize/trace.js');
    const source = antialiasedDisc();

    const on = trace(source, { ...BASE, subpixel: true, regularise: 2 });
    const off = trace(source, { ...BASE, subpixel: false, regularise: 2 });

    // The note's own claim, checked rather than trusted.
    expect(on.svg).toBe(off.svg);
    expect(on.notes.join('\n')).toContain('Sub-pixel refinement had no effect');
    expect(on.notes.join('\n')).toContain('`regularise` option');
    // Nothing to report when the caller did not ask for refinement.
    expect(off.notes).toEqual([]);
  });

  it('says so under mosaic, where refinement runs and is discarded', async () => {
    const { trace } = await import('../src/vectorize/trace.js');
    const source = antialiasedDisc();

    const on = trace(source, { ...BASE, subpixel: true, mosaic: true });
    const off = trace(source, { ...BASE, subpixel: false, mosaic: true });

    expect(on.svg).toBe(off.svg);
    expect(on.notes.join('\n')).toContain('Sub-pixel refinement had no effect');
    expect(on.notes.join('\n')).toContain('`mosaic` option');
    expect(off.notes).toEqual([]);
  });

  it('reaches the caller through vectorize, not only through trace', async () => {
    const { vectorize } = await import('../src/api.js');
    const { encode } = await import('./fixtures.js');
    const { decodeRaster } = await import('../src/io/decode.js');

    const bytes = await encode(antialiasedDisc(), 'png');
    const { image, meta } = await decodeRaster(bytes);
    const out = await vectorize(
      { image, meta, bytes },
      { mode: 'trace', trace: { ...BASE, subpixel: true, mosaic: true } },
    );
    // The CLI prints `result.notes`, so this is the assertion that the message
    // reaches a person rather than only a return value nobody reads.
    expect(out.notes.join('\n')).toContain('Sub-pixel refinement had no effect');
  });
});

/**
 * Robust smoothing of the per-vertex displacement signal, driven directly
 * with hand-built tangent/displacement sequences rather than through an
 * image fixture.
 *
 * `refineLoop`/`refineOpenArc` densify a polyline and average two incident
 * steps into each vertex before this pass ever runs, which makes the exact
 * per-vertex sequence an image produces hard to dictate by hand — unlike
 * `findPlateau`, which a caller can pin precisely by controlling pixel
 * coverage. `cornerCuts` and `smoothVertexDisplacements` are exported for
 * exactly this reason (see their own doc comments) so the mechanism itself —
 * not a proxy for it — is what these tests exercise.
 */
describe('cornerCuts', () => {
  it('marks both ends of a boundary between two long runs (a real corner)', () => {
    // A wrapping loop of 12 steps: 6 pointing right, 6 pointing down. Two run
    // boundaries: v=6 (right run ends, down run starts) and the wrap seam at
    // v=0 (down run ends, right run starts) — both meet two runs of length 6,
    // above CORNER_RUN_MIN (4), so both are genuine corners.
    const tx = new Int8Array([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    const ty = new Int8Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const cut = cornerCuts(tx, ty, 12, true);
    expect(Array.from(cut)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('leaves short alternating runs unmarked — staircase noise, not corners', () => {
    // Runs of length 2, well below CORNER_RUN_MIN — the crack-following
    // staircase this pass exists to smooth over, not a real corner anywhere.
    const tx = new Int8Array([1, 1, 0, 0, 1, 1, 0, 0]);
    const ty = new Int8Array([0, 0, 1, 1, 0, 0, 1, 1]);
    const cut = cornerCuts(tx, ty, 8, true);
    expect(Array.from(cut)).toEqual(new Array(8).fill(0));
  });

  it('requires BOTH runs at a boundary to be long — one short side is still noise', () => {
    // A long run (6) meets a short run (2): the short side means this could
    // still be staircase jitter rather than a deliberate corner, so it must
    // not be cut.
    const tx = new Int8Array([1, 1, 1, 1, 1, 1, 0, 0]);
    const ty = new Int8Array([0, 0, 0, 0, 0, 0, 1, 1]);
    const cut = cornerCuts(tx, ty, 8, true);
    expect(cut[6]).toBe(0);
  });

  it('does not cut the wrap seam when the tangent continues straight through it', () => {
    // A single unbroken run of one tangent all the way around: the "last run
    // wraps straight into the first" merge means there is no boundary at
    // v=0 at all, not even a candidate to evaluate.
    const tx = new Int8Array(10).fill(1);
    const ty = new Int8Array(10).fill(0);
    const cut = cornerCuts(tx, ty, 10, true);
    expect(Array.from(cut)).toEqual(new Array(10).fill(0));
  });

  it('never cuts vertex 0 of an open arc, and leaves the endpoint slot 0', () => {
    // Non-wrapping: vertex 0 has no arriving step, so it can never be a cut
    // regardless of what follows; the trailing endpoint slot (index nSteps)
    // is pinned by the caller and this function must not touch it either.
    const tx = new Int8Array([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    const ty = new Int8Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const cut = cornerCuts(tx, ty, 12, false);
    expect(cut.length).toBe(13);
    expect(cut[0]).toBe(0);
    expect(cut[12]).toBe(0);
    // The interior boundary (v=6) is still a real corner in the open-arc case.
    expect(cut[6]).toBe(1);
  });
});

describe('smoothVertexDisplacements', () => {
  const n7valid = new Uint8Array(7).fill(1);
  const n7noCut = new Uint8Array(7);

  it('replaces a lone outlier with the window median — the majority wins', () => {
    // Vertex 3 disagrees in sign with every one of its 4 window neighbours,
    // all of them well above FIGHT_MAGNITUDE_MIN — the back-and-forth
    // signature this pass exists to correct.
    const dx = new Float64Array([0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5]);
    const dy = new Float64Array(7);
    const out = smoothVertexDisplacements(dx, dy, n7valid, n7noCut, 7, false);
    expect(out.x[3]).toBeCloseTo(0.5, 10);
  });

  it('leaves a mutually agreeing run untouched, exactly, not just close', () => {
    const dx = new Float64Array([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const dy = new Float64Array(7);
    const out = smoothVertexDisplacements(dx, dy, n7valid, n7noCut, 7, false);
    for (let i = 0; i < 7; i++) expect(out.x[i]).toBe(0.4);
  });

  it('does not count a sign disagreement below FIGHT_MAGNITUDE_MIN as oscillation', () => {
    // The centre value (-0.1) is opposite in sign to its neighbours but too
    // small to be a real measurement rather than near-zero jitter — every
    // pair touching it is skipped, so nothing in this window ever triggers,
    // and the whole sequence passes through unchanged.
    const dx = new Float64Array([0.5, 0.5, -0.1, 0.5, 0.5]);
    const dy = new Float64Array(5);
    const valid = new Uint8Array(5).fill(1);
    const cut = new Uint8Array(5);
    const out = smoothVertexDisplacements(dx, dy, valid, cut, 5, false);
    expect(Array.from(out.x)).toEqual(Array.from(dx));
  });

  /**
   * MUTATION CHECK (performed by hand, not shipped): raising
   * FIGHT_MAGNITUDE_MIN's effective floor by changing the `-0.1` fixture
   * value above to `-0.3` (above the real 0.25 threshold) made this
   * assertion fail — `out.x` differed from `dx` because the disagreement was
   * then large enough to trigger smoothing. Confirms the test actually
   * discriminates the threshold rather than passing regardless of it.
   * Reverted afterward.
   */
  it('never lets the smoothing window cross a hard corner', () => {
    // A SHORT genuine run (two +0.5 vertices, indices 3-4) sits right next to
    // a long -0.5 run. Without a corner gate, a radius-2 window outnumbers a
    // short run with its longer neighbour and the median flips it to the
    // WRONG value — the exact failure a corner gate exists to prevent, not a
    // hypothetical. A hard corner at vertex 5 (between the two runs) must
    // stop that from happening to vertex 4.
    const dx = new Float64Array([-0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5]);
    const dy = new Float64Array(9);
    const valid = new Uint8Array(9).fill(1);

    // Unprotected: outvoted by its 3 (of 4 window) negative neighbours, the
    // median overrules vertex 4's own true value. This is not asserting a
    // trivial fact — it demonstrates why the gate below is load-bearing.
    const unprotected = smoothVertexDisplacements(dx, dy, valid, new Uint8Array(9), 9, false);
    expect(unprotected.x[4]).toBe(-0.5);

    // Protected: the same vertex, with the real corner marked at vertex 5.
    const cut = new Uint8Array(9);
    cut[5] = 1;
    const protectedOut = smoothVertexDisplacements(dx, dy, valid, cut, 9, false);
    expect(protectedOut.x[4]).toBe(0.5);
  });

  it('excludes an invalid vertex from its neighbours’ windows and leaves its own output at zero', () => {
    // A 2-vertex sequence: vertex 0 is valid and has exactly ONE possible
    // window neighbour — vertex 1 — which has no usable measurement. With
    // only one other candidate in reach, a median over 5 points can't be
    // trusted to shrug the bug off the way it would with a full window (a
    // single outlier among many is still outvoted even if wrongly let in);
    // here inclusion or exclusion is the entire difference between a 1-point
    // window (no pair to compare, never triggers) and a 2-point window
    // (immediately oscillates and gets replaced by an average of the two).
    const dx = new Float64Array([0.4, -999]);
    const dy = new Float64Array(2);
    const valid = new Uint8Array([1, 0]);
    const cut = new Uint8Array(2);
    const out = smoothVertexDisplacements(dx, dy, valid, cut, 2, false);
    expect(out.x[1]).toBe(0); // invalid vertex: never written beyond its zero init
    expect(out.x[0]).toBe(0.4); // vertex 1 excluded, so vertex 0's window is just itself
  });

  it('wraps the window around a loop seam', () => {
    // A 6-vertex wrapping loop where vertex 0's window legitimately includes
    // vertices 4, 5 (to its "left", wrapping) and 1, 2 (to its right).
    const dx = new Float64Array([-0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const dy = new Float64Array(6);
    const valid = new Uint8Array(6).fill(1);
    const cut = new Uint8Array(6);
    const out = smoothVertexDisplacements(dx, dy, valid, cut, 6, true);
    // Vertex 0 disagrees with every wrapped-around neighbour, so it is
    // corrected to the majority — this only happens if wrapping is real.
    expect(out.x[0]).toBeCloseTo(0.5, 10);
  });
});
