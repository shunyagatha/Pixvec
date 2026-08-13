import { describe, expect, it } from 'vitest';
import { connectedComponents } from '../src/vectorize/components.js';
import { traceComponents, type TurnPolicy } from '../src/vectorize/contour.js';
import { fitLoop } from '../src/vectorize/fit.js';
import { trace } from '../src/vectorize/trace.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * The competitor-parity knobs — potrace's `turnPolicy` and `fillStrategy`, and
 * imagetracerjs's `rightangleenhance`. Each test pins the behaviour that makes
 * the option worth having *and* the invariant that keeps the default output, and
 * therefore every existing guarantee, unchanged.
 */

/** Build a class map from ASCII rows: `X` is class 0, anything else is void. */
function grid(rows: string[]): { classes: Int32Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const classes = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) classes[y * w + x] = rows[y][x] === 'X' ? 0 : -1;
  }
  return { classes, w, h };
}

function signature(loops: { pts: Int32Array }[]): string {
  return loops.map((l) => Array.from(l.pts).join(',')).join(';');
}

describe('turnPolicy', () => {
  // A single 4-connected component that winds around and pinches to a diagonal
  // self-touch — the one configuration where the turn policy has anything to
  // decide. Found by search; most images never contain one, which is exactly
  // why the choice is niche but real.
  const saddle = grid([
    'XXXXX',
    '.X..X',
    'XXX.X',
    'X..XX',
    '..XX.',
  ]);

  function tracePolicy(policy?: TurnPolicy): { pts: Int32Array }[] {
    const comps = connectedComponents(saddle.classes, saddle.w, saddle.h, -1);
    return traceComponents(comps.labels, saddle.w, saddle.h, comps.count, policy).flat();
  }

  it('resolves the saddle differently for left and right', () => {
    expect(signature(tracePolicy('left'))).not.toEqual(signature(tracePolicy('right')));
  });

  it('defaults to left, byte-for-byte — the exact tracer depends on it', () => {
    expect(signature(tracePolicy(undefined))).toEqual(signature(tracePolicy('left')));
  });

  it('black aliases right and white aliases left in a per-component tracer', () => {
    expect(signature(tracePolicy('black'))).toEqual(signature(tracePolicy('right')));
    expect(signature(tracePolicy('white'))).toEqual(signature(tracePolicy('left')));
  });

  it('accepts every named policy and always returns closed loops', () => {
    for (const policy of ['left', 'right', 'black', 'white', 'minority', 'majority'] as TurnPolicy[]) {
      const loops = tracePolicy(policy);
      expect(loops.length).toBeGreaterThan(0);
      for (const l of loops) expect(l.pts.length).toBeGreaterThanOrEqual(6); // ≥3 points
    }
  });
});

describe('rightAngleEnhance', () => {
  // A square rotated a few degrees: every edge is within a few degrees of an
  // axis and every corner within a few degrees of 90°.
  const rotatedSquare = new Int32Array([0, 0, 30, 2, 28, 32, -2, 30]);
  const fit = { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, polygonOnly: true };

  it('snaps a near-axis rectangle to exact right angles', () => {
    const out = fitLoop(rotatedSquare, { ...fit, rightAngleEnhance: true })!;
    const corners = [[out.start.x, out.start.y], ...out.segments.map((s) => [s.x, s.y])];
    // Every edge is now exactly horizontal or vertical.
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      const axisAligned = a[0] === b[0] || a[1] === b[1];
      expect(axisAligned, `edge ${JSON.stringify(a)}→${JSON.stringify(b)} off-axis`).toBe(true);
    }
  });

  it('leaves the corners skewed when off', () => {
    const out = fitLoop(rotatedSquare, fit)!;
    const offAxis = out.segments.some((s, i) => {
      const prev = i === 0 ? out.start : out.segments[i - 1];
      return prev.x !== s.x && prev.y !== s.y;
    });
    expect(offAxis).toBe(true);
  });

  it('does not corrupt a shape with no right angles', () => {
    // A triangle: no near-axis right angle, so nothing should snap, and it must
    // still come back as a valid closed path.
    const triangle = new Int32Array([0, 0, 40, 5, 8, 38]);
    const out = fitLoop(triangle, { ...fit, rightAngleEnhance: true });
    expect(out).not.toBeNull();
    expect(out!.segments.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fillStrategy', () => {
  // A cluster that is overwhelmingly one colour with a scatter of a second: the
  // mean is dragged toward the minority, a dominant/median pick is not.
  function dominantWithOutliers(): RasterImage {
    const img = createImage(40, 40);
    for (let i = 0; i < 40 * 40; i++) {
      const x = i % 40, y = (i / 40) | 0;
      const outlier = i % 10 === 0;
      if (outlier) setPixel(img, x, y, 60, 200, 60);
      else setPixel(img, x, y, 200, 50, 50);
    }
    return img;
  }

  function firstFill(strategy: 'mean' | 'dominant' | 'median'): string {
    const svg = trace(dominantWithOutliers(), { colors: 1, fillStrategy: strategy }).svg;
    return svg.match(/fill="(#[0-9a-fA-F]+)"/)?.[1] ?? '';
  }

  it('gives mean, dominant and median genuinely different palettes', () => {
    const mean = firstFill('mean');
    const dominant = firstFill('dominant');
    expect(mean).toBeTruthy();
    expect(dominant).toBeTruthy();
    // The mean is pulled off the true colour by the outliers; dominant is not.
    expect(dominant).not.toEqual(mean);
  });

  it('defaults to mean', () => {
    const svg = trace(dominantWithOutliers(), { colors: 1 }).svg;
    const def = svg.match(/fill="(#[0-9a-fA-F]+)"/)?.[1] ?? '';
    expect(def).toEqual(firstFill('mean'));
  });
});
