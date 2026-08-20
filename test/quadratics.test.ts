/**
 * Degree reduction: a quadratic wherever one says the same thing.
 *
 * THE DEFECT THESE TESTS EXIST FOR. An earlier version of this pass, for spans
 * too short to measure against, accepted a conversion when the quadratic was
 * within the budget OF THE CUBIC. Both approximate the same traced points and
 * their errors add, so that permits twice the budget — and it was not
 * hypothetical: the emitted path landed 0.80 px from the points it was fitted
 * to, against a 0.75 px budget, on 19 of logo-tux's 206 short spans.
 *
 * So the measuring instrument here is deliberately NOT the one the pass uses.
 * `deviation` below projects each point onto the emitted curve by dense sampling
 * plus a golden-section refinement, with no Newton step and no analytic bound in
 * sight; if the pass and its test agreed by sharing an approximation, neither
 * would be evidence for the other.
 */

import { describe, expect, it } from 'vitest';
import { fitOpen, regulariseOpen, type FittedPath, type Segment } from '../src/vectorize/fit.js';
import { reversePath } from '../src/vectorize/arcs.js';
import { PathBuilder } from '../src/svg/path.js';
import { traceGeometry, toDxf, toEps, toPdf } from '../src/io/export/index.js';
import { elevateQuad, flatten } from '../src/io/export/shared.js';
import { vectorize } from '../src/api.js';
import { createImage, setPixel } from './fixtures.js';
// eslint-disable-next-line
import { pathStats } from '../scripts/lib/path-stats.mjs';
// eslint-disable-next-line
import { structure } from '../scripts/lib/svg-structure.mjs';

/** How `clean` fits a shared arc: fitError 0.4, merges at 0.75, two smoothing passes. */
const ARC_FIT = {
  tolerance: 0.4, fitError: 0.4, cornerAngle: 75,
  optimize: true, optimizeError: 0.75, regularise: 2, regulariseBand: 0.75,
};
/** The widest error any emitted curve on such an arc had to pass. */
const BUDGET = 0.75;

// --------------------------------------------------------------- the instrument

type At = (p: readonly number[], t: number) => [number, number];

const lineAt: At = (p, t) => [p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t];
const quadAt: At = (p, t) => {
  const m = 1 - t;
  return [
    m * m * p[0] + 2 * m * t * p[2] + t * t * p[4],
    m * m * p[1] + 2 * m * t * p[3] + t * t * p[5],
  ];
};
const cubicAt: At = (p, t) => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p[0] + b * p[2] + c * p[4] + d * p[6],
    a * p[1] + b * p[3] + c * p[5] + d * p[7],
  ];
};

/** Shortest distance from a point to one curve: scan, then close the bracket. */
function pointToCurve(at: At, p: readonly number[], px: number, py: number): number {
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    const c = at(p, t);
    const d = Math.hypot(c[0] - px, c[1] - py);
    if (d < best) { best = d; bestT = t; }
  }
  let lo = Math.max(0, bestT - 1 / 256);
  let hi = Math.min(1, bestT + 1 / 256);
  for (let k = 0; k < 60; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const c1 = at(p, m1), c2 = at(p, m2);
    if (Math.hypot(c1[0] - px, c1[1] - py) < Math.hypot(c2[0] - px, c2[1] - py)) hi = m2;
    else lo = m1;
  }
  const c = at(p, (lo + hi) / 2);
  return Math.min(best, Math.hypot(c[0] - px, c[1] - py));
}

/** Control polygon and evaluator for one segment leaving `(cx, cy)`. */
function curveOf(s: Segment, cx: number, cy: number): { at: At; p: number[] } {
  if (s.kind === 'line') return { at: lineAt, p: [cx, cy, s.x, s.y] };
  if (s.kind === 'quad') return { at: quadAt, p: [cx, cy, s.x1, s.y1, s.x, s.y] };
  return { at: cubicAt, p: [cx, cy, s.x1, s.y1, s.x2, s.y2, s.x, s.y] };
}

/**
 * Greatest distance from any of `pts` to the path — the quantity the budget is a
 * promise about, measured against the points the fitter was actually given.
 *
 * `fitOpen` smooths its input before fitting, so the promise is against the
 * smoothed run; the same `regulariseOpen` the fitter uses is applied here to
 * recover it. Nothing else about the fitter is reused.
 */
function deviation(pts: readonly number[], path: FittedPath, opts = ARC_FIT): number {
  const n = pts.length / 2;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = pts[i * 2]; py[i] = pts[i * 2 + 1]; }
  regulariseOpen(px, py, n, opts.regulariseBand, opts.regularise);

  let worst = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    let cx = path.start.x, cy = path.start.y;
    for (const s of path.segments) {
      const { at, p } = curveOf(s, cx, cy);
      best = Math.min(best, pointToCurve(at, p, px[i], py[i]));
      cx = s.x; cy = s.y;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/** The degree reduction itself, written out so a test can ask "what if". */
function bestQuadratic(p0: number[], s: Segment & { kind: 'curve' }): [number, number] {
  return [
    (3 * (s.x1 + s.x2) - p0[0] - s.x) / 4,
    (3 * (s.y1 + s.y2) - p0[1] - s.y) / 4,
  ];
}

// ------------------------------------------------------------------- the budget

/**
 * A three-point run whose cubic has already spent 0.399 of a 0.4 budget.
 *
 * Found by sweeping every run of three points on a half-unit grid for the case
 * the two rules disagree about. It is the smallest possible witness: one
 * interior point, so the pass has too little evidence to measure against and
 * must fall back on the analytic bound — which is exactly the branch that was
 * wrong.
 */
const SPENT_ALREADY = [0, 0, 1, 0.5, 4.5, 0];
const TIGHT_FIT = {
  tolerance: 0.4, fitError: 0.4, cornerAngle: 75,
  optimize: true, optimizeError: 0.4, regularise: 0, regulariseBand: 0.75,
};

describe('degree reduction charges the budget once, not twice', () => {
  it('refuses a span whose cubic has already spent the budget', () => {
    const plain = fitOpen(SPENT_ALREADY, { ...TIGHT_FIT, quadratics: false })!;
    // Guard against the test going vacuous. If the fitter ever splits this run,
    // or takes the polygon shortcut, it stops exercising the analytic branch and
    // "no quadratic was emitted" would prove nothing. Re-derive the fixture.
    expect(plain.segments).toHaveLength(1);
    expect(plain.segments[0].kind).toBe('curve');

    const cubic = plain.segments[0] as Segment & { kind: 'curve' };
    const spent = deviation(SPENT_ALREADY, plain, TIGHT_FIT);
    expect(spent).toBeGreaterThan(0.39);
    expect(spent).toBeLessThanOrEqual(0.4);

    // What the rejected version would have emitted here, measured against the
    // traced points rather than against the cubic: past the budget.
    const [qx, qy] = bestQuadratic([0, 0], cubic);
    const asQuad: FittedPath = {
      start: { x: 0, y: 0 },
      segments: [{ kind: 'quad', x1: qx, y1: qy, x: cubic.x, y: cubic.y }],
    };
    expect(deviation(SPENT_ALREADY, asQuad, TIGHT_FIT)).toBeGreaterThan(0.44);

    // So the pass must keep the cubic. Charging the analytic deviation against
    // the WHOLE budget instead of against what the cubic left converts it.
    const reduced = fitOpen(SPENT_ALREADY, { ...TIGHT_FIT, quadratics: true })!;
    expect(reduced.segments.map((s) => s.kind)).toEqual(['curve']);
    expect(deviation(SPENT_ALREADY, reduced, TIGHT_FIT)).toBeLessThanOrEqual(0.4);
  });

  it('does convert a short span whose cubic left the budget alone', () => {
    // Same branch, same budget, one interior point — and here it says yes. The
    // refusal above is about the arithmetic, not about this pass being unable to
    // fire where there is too little evidence to measure against.
    const gentle = [0, 0, 3.5, 2, 4.5, 2];
    const plain = fitOpen(gentle, { ...TIGHT_FIT, quadratics: false })!;
    expect(plain.segments.map((s) => s.kind)).toEqual(['curve']);

    const reduced = fitOpen(gentle, { ...TIGHT_FIT, quadratics: true })!;
    expect(reduced.segments.map((s) => s.kind)).toEqual(['quad']);
    expect(deviation(gentle, reduced, TIGHT_FIT)).toBeLessThanOrEqual(0.4);
  });

  it('keeps every emitted curve inside the budget across a family of runs', () => {
    // Jagged lattice-like runs, deterministic. The measured branch decides most
    // of these; the point is that turning the pass on never moves the emitted
    // geometry outside the promise the cubics were already held to.
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    let converted = 0;
    for (let run = 0; run < 40; run++) {
      const pts: number[] = [];
      let x = 0, y = 0;
      const n = 12 + Math.floor(rnd() * 40);
      const curl = (rnd() - 0.5) * 0.35;
      let angle = rnd() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        pts.push(Math.round(x), Math.round(y));
        angle += curl + (rnd() - 0.5) * 0.6;
        x += Math.cos(angle) * (1 + rnd() * 3);
        y += Math.sin(angle) * (1 + rnd() * 3);
      }
      const plain = fitOpen(pts, { ...ARC_FIT, quadratics: false });
      const reduced = fitOpen(pts, { ...ARC_FIT, quadratics: true });
      if (!plain || !reduced) continue;

      converted += reduced.segments.filter((s) => s.kind === 'quad').length;
      // Same segment count: this is a change of representation, not of shape.
      expect(reduced.segments).toHaveLength(plain.segments.length);
      expect(deviation(pts, plain)).toBeLessThanOrEqual(BUDGET);
      expect(deviation(pts, reduced)).toBeLessThanOrEqual(BUDGET);
    }
    // Guard the guard: a pass that converted nothing would sail through the loop.
    expect(converted).toBeGreaterThan(50);
  });
});

// ------------------------------------------------------------------- reversal

describe('a reversed quadratic keeps its single control point', () => {
  it('reverses by exchanging the endpoints and nothing else', () => {
    const forward: FittedPath = {
      start: { x: 0, y: 0 },
      segments: [{ kind: 'quad', x1: 1, y1: 4, x: 6, y: 2 }],
    };
    expect(reversePath(forward)).toEqual({
      start: { x: 6, y: 2 },
      segments: [{ kind: 'quad', x1: 1, y1: 4, x: 0, y: 0 }],
    });
  });

  it('draws the same curve, checked by evaluating both', () => {
    // The claim in arcs.ts is that the Bernstein basis is symmetric and there is
    // only one middle term, so B_rev(t) = B(1-t). Asserted numerically rather
    // than believed: the cubic case swaps two control points, and copying that
    // rule onto a quadratic — or forgetting to copy it at all — both produce a
    // path that still looks plausible.
    const start = { x: -3, y: 7.5 };
    const seg = { kind: 'quad' as const, x1: 2.25, y1: -1.5, x: 11, y: 4 };
    const rev = reversePath({ start, segments: [seg] });
    const fwdPoly = [start.x, start.y, seg.x1, seg.y1, seg.x, seg.y];
    const revSeg = rev.segments[0] as Segment & { kind: 'quad' };
    const revPoly = [rev.start.x, rev.start.y, revSeg.x1, revSeg.y1, revSeg.x, revSeg.y];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const a = quadAt(fwdPoly, t);
      const b = quadAt(revPoly, 1 - t);
      expect(a[0]).toBeCloseTo(b[0], 12);
      expect(a[1]).toBeCloseTo(b[1], 12);
    }
  });

  it('round-trips a mixed path exactly', () => {
    const p: FittedPath = {
      start: { x: 2.5, y: -1.25 },
      segments: [
        { kind: 'quad', x1: 3, y1: 0, x: 5, y: 2 },
        { kind: 'line', x: 9, y: 7 },
        { kind: 'curve', x1: 10, y1: 8, x2: 11, y2: 9, x: 12, y: 10 },
        { kind: 'quad', x1: 13, y1: 11, x: 14, y: 12 },
      ],
    };
    expect(reversePath(reversePath(p))).toEqual(p);
  });
});

// ------------------------------------------------------------- the mosaic property

/** Overlapping lobes on a flat field: many three-face junctions, curved arcs. */
function petals(size = 96) {
  const img = createImage(size, size);
  const c = size / 2, R = size * 0.42;
  const lobe = [[236, 84, 80], [247, 168, 54], [112, 183, 86], [64, 140, 206], [142, 102, 190]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let col = [26, 29, 38];
      for (let i = lobe.length - 1; i >= 0; i--) {
        const a = (i / lobe.length) * 2 * Math.PI;
        if (Math.hypot(x - (c + Math.cos(a) * R * 0.52), y - (c + Math.sin(a) * R * 0.52)) < R * 0.46) {
          col = lobe[i];
        }
      }
      if (Math.hypot(x - c, y - c) < R * 0.22) col = [250, 247, 238];
      setPixel(img, x, y, col[0], col[1], col[2], 255);
    }
  }
  return img;
}

describe('quadratics on the mosaic', () => {
  it('leaves neighbouring faces agreeing edge for edge', async () => {
    // The mosaic's whole point is that two faces sharing a boundary are handed
    // the same curve, one of them reversed. A reversal rule that is wrong for
    // quadratics does not throw and does not look wrong in isolation — it shows
    // up here, as edges that no longer match their twin.
    const img = petals();
    // The baseline is pinned OFF explicitly. `clean` now defaults it on, so taking
    // the preset bare would compare the feature against itself and the byte
    // assertion below would be vacuous.
    const base = await vectorize({ image: img }, { preset: 'clean', trace: { quadratics: false } });
    const quad = await vectorize({ image: img }, { preset: 'clean', trace: { quadratics: true } });

    const a = structure(base.svg) as { twinnedEdges: number; interiorEdges: number };
    const b = structure(quad.svg) as { twinnedEdges: number; interiorEdges: number };
    expect(b.interiorEdges).toBe(a.interiorEdges);
    expect(b.twinnedEdges).toBe(a.twinnedEdges);
    // And the subject really does contain quadratics, or the above compares
    // two identical files.
    expect((pathStats(quad.svg) as { counts: Record<string, number> }).counts.q).toBeGreaterThan(10);
  });

  it('changes the spelling, not the census', async () => {
    const img = petals();
    // The baseline is pinned OFF explicitly. `clean` now defaults it on, so taking
    // the preset bare would compare the feature against itself and the byte
    // assertion below would be vacuous.
    const base = await vectorize({ image: img }, { preset: 'clean', trace: { quadratics: false } });
    const quad = await vectorize({ image: img }, { preset: 'clean', trace: { quadratics: true } });
    const a = pathStats(base.svg) as { segments: number; curves: number; lines: number; subpaths: number };
    const b = pathStats(quad.svg) as { segments: number; curves: number; lines: number; subpaths: number };
    expect(b).toMatchObject({
      segments: a.segments, curves: a.curves, lines: a.lines, subpaths: a.subpaths,
    });
    // Four numbers against six, so it must be smaller.
    expect(Buffer.byteLength(quad.svg)).toBeLessThan(Buffer.byteLength(base.svg));
  });

  it('is on in clean, off everywhere else, and refusable', async () => {
    const img = petals();
    // On in `clean` — the default this preset now ships.
    const on = await vectorize({ image: img }, { preset: 'clean' });
    expect(on.svg).toMatch(/\sd="[^"]*q/);

    // Still refusable, and refusing it really does remove them rather than just
    // changing the spelling elsewhere.
    const off = await vectorize({ image: img }, { preset: 'clean', trace: { quadratics: false } });
    expect(off.svg).not.toMatch(/\sd="[^"]*q/);
    expect(off.svg).not.toBe(on.svg);

    // And nothing outside `clean` picks it up by accident. This half is the point
    // of the test: a default that leaks into other presets changes output nobody
    // asked to change.
    const plain = await vectorize({ image: img }, { mode: 'trace' });
    expect(plain.svg).not.toMatch(/\sd="[^"]*q/);
    for (const preset of ['logo', 'lineart', 'poster', 'photo'] as const) {
      const other = await vectorize({ image: img }, { mode: 'trace', preset });
      expect(other.svg, `${preset} picked up quadratics`).not.toMatch(/\sd="[^"]*q/);
    }
  });
});

// ----------------------------------------------------------------- the writers

/**
 * Trace geometry that actually contains quadratics, for the export writers.
 *
 * `primitives: false` because a disc or a rounded blob is promoted to a real
 * CIRCLE/arc by every one of these writers, and then there is no segment list
 * left to get wrong. Tolerance above the fitter's dead zone, or there are no
 * curves to reduce either.
 */
function quadGeometry() {
  const img = petals(72);
  const opts = { colors: 6, tolerance: 0.6, fitError: 0.6, primitives: false } as const;
  return {
    img,
    geometry: traceGeometry(img, { ...opts, quadratics: true }),
    plain: traceGeometry(img, opts),
  };
}

const segmentsOf = (g: ReturnType<typeof quadGeometry>['geometry']): Segment[] =>
  g.paths.flatMap((p) => p.subpaths.flatMap((s) => s.segments));

describe('every writer that switches on a segment kind', () => {
  it('produces quadratics to write in the first place', () => {
    const { geometry, plain } = quadGeometry();
    expect(segmentsOf(geometry).filter((s) => s.kind === 'quad').length).toBeGreaterThan(3);
    expect(segmentsOf(plain).filter((s) => s.kind === 'quad')).toHaveLength(0);
  });

  it('elevates a quadratic to the cubic that draws it exactly', () => {
    // Degree elevation is exact in this direction, which is why PostScript and
    // PDF — neither of which has a quadratic operator — lose nothing.
    const p0 = { x: 3, y: -2 }, q = { x: 11, y: 9.5 }, p2 = { x: 20, y: 1 };
    const { c1, c2 } = elevateQuad(p0, q, p2);
    const quadPoly = [p0.x, p0.y, q.x, q.y, p2.x, p2.y];
    const cubicPoly = [p0.x, p0.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const a = quadAt(quadPoly, t);
      const b = cubicAt(cubicPoly, t);
      expect(a[0]).toBeCloseTo(b[0], 12);
      expect(a[1]).toBeCloseTo(b[1], 12);
    }
  });

  it('writes the elevated control points into EPS and PDF', () => {
    // A `quad` reaching a writer that only knew two kinds is a silently wrong
    // export: PostScript has no quadratic operator, and PDF's `v` takes the
    // CURRENT point as its first control, which is a different curve.
    const { geometry } = quadGeometry();
    const eps = toEps(geometry);
    const pdf = new TextDecoder('latin1').decode(toPdf(geometry));
    for (const text of [eps, pdf]) {
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('undefined');
    }

    // Every quadratic in the geometry appears as its exact cubic.
    let checked = 0;
    for (const path of geometry.paths) {
      for (const sub of path.subpaths) {
        let cur = { x: sub.start.x, y: sub.start.y };
        for (const seg of sub.segments) {
          if (seg.kind === 'quad') {
            const { c1, c2 } = elevateQuad(cur, { x: seg.x1, y: seg.y1 }, { x: seg.x, y: seg.y });
            // EPS flips y, so the x coordinates are the ones written unchanged.
            // Rounded the way the writers round, not to a different precision.
            const round = (v: number): string => (Math.round(v * 1000) / 1000).toString();
            expect(eps).toContain(`${round(c1.x)} `);
            expect(eps).toContain(`${round(c2.x)} `);
            expect(pdf).toContain(`${round(c1.x)} `);
            checked++;
          }
          cur = { x: seg.x, y: seg.y };
        }
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('samples a quadratic when flattening for DXF and G-code', () => {
    const p0 = { x: 0, y: 0 }, q = { x: 4, y: 8 }, p2 = { x: 12, y: 0 };
    const pts = flatten({ start: p0, segments: [{ kind: 'quad', x1: q.x, y1: q.y, x: p2.x, y: p2.y }] }, 8);
    // Start plus eight samples, every one of them on the curve.
    expect(pts).toHaveLength(9);
    const poly = [p0.x, p0.y, q.x, q.y, p2.x, p2.y];
    for (let i = 1; i < pts.length; i++) {
      const [ex, ey] = quadAt(poly, i / 8);
      expect(pts[i].x).toBeCloseTo(ex, 10);
      expect(pts[i].y).toBeCloseTo(ey, 10);
    }
    // A quadratic left unhandled would flatten to a straight chord: the
    // sampled polyline is longer than the line from end to end.
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    expect(len).toBeGreaterThan(Math.hypot(p2.x - p0.x, p2.y - p0.y) + 1);
  });

  it('writes a DXF polyline that follows the curve rather than cutting the corner', () => {
    // G-code is not in this list on purpose: `toGcode` takes polylines from the
    // centreline tracer and never sees a Segment at all.
    const { geometry } = quadGeometry();
    const dxf = toDxf(geometry, { unit: 'mm' });
    expect(dxf).not.toContain('NaN');
    expect(dxf).not.toContain('undefined');
    // Each LWPOLYLINE declares its vertex count in group code 90. They sum to
    // more than there are segments, which is only true if the curves — the
    // quadratics among them — were sampled rather than joined corner to corner.
    const declared = [...dxf.matchAll(/\n90\n(\d+)\n/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(declared).toBeGreaterThan(segmentsOf(geometry).length);
  });
});

// -------------------------------------------------------------------- the builder

describe('PathBuilder.quadTo', () => {
  it('writes four numbers where a cubic writes six', () => {
    const pb = new PathBuilder(2);
    pb.moveTo(10, 10);
    pb.quadTo(12, 14, 20, 10);
    expect(pb.toString()).toBe('M10 10q2 4 10 0');
  });

  it('elides the repeated command letter', () => {
    const pb = new PathBuilder(2);
    pb.moveTo(0, 0);
    pb.quadTo(1, 2, 4, 0);
    pb.quadTo(7, -2, 8, 0);
    expect(pb.toString().match(/q/g)).toHaveLength(1);
  });

  /**
   * The other half of the defect this pass had: a `q` whose control point and
   * endpoint both round onto the current point draws nothing, and a builder that
   * writes it anyway emits runs of `q0 0 0 0 0 0 0 0`.
   */
  it('writes nothing for a command that draws nothing', () => {
    const pb = new PathBuilder(2);
    pb.moveTo(5, 5);
    for (let i = 0; i < 4; i++) pb.quadTo(5.001, 4.999, 5.002, 5.001);
    expect(pb.toString()).toBe('M5 5');
  });

  it('does not flush a held-back line for a command that turns out not to exist', () => {
    // `close()` drops a final line that returns to the start, but only while it
    // is still the last thing written. A no-op `q` that flushed it would leave
    // the redundant line in the output for nothing.
    const pb = new PathBuilder(0);
    pb.moveTo(0, 0); pb.lineTo(10, 0); pb.lineTo(10, 10); pb.lineTo(0, 0);
    pb.quadTo(0.1, 0.1, 0.1, -0.1);
    pb.close();
    expect(pb.toString()).toBe('M0 0h10v10z');
  });
});
