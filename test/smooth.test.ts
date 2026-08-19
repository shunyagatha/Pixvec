import { describe, expect, it } from 'vitest';
import { smoothPreservingEdges, iterationsFor, interiorNoiseOf } from '../src/vectorize/smooth.js';
import { vectorize, PRESETS } from '../src/api.js';
import { createImage, mulberry32, setPixel } from './fixtures.js';

/** Two flat halves with a hard edge, plus optional per-pixel grain. */
function halves(grain: number) {
  const img = createImage(48, 48);
  const rand = mulberry32(9);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const base = x < 24 ? 70 : 200;
      const n = grain === 0 ? 0 : Math.round((rand() * 2 - 1) * grain);
      setPixel(img, x, y, base + n, base + n, base + n, 255);
    }
  }
  return img;
}
const at = (img: ReturnType<typeof halves>, x: number, y: number) => img.data[(y * img.width + x) * 4];

describe('smoothPreservingEdges', () => {
  it('flattens a grainy interior', () => {
    const noisy = halves(30);
    const out = smoothPreservingEdges(noisy, 1, { iterations: 20 });
    // Spread within one flat half collapses.
    const spread = (img: typeof noisy) => {
      let lo = 255, hi = 0;
      for (let y = 8; y < 40; y++) for (let x = 4; x < 20; x++) { const v = at(img, x, y); if (v < lo) lo = v; if (v > hi) hi = v; }
      return hi - lo;
    };
    expect(spread(out)).toBeLessThan(spread(noisy) / 2);
  });

  it('does not walk the edge across the boundary', () => {
    // The whole point: a Gaussian would bleed the two halves together. Column 23
    // must stay dark and column 24 light.
    const out = smoothPreservingEdges(halves(30), 1, { iterations: 20 });
    expect(at(out, 20, 24)).toBeLessThan(110);
    expect(at(out, 27, 24)).toBeGreaterThan(160);
  });

  it('returns the input untouched at strength 0', () => {
    const img = halves(30);
    expect(smoothPreservingEdges(img, 0)).toBe(img);
  });

  // Asserts the PROPERTY, not the line that appears to implement it: the `c < 3`
  // bound in the diffusion loop is what enforces this, and the explicit alpha copy
  // below it is redundant. Mutation-testing that copy produced no failure, which is
  // the honest reason this comment exists.
  it('never diffuses alpha, because that would move the silhouette', () => {
    const img = createImage(32, 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const inside = (x - 16) ** 2 + (y - 16) ** 2 < 100;
      setPixel(img, x, y, 200, 30, 30, inside ? 255 : 0);
    }
    const out = smoothPreservingEdges(img, 1, { iterations: 12 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(img.data[i]);
  });
});

describe('iterationsFor scales the work by measured noise', () => {
  it('spends nothing on a clean image', () => {
    // A clean source has nothing to remove, so smoothing it only eats real detail:
    // logo-tux measured 0.77x bytes for -0.09 SSIM when forced. See smooth.ts.
    expect(iterationsFor(interiorNoiseOf(halves(0)), 1)).toBe(0);
    expect(iterationsFor(0.2, 1)).toBe(0);
  });

  it('spends more as noise rises, and saturates', () => {
    const a = iterationsFor(0.6, 1);
    const b = iterationsFor(1.5, 1);
    const c = iterationsFor(5.0, 1);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThanOrEqual(b);
    expect(c).toBeLessThanOrEqual(24);
  });

  it('is zero at strength 0 however noisy the source', () => {
    expect(iterationsFor(5.0, 0)).toBe(0);
  });
});

describe('the refinement noise gate reaches explicitly chosen presets', () => {
  /**
   * `autoTracePreset` both picks a palette and decides whether the source is clean
   * enough to refine. Choosing any explicit preset replaced the whole thing, so
   * `--preset poster` on a noisy source got refinement the measurement exists to
   * prevent — and `latticeSimplify` defaults to `!subpixel`, so it got simplification
   * too. On the reported sticker that was 28,136 bytes against 8,797.
   */
  const noisy = () => {
    const img = createImage(64, 64);
    const rand = mulberry32(3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const base = (x - 32) ** 2 + (y - 32) ** 2 < 400 ? 60 : 210;
      const n = Math.round((rand() * 2 - 1) * 40);
      setPixel(img, x, y, base + n, base + n, base + n, 255);
    }
    return img;
  };

  it('a preset with no opinion on subpixel gets the measured answer', async () => {
    const img = noisy();
    const gated = await vectorize({ image: img }, { mode: 'trace', preset: 'poster', noGenerator: true });
    const forced = await vectorize(
      { image: img },
      { mode: 'trace', preset: 'poster', trace: { subpixel: true }, noGenerator: true },
    );
    // Refinement on a noisy source costs geometry; the gate is what avoids it.
    expect(gated.svg.length).toBeLessThan(forced.svg.length);
  });

  it('a preset that states an opinion still wins', () => {
    // `logo` and `lineart` set subpixel deliberately and must not be overridden.
    expect(PRESETS.logo.subpixel).toBe(true);
    expect(PRESETS.lineart.subpixel).toBe(true);
  });

  it('clean carries no fit-tolerance overrides', () => {
    // Setting them produced 547 curves that speckled every boundary, at 3.2x the
    // bytes. Recorded as a test so it is not "tidied" back in.
    expect(PRESETS.clean.tolerance).toBeUndefined();
    expect(PRESETS.clean.fitError).toBeUndefined();
    expect(PRESETS.clean.cornerAngle).toBeUndefined();
    expect(PRESETS.clean.smooth).toBe(1);
  });
});

describe('contour regularisation moves vertices only inside the grid uncertainty', () => {
  /**
   * The mechanism works — on the reported sticker it takes the fitter from 7 curve
   * segments to 233. It defaults to OFF because it smooths each region's loop
   * independently, so shared boundaries drift apart and the subject falls to pieces.
   * See the note on `regulariseClosed` in fit.ts for the two rendered failures.
   */
  const staircase = () => {
    // A 45-degree staircase: the case a band below 0.707 cannot flatten.
    const pts: number[] = [];
    for (let i = 0; i < 20; i++) { pts.push(i, i); pts.push(i + 1, i); }
    for (let i = 20; i > 0; i--) { pts.push(i, i + 6); pts.push(i - 1, i + 6); }
    return pts;
  };

  it('never moves a vertex further than the band allows', async () => {
    // Tested on `regulariseClosed` directly, per index, because the obvious
    // version of this assertion was BLIND: checking that each output point is
    // near SOME input vertex passes even with the constraint deleted, since a
    // staircase's vertices are dense enough that everything is near one of them.
    // The invariant is per-vertex — point i stays within the band of point i.
    const { regulariseClosed } = await import('../src/vectorize/fit.js');
    const pts = staircase();
    const n = pts.length / 2;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = pts[i * 2]; py[i] = pts[i * 2 + 1]; }
    const ox = Float64Array.from(px);
    const oy = Float64Array.from(py);
    const band = 0.75;
    regulariseClosed(px, py, n, band, 40);
    for (let i = 0; i < n; i++) {
      const moved = Math.hypot(px[i] - ox[i], py[i] - oy[i]);
      expect(moved, `vertex ${i} moved ${moved.toFixed(3)}px, past the ${band}px band`)
        .toBeLessThanOrEqual(band + 1e-9);
    }
  });

  it('shortens a staircase toward the line it approximates', async () => {
    // Perimeter is the honest measure here. A 45-degree staircase is sqrt(2) times
    // longer than its own diagonal, and flattening it toward that diagonal has to
    // shorten it. (An earlier version of this assertion used mean |x - y|, which is
    // meaningless once `regulariseClosed` wraps index 0 to index n-1.)
    const { regulariseClosed } = await import('../src/vectorize/fit.js');
    const n = 40;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) { const s = Math.floor(i / 2); px[i] = s + (i % 2); py[i] = s; }
    const perimeter = () => {
      let t = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        t += Math.hypot(px[j] - px[i], py[j] - py[i]);
      }
      return t;
    };
    const before = perimeter();
    regulariseClosed(px, py, n, 0.75, 20);
    expect(perimeter()).toBeLessThan(before);
  });

  it('does nothing at all when off', async () => {
    const { fitLoop } = await import('../src/vectorize/fit.js');
    const pts = staircase();
    const off = fitLoop(pts, { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: false });
    const zero = fitLoop(pts, { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: false, regularise: 0 });
    expect(JSON.stringify(zero)).toBe(JSON.stringify(off));
  });

  it('actually changes the geometry when on, or it is not doing anything', async () => {
    const { fitLoop } = await import('../src/vectorize/fit.js');
    const pts = staircase();
    const off = fitLoop(pts, { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: false });
    const on = fitLoop(pts, { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, optimize: false, regularise: 8 });
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
  });
});

describe('junction pinning makes neighbours agree exactly', () => {
  /**
   * Two regions that share a boundary hold two private copies of it. Smoothing the
   * copies independently moves them apart and the subject falls to pieces.
   *
   * The fix is NOT a shared arc structure — that was built first and is
   * unnecessary. At a lattice vertex where exactly two cracks meet, exactly two
   * faces meet and BOTH traverse BOTH cracks, so the vertex's two neighbours are
   * the same pair for both faces, merely swapped. `(prev + next) / 2` is symmetric
   * under that swap, so both faces compute the same position, for every pass.
   *
   * It fails only where three or more cracks meet. Pin those and the agreement is
   * exact — measured at 0 disagreeing vertices, max gap 0.00e+0, over ~50,000
   * shared vertices across three subjects.
   *
   * BOTH halves are required. Without junction retention in the contour collapse a
   * geometrically collinear junction is dropped, the two faces diverge past it, and
   * the same measurement gives 1,011 disagreements at up to 0.61px.
   */
  const scene = async (split: boolean) => {
    const { connectedComponents } = await import('../src/vectorize/components.js');
    const { traceComponents } = await import('../src/vectorize/contour.js');
    const { regulariseAgreeing } = await import('../src/vectorize/junctions.js');
    // Four quadrants, so the centre is a degree-4 junction and each edge is shared.
    const W = 40, H = 40;
    const labels = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) labels[y * W + x] = (x < 20 ? 0 : 1) + (y < 20 ? 0 : 2);
    }
    const comps = connectedComponents(labels, W, H, -1);
    const loops = traceComponents(comps.labels, W, H, comps.count, 'left', undefined, split);
    return { loops, geo: regulariseAgreeing(loops, comps.labels, W, H, 8, 0.75) };
  };

  const disagreement = (loops: Awaited<ReturnType<typeof scene>>['loops'], geo: Map<unknown, Float64Array>) => {
    const seen = new Map<string, [number, number]>();
    let checked = 0, worst = 0;
    for (const arr of loops) {
      for (const l of arr) {
        const g = geo.get(l);
        if (!g) continue;
        for (let i = 0; i < l.pts.length / 2; i++) {
          const key = `${l.pts[i * 2]},${l.pts[i * 2 + 1]}`;
          const pos: [number, number] = [g[i * 2], g[i * 2 + 1]];
          const prev = seen.get(key);
          if (prev) {
            checked++;
            worst = Math.max(worst, Math.hypot(prev[0] - pos[0], prev[1] - pos[1]));
          } else seen.set(key, pos);
        }
      }
    }
    return { checked, worst };
  };

  it('gives every shared vertex one position', async () => {
    const { loops, geo } = await scene(true);
    const { checked, worst } = disagreement(loops, geo);
    expect(checked, 'the fixture produced no shared vertices to compare').toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-9);
  });

  it('pins junctions and the frame, and nothing else', async () => {
    const { pinsFor, crackDegree } = await import('../src/vectorize/junctions.js');
    const { connectedComponents } = await import('../src/vectorize/components.js');
    const { traceComponents } = await import('../src/vectorize/contour.js');
    const W = 40, H = 40;
    const labels = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) labels[y * W + x] = (x < 20 ? 0 : 1) + (y < 20 ? 0 : 2);
    const comps = connectedComponents(labels, W, H, -1);
    const loops = traceComponents(comps.labels, W, H, comps.count, 'left', undefined, true);
    for (const l of loops.flat()) {
      const pins = pinsFor(l, comps.labels, W, H);
      for (let i = 0; i < pins.length; i++) {
        const x = l.pts[i * 2], y = l.pts[i * 2 + 1];
        const onFrame = x <= 0 || y <= 0 || x >= W || y >= H;
        const deg = crackDegree(comps.labels, W, H, x, y);
        expect(Boolean(pins[i]), `vertex ${x},${y} degree ${deg}`).toBe(onFrame || deg !== 2);
      }
    }
  });

  it('pins the image corner, which a bare closed-loop pass retreats inward', async () => {
    const { pinsFor } = await import('../src/vectorize/junctions.js');
    const { connectedComponents } = await import('../src/vectorize/components.js');
    const { traceComponents } = await import('../src/vectorize/contour.js');
    // One region filling the frame: every corner is crack-degree 2, so only the
    // frame rule holds it. Without that the fill shrinks off the picture edge.
    const W = 16, H = 16;
    const labels = new Int32Array(W * H);
    const comps = connectedComponents(labels, W, H, -1);
    const loops = traceComponents(comps.labels, W, H, comps.count, 'left', undefined, true);
    const l = loops.flat()[0];
    expect(l).toBeDefined();
    const pins = pinsFor(l!, comps.labels, W, H);
    expect(Array.from(pins).every((p) => p === 1)).toBe(true);
  });
});

describe('a junction that is geometrically straight still splits the boundary', () => {
  /**
   * The case that makes junction retention load-bearing, and which a
   * four-quadrant fixture misses entirely because every junction there is also a
   * corner.
   *
   * Bottom half is one region; the top half changes region halfway across. The
   * boundary between them runs dead straight, but the neighbour above it changes
   * at the midpoint. That midpoint is a crack-degree-3 junction sitting on a
   * straight line, so the collinear collapse deletes it unless told otherwise —
   * and past a deleted junction the two faces follow different cracks and their
   * smoothed positions diverge.
   */
  const build = async (split: boolean) => {
    const { connectedComponents } = await import('../src/vectorize/components.js');
    const { traceComponents } = await import('../src/vectorize/contour.js');
    const { regulariseAgreeing } = await import('../src/vectorize/junctions.js');
    const W = 40, H = 40;
    const labels = new Int32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) labels[y * W + x] = y >= 20 ? 0 : (x < 20 ? 1 : 2);
    }
    const comps = connectedComponents(labels, W, H, -1);
    const loops = traceComponents(comps.labels, W, H, comps.count, 'left', undefined, split);
    const geo = regulariseAgreeing(loops, comps.labels, W, H, 8, 0.75);
    let checked = 0, worst = 0;
    const seen = new Map<string, [number, number]>();
    for (const l of loops.flat()) {
      const g = geo.get(l);
      if (!g) continue;
      for (let i = 0; i < l.pts.length / 2; i++) {
        const key = `${l.pts[i * 2]},${l.pts[i * 2 + 1]}`;
        const pos: [number, number] = [g[i * 2], g[i * 2 + 1]];
        const prev = seen.get(key);
        if (prev) { checked++; worst = Math.max(worst, Math.hypot(prev[0] - pos[0], prev[1] - pos[1])); }
        else seen.set(key, pos);
      }
    }
    return { checked, worst };
  };

  it('agrees exactly when the collinear junction is retained', async () => {
    const { checked, worst } = await build(true);
    expect(checked).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-9);
  });

  // There is deliberately NO unit test asserting that retention is REQUIRED, and
  // the reason is worth recording rather than hiding. Every fixture small enough
  // to reason about ends up with its junctions either on the frame or on a
  // geometric corner, so they are pinned or retained anyway and the scene agrees
  // with retention switched off — the assertion passes for the wrong reason.
  //
  // The evidence that retention is load-bearing is the corpus measurement, on
  // real images, at 8 passes and a 0.75px band:
  //
  //                    retention off            retention on
  //   logo-tux         1,011 disagree, 0.61px   0 disagree, 0.00
  //   alpha-dice       2,566 disagree, 0.89px   0 disagree, 0.00
  //   the sticker        693 disagree, 0.68px   0 disagree, 0.00
  //
  // Reproduce with `regulariseAgreeing` over `traceComponents(..., split)` for
  // both values of `split`, comparing each lattice vertex's smoothed position
  // across every loop that contains it.
});
