import { describe, expect, it } from 'vitest';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents, type Loop } from '../src/vectorize/contour.js';
import { refineLoop } from '../src/vectorize/subpixel.js';
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
    // Contrast below the noise floor: coverage is unrecoverable, so the honest
    // answer is to leave the lattice alone rather than amplify rounding.
    const w = 10, h = 6;
    const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const classes = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const v = x < 4 ? 128 : 129; // one level apart
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
        classes[y * w + x] = x < 4 ? 1 : 0;
      }
    }
    const loop = outerLoop(img, classes)!;
    const refined = refineLoop(loop, img, classes, 1);
    expect(refined.moved).toBe(0);
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
