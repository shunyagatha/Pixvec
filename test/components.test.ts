import { describe, expect, it } from 'vitest';
import { connectedComponents, despeckle } from '../src/vectorize/components.js';

/**
 * Component bounding boxes had no test, and a type bug hid in that gap for a
 * long time: the min-corner sentinel was `Number.MAX_SAFE_INTEGER` stored into
 * an `Int32Array`, where it truncates to -1. Since every real coordinate is
 * greater than -1, the running minimum never updated and every component
 * reported x0 = y0 = -1.
 *
 * Nothing rendered wrong, so 500+ tests stayed green — but despeckle iterates
 * the bounding box, so each speck swept from (-1,-1) to its far corner instead
 * of over itself. On a one-megapixel photograph that was 9 billion cell visits
 * and 103 seconds for work that takes well under a second.
 *
 * These tests assert the geometry directly, because "the output looks right" is
 * exactly the check that missed it.
 */
describe('connectedComponents bounds', () => {
  /** A class map with one isolated pixel of class 1 at (x, y) in a field of 0. */
  function lone(width: number, height: number, x: number, y: number): Int32Array {
    const classes = new Int32Array(width * height); // all class 0
    classes[y * width + x] = 1;
    return classes;
  }

  it('gives a single pixel a 1x1 box at its own coordinates', () => {
    const w = 64, h = 32, x = 49, y = 7;
    const comps = connectedComponents(lone(w, h, x, y), w, h, -1);
    const c = comps.labels[y * w + x];
    const b = c * 4;
    expect([comps.bounds[b], comps.bounds[b + 1], comps.bounds[b + 2], comps.bounds[b + 3]])
      .toEqual([x, y, x, y]);
    expect(comps.areas[c]).toBe(1);
  });

  it('never reports a negative min corner', () => {
    // A scattering of specks — the case that made the truncation expensive.
    const w = 40, h = 40;
    const classes = new Int32Array(w * h);
    for (let i = 0; i < w * h; i += 7) classes[i] = 1 + (i % 3);
    const comps = connectedComponents(classes, w, h, -1);
    for (let c = 0; c < comps.count; c++) {
      const b = c * 4;
      expect(comps.bounds[b]).toBeGreaterThanOrEqual(0);
      expect(comps.bounds[b + 1]).toBeGreaterThanOrEqual(0);
      // and the box must not be inverted
      expect(comps.bounds[b + 2]).toBeGreaterThanOrEqual(comps.bounds[b]);
      expect(comps.bounds[b + 3]).toBeGreaterThanOrEqual(comps.bounds[b + 1]);
    }
  });

  it('bounds a rectangle exactly, with no slack', () => {
    const w = 50, h = 50;
    const classes = new Int32Array(w * h);
    for (let y = 10; y <= 20; y++) for (let x = 30; x <= 44; x++) classes[y * w + x] = 1;
    const comps = connectedComponents(classes, w, h, -1);
    const c = comps.labels[15 * w + 35];
    const b = c * 4;
    expect([comps.bounds[b], comps.bounds[b + 1], comps.bounds[b + 2], comps.bounds[b + 3]])
      .toEqual([30, 10, 44, 20]);
  });

  it('the total bounding-box area is proportional to the specks, not the frame', () => {
    // The performance property, stated as geometry so it cannot silently rot:
    // N isolated single pixels must cost N cells to sweep, not N x frame.
    const w = 200, h = 200;
    const classes = new Int32Array(w * h);
    let specks = 0;
    for (let i = 0; i < w * h; i += 137) { classes[i] = 1; specks++; }
    const comps = connectedComponents(classes, w, h, -1);
    let boxCells = 0;
    for (let c = 0; c < comps.count; c++) {
      if (comps.areas[c] !== 1) continue;
      const b = c * 4;
      boxCells += (comps.bounds[b + 2] - comps.bounds[b] + 1)
        * (comps.bounds[b + 3] - comps.bounds[b + 1] + 1);
    }
    // Every single-pixel component contributes exactly one cell.
    expect(boxCells).toBeLessThanOrEqual(specks);
  });
});

describe('despeckle', () => {
  it('absorbs a speck into the colour surrounding it', () => {
    const w = 20, h = 20;
    const classes = new Int32Array(w * h); // class 0 everywhere
    classes[10 * w + 10] = 5;              // one stray pixel
    const comps = connectedComponents(classes, w, h, -1);
    const merged = despeckle(classes, comps, w, h, 2, -1);
    expect(merged).toBe(1);
    expect(classes[10 * w + 10]).toBe(0);
  });

  it('leaves a component at or above the threshold alone', () => {
    const w = 20, h = 20;
    const classes = new Int32Array(w * h);
    for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) classes[y * w + x] = 5; // 16 px
    const comps = connectedComponents(classes, w, h, -1);
    despeckle(classes, comps, w, h, 4, -1);
    expect(classes[6 * w + 6]).toBe(5);
  });
});

describe('traceComponents records which region lies across each boundary edge', () => {
  /**
   * The walk already had to know this — it tests `labels[neighbour] !== c` to decide
   * an edge exists at all — and threw it away. Keeping it is what lets a later pass
   * tell "this run of boundary is shared with region 7" from "…with region 12".
   *
   * Two neighbours currently hold two private copies of the boundary between them.
   * That is invisible while both copies are the same staircase, and becomes visible
   * the moment either is smoothed: the copies drift apart and the background shows
   * through. Knowing the pair is the first requirement for smoothing it once.
   */
  const bands = async (W = 12, H = 6) => {
    const { connectedComponents } = await import('../src/vectorize/components.js');
    const { traceComponents } = await import('../src/vectorize/contour.js');
    const labels = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) labels[y * W + x] = x < 4 ? 0 : x < 8 ? 1 : 2;
    const comps = connectedComponents(labels, W, H, -1);
    return { comps, loops: traceComponents(comps.labels, W, H, comps.count) };
  };

  it('names both neighbours of a band that sits between two others', async () => {
    const { comps, loops } = await bands();
    const { OUTSIDE_FRAME } = await import('../src/vectorize/contour.js');
    // Find the middle band by the classes it borders, not by index.
    const seenPerComponent = [];
    for (let c = 0; c < comps.count; c++) {
      for (const l of loops[c] ?? []) {
        seenPerComponent.push([...new Set(Array.from(l.otherSide ?? []))].sort((a, b) => a - b));
      }
    }
    // Exactly one band borders two other regions; the outer two border one each.
    const withTwoNeighbours = seenPerComponent.filter(
      (s) => s.filter((v) => v !== OUTSIDE_FRAME).length === 2,
    );
    expect(withTwoNeighbours).toHaveLength(1);
    expect(seenPerComponent.filter((s) => s.filter((v) => v !== OUTSIDE_FRAME).length === 1)).toHaveLength(2);
  });

  it('marks the image border rather than inventing a region there', async () => {
    const { loops } = await bands();
    const { OUTSIDE_FRAME } = await import('../src/vectorize/contour.js');
    const all = loops.flat().flatMap((l) => Array.from(l.otherSide ?? []));
    expect(all).toContain(OUTSIDE_FRAME);
    // The sentinel must be distinct from -1, which means "labelled void".
    expect(OUTSIDE_FRAME).not.toBe(-1);
  });

  it('keeps one neighbour entry per emitted vertex', async () => {
    const { loops } = await bands();
    for (const l of loops.flat()) {
      expect(l.otherSide, 'a loop came back with no neighbour data').toBeDefined();
      expect(l.otherSide!.length).toBe(l.pts.length / 2);
    }
  });
});

/**
 * `--preset clean` ships `minArea: 4`, and lowering it to 2 was measured and
 * REFUTED — see the recorded finding above `PRESETS.clean` in src/api.ts.
 *
 * These pin the two facts that finding rests on, because the argument for
 * lowering it arrives as a table of 1x SSIM against each subject's own source,
 * and that instrument cannot see either of them.
 */
describe('minArea 4 stays at 4 (recorded finding, src/api.ts)', () => {
  /** Isolated components of class 5 with areas 1..5, five rows apart so none touch. */
  function ladder(w = 40, h = 40): Int32Array {
    const classes = new Int32Array(w * h); // class 0 everywhere
    for (let area = 1; area <= 5; area++) {
      const y = area * 5;
      for (let i = 0; i < area; i++) classes[y * w + 5 + i] = 5;
    }
    return classes;
  }

  it('the gap between minArea 2 and minArea 4 is exactly the 2- and 3-pixel components', () => {
    // `despeckle` absorbs components whose area is strictly BELOW the threshold,
    // so 4 -> 2 is not a nudge along a smooth trade: it is the decision to keep
    // every two- and three-pixel component in the picture, and nothing else.
    // Stated as a test because the proposal was argued as a tuning step.
    const w = 40, h = 40;
    const at2 = ladder(w, h);
    const merged2 = despeckle(at2, connectedComponents(at2, w, h, -1), w, h, 2, -1);
    const at4 = ladder(w, h);
    const merged4 = despeckle(at4, connectedComponents(at4, w, h, -1), w, h, 4, -1);

    expect(merged2).toBe(1); // the single stray pixel
    expect(merged4).toBe(3); // areas 1, 2 and 3

    // Named individually, so a change to the comparison cannot pass on counts alone.
    const survives = (classes: Int32Array, area: number) => classes[area * 5 * w + 5] === 5;
    expect([1, 2, 3, 4, 5].filter((a) => survives(at2, a))).toEqual([2, 3, 4, 5]);
    expect([1, 2, 3, 4, 5].filter((a) => survives(at4, a))).toEqual([4, 5]);
  });

  it('lowering the floor buys geometry, which the byte axis understates', async () => {
    // Corpus-wide the proposal is 1.497x subpaths for 1.074x gzip, and gzip is
    // the axis that got quoted. The direction is asserted here on a fixture so
    // the cost is not lost when someone re-runs only the SSIM table.
    const { vectorize, PRESETS } = await import('../src/api.js');
    const { pathStats } = await import('../scripts/lib/path-stats.mjs');
    const { createImage, mulberry32, setPixel } = await import('./fixtures.js');

    // Flat artwork that arrived damaged — the input this preset exists for.
    const size = 96;
    const img = createImage(size, size);
    const rand = mulberry32(11);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = x >= 12 && x < 44 && y >= 12 && y < 44
          ? [200, 30, 40]
          : Math.hypot(x - 60, y - 60) < 20 ? [30, 90, 190] : [245, 245, 245];
        const n = Math.round((rand() * 2 - 1) * 20);
        setPixel(img, x, y, c[0] + n, c[1] + n, c[2] + n, 255);
      }
    }

    const count = async (minArea: number) => pathStats(
      (await vectorize({ image: img }, { mode: 'trace', preset: 'clean', trace: { minArea } })).svg,
    ).subpaths;

    expect(PRESETS.clean.minArea).toBe(4);
    expect(await count(2)).toBeGreaterThan(await count(4));
  });
});
