import { describe, expect, it } from 'vitest';
import { traceComponents } from '../src/vectorize/contour.js';
import { connectedComponents } from '../src/vectorize/components.js';
import { decomposeToArcs, fitFaces, isInterior, reversePath } from '../src/vectorize/arcs.js';
import { fitOpen, regulariseOpen } from '../src/vectorize/fit.js';
import type { FittedPath, Segment } from '../src/vectorize/fit.js';
import { PRESETS, vectorize } from '../src/api.js';
import { createImage, setPixel } from './fixtures.js';
// eslint-disable-next-line
import { pathStats } from '../scripts/lib/path-stats.mjs';

const FIT = { tolerance: 0.4, fitError: 0.4, cornerAngle: 75, regularise: 2, regulariseBand: 0.75 };

/**
 * Every on-curve and control point a path visits, rounded so ties are stable.
 *
 * EXHAUSTIVE OVER SEGMENT KINDS, and the `never` check is the point of it. The
 * first version tested `if (s.kind === 'curve')` and pushed only the endpoint for
 * anything else, so when a third kind arrived this helper stopped seeing its
 * control point — a quadratic whose control point was 405 units wrong produced a
 * fingerprint identical to the correct one, while the same substitution on a cubic
 * was caught. That silently blinded the test which proves the mosaic's defining
 * property, in exactly the way this project's own rule about gates being able to
 * fail is meant to prevent.
 *
 * Adding a fourth kind must now fail to compile here rather than quietly weaken
 * the assertion.
 */
function points(p: FittedPath): string[] {
  const n = (v: number): string => v.toFixed(9);
  const out = [`${n(p.start.x)},${n(p.start.y)}`];
  for (const s of p.segments) {
    switch (s.kind) {
      case 'line':
        break;
      case 'quad':
        out.push(`${n(s.x1)},${n(s.y1)}`);
        break;
      case 'curve':
        out.push(`${n(s.x1)},${n(s.y1)}`, `${n(s.x2)},${n(s.y2)}`);
        break;
      default: {
        const unreachable: never = s;
        throw new Error(`points() does not handle segment kind ${JSON.stringify(unreachable)}`);
      }
    }
    out.push(`${n(s.x)},${n(s.y)}`);
  }
  return out;
}

describe('the twin fingerprint itself', () => {
  it('sees the control point of every segment kind', () => {
    // Guards the helper above, because a blind fingerprint makes every assertion
    // built on it vacuous and nothing else would notice.
    const move = (seg: Segment): Segment => (
      seg.kind === 'line' ? { ...seg, x: seg.x + 400 }
        : seg.kind === 'quad' ? { ...seg, x1: seg.x1 + 400 }
          : { ...seg, x1: seg.x1 + 400 });
    const kinds: Segment[] = [
      { kind: 'line', x: 10, y: 0 },
      { kind: 'quad', x1: 5, y1: 5, x: 10, y: 0 },
      { kind: 'curve', x1: 3, y1: 3, x2: 7, y2: 3, x: 10, y: 0 },
    ];
    for (const seg of kinds) {
      const base: FittedPath = { start: { x: 0, y: 0 }, segments: [seg] };
      const moved: FittedPath = { start: { x: 0, y: 0 }, segments: [move(seg)] };
      expect(points(base), `kind ${seg.kind} is invisible to points()`)
        .not.toEqual(points(moved));
    }
  });
});

function scene(rows: string[]) {
  const height = rows.length;
  const width = rows[0].length;
  const classes = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) classes[y * width + x] = rows[y].charCodeAt(x);
  }
  const cc = connectedComponents(classes, width, height, -1);
  const loops = traceComponents(cc.labels, width, height, cc.count, 'left', undefined, true);
  return { loops, labels: cc.labels, width, height };
}

describe('reversePath', () => {
  it('swaps control points rather than refitting', () => {
    const forward: FittedPath = {
      start: { x: 0, y: 0 },
      segments: [{ kind: 'curve', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }],
    };
    expect(reversePath(forward)).toEqual({
      start: { x: 5, y: 6 },
      segments: [{ kind: 'curve', x1: 3, y1: 4, x2: 1, y2: 2, x: 0, y: 0 }],
    });
  });

  it('round-trips exactly', () => {
    const p: FittedPath = {
      start: { x: 2.5, y: -1.25 },
      segments: [
        { kind: 'curve', x1: 3, y1: 0, x2: 4, y2: 1, x: 5, y: 2 },
        { kind: 'line', x: 9, y: 7 },
        { kind: 'curve', x1: 10, y1: 8, x2: 11, y2: 9, x: 12, y: 10 },
      ],
    };
    expect(reversePath(reversePath(p))).toEqual(p);
  });
});

describe('fitOpen', () => {
  it('holds both endpoints exactly, because they are junctions', () => {
    // Everything between may move within the band; the ends may not, or the
    // boundary would come apart where three regions meet.
    const pts: number[] = [];
    for (let i = 0; i <= 20; i++) pts.push(i, i % 2 === 0 ? 0 : 1);
    const fitted = fitOpen(pts, FIT)!;
    expect(fitted.start).toEqual({ x: 0, y: 0 });
    const last = fitted.segments[fitted.segments.length - 1];
    expect([last.x, last.y]).toEqual([20, 0]);
  });

  it('leaves a two-point run as a single line', () => {
    const fitted = fitOpen([0, 0, 10, 4], FIT)!;
    expect(fitted.segments).toEqual([{ kind: 'line', x: 10, y: 4 }]);
  });
});

describe('regulariseOpen', () => {
  it('pins the endpoints and moves the middle', () => {
    const n = 9;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = i; py[i] = i % 2; }
    regulariseOpen(px, py, n, 0.75, 4);
    expect(px[0]).toBe(0);
    expect(py[0]).toBe(0);
    expect(px[n - 1]).toBe(n - 1);
    expect(py[n - 1]).toBe((n - 1) % 2);
    // The zig-zag between them flattens toward the mean.
    let spread = 0;
    for (let i = 1; i < n - 1; i++) spread = Math.max(spread, Math.abs(py[i] - 0.5));
    expect(spread).toBeLessThan(0.5);
  });
});

describe('fitFaces', () => {
  it('gives the two sides of a shared boundary the same geometry, reversed', () => {
    // The property the whole arc structure exists for. An island and the field
    // around it share one closed arc; fitted once, the hole must be the island's
    // path run backwards — exactly, not approximately.
    const { loops, labels, width, height } = scene([
      'AAAAAAA',
      'AAABAAA',
      'AABBBAA',
      'ABBBBBA',
      'AABBBAA',
      'AAABAAA',
      'AAAAAAA',
    ]);
    const dec = decomposeToArcs(loops, labels, width, height);
    const faces = fitFaces(dec, FIT);

    // Interior only: the field's outer boundary is a closed arc too — it runs
    // along the image frame — and it has no twin, so including it would make
    // this three faces and hide what is being asserted.
    const shared = [...faces.entries()].filter(([loop]) => {
      const refs = dec.faces.get(loop)!;
      return refs.length === 1 && dec.arcs[refs[0].arc].closed && isInterior(dec.arcs[refs[0].arc]);
    });
    expect(shared).toHaveLength(2);

    const [a, b] = shared.map(([, path]) => path);
    // ORDERED, not sorted. Reversing a path does not change its point SET, so a
    // sorted comparison passes even when the two faces are handed identical
    // geometry and one of them therefore winds the wrong way — which is the one
    // thing this test exists to catch. Mutation-checked: dropping the reversal in
    // fitFaces left a sorted version of this assertion entirely green.
    expect(points(reversePath(a))).toEqual(points(b));
  });

  it('winds a hole opposite to the region it sits in', () => {
    // The consequence of the assertion above, at the level a renderer can see: if
    // both faces walked the shared arc the same way, the hole would wind with its
    // parent and the island would be painted over instead of cut out.
    const { loops, labels, width, height } = scene([
      'AAAAAAA',
      'AAABAAA',
      'AABBBAA',
      'ABBBBBA',
      'AABBBAA',
      'AAABAAA',
      'AAAAAAA',
    ]);
    const dec = decomposeToArcs(loops, labels, width, height);
    const faces = fitFaces(dec, FIT);

    /** Shoelace over the on-curve points — enough to get the sign right. */
    const area = (p: FittedPath): number => {
      const xs = [p.start.x, ...p.segments.map((s) => s.x)];
      const ys = [p.start.y, ...p.segments.map((s) => s.y)];
      let a2 = 0;
      for (let i = 0; i < xs.length; i++) {
        const j = (i + 1) % xs.length;
        a2 += xs[i] * ys[j] - xs[j] * ys[i];
      }
      return a2 / 2;
    };

    const interiorFaces = [...faces.entries()]
      .filter(([loop]) => {
        const refs = dec.faces.get(loop)!;
        return refs.length === 1 && isInterior(dec.arcs[refs[0].arc]);
      })
      .map(([loop, path]) => ({ lattice: loop.signedArea, fitted: area(path) }));

    expect(interiorFaces).toHaveLength(2);
    // One of each sign, and each fitted face agrees with the loop it came from.
    expect(interiorFaces.map((f) => Math.sign(f.fitted)).sort()).toEqual([-1, 1]);
    for (const f of interiorFaces) expect(Math.sign(f.fitted)).toBe(Math.sign(f.lattice));
  });

  it('produces a path for every face it was given', () => {
    const { loops, labels, width, height } = scene([
      'AAABBBCC',
      'AAABBBCC',
      'DDBBBBCC',
      'DDDDEECC',
      'DDDDEEEE',
      'FFFFEEEE',
    ]);
    const dec = decomposeToArcs(loops, labels, width, height);
    const faces = fitFaces(dec, FIT);
    expect(faces.size).toBe(dec.faces.size);
    for (const path of faces.values()) expect(path.segments.length).toBeGreaterThan(0);
  });
});

describe('mosaic end to end', () => {
  /** A disc, whose boundary is a staircase the fitter should turn into curves. */
  function disc(size = 64) {
    const img = createImage(size, size);
    const r = size / 2 - 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < r * r;
        const v = inside ? 40 : 230;
        setPixel(img, x, y, v, v, v, 255);
      }
    }
    return img;
  }

  // The shared counter, not a letter census. SVG lets one command letter carry
  // many parameter groups, so counting letters reported 299 curves on logo-tux
  // where the path draws 1,062 — and this test failed against its own subject
  // because a whole disc came out as a single `c`.
  const countCurves = (svg: string): number => (pathStats(svg) as { curves: number }).curves;

  it('emits curves where the same trace without it emits none', () => {
    // Douglas-Peucker cannot remove an untouched lattice vertex at the shipped
    // tolerance: the smallest deviation a staircase can present over a chord is
    // 1/sqrt(5) = 0.4472, above 0.4. So the plain trace is all lines, and the
    // mosaic — which smooths each arc once, off the lattice — is not.
    const img = disc();
    return Promise.all([
      vectorize({ image: img }, { mode: 'trace', trace: { subpixel: false } }),
      vectorize({ image: img }, { mode: 'trace', trace: { subpixel: false, mosaic: true } }),
    ]).then(([plain, mosaic]) => {
      expect(countCurves(plain.svg)).toBe(0);
      expect(countCurves(mosaic.svg)).toBeGreaterThan(4);
    });
  });

  it('honours a caller asking for more smoothing than the floor', async () => {
    const img = disc();
    const a = await vectorize({ image: img }, { mode: 'trace', trace: { subpixel: false, mosaic: true } });
    const b = await vectorize({ image: img }, {
      mode: 'trace', trace: { subpixel: false, mosaic: true, regularise: 12, regulariseBand: 0.75 },
    });
    expect(a.svg).not.toBe(b.svg);
  });

  it('leaves every other mode untouched', async () => {
    const img = disc();
    const off = await vectorize({ image: img }, { mode: 'trace' });
    const explicitOff = await vectorize({ image: img }, { mode: 'trace', trace: { mosaic: false } });
    expect(off.svg).toBe(explicitOff.svg);
  });
});

describe('the clean preset', () => {
  it('declares the mosaic and the seam stroke, so overriding works normally', () => {
    // In the preset rather than forced inside trace(): presets are merged before
    // the caller's own `trace` block, so `--stroke-width 0` still wins.
    expect(PRESETS.clean.mosaic).toBe(true);
    expect(PRESETS.clean.strokeWidth).toBe(1);
  });

  it('emits curves on flat art, where it used to emit none', async () => {
    const size = 72;
    const img = createImage(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - size / 2, y - size / 2);
        const v = d < size / 3 ? 30 : 235;
        setPixel(img, x, y, v, v, v, 255);
      }
    }
    const out = await vectorize({ image: img }, { mode: 'trace', preset: 'clean' });
    const stats = pathStats(out.svg) as { curves: number; curvePct: number };
    expect(stats.curves).toBeGreaterThan(0);
  });

  it('lets a caller turn the seam stroke back off', async () => {
    const size = 48;
    const img = createImage(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) setPixel(img, x, y, x < size / 2 ? 20 : 240, 128, 128, 255);
    }
    const on = await vectorize({ image: img }, { mode: 'trace', preset: 'clean' });
    const off = await vectorize({ image: img }, {
      mode: 'trace', preset: 'clean', trace: { strokeWidth: 0 },
    });
    expect(on.svg).toContain('stroke-width');
    expect(off.svg).not.toContain('stroke-width');
  });
});
