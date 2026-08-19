import { describe, expect, it } from 'vitest';
import { traceComponents } from '../src/vectorize/contour.js';
import { connectedComponents } from '../src/vectorize/components.js';
import {
  decomposeToArcs, rebuildFace, verifyTwins, isInterior,
} from '../src/vectorize/arcs.js';

/**
 * Build a label map from a picture drawn as strings, one character per class.
 *
 * Far easier to reason about than a raster, and every case below is small enough
 * that the expected arc structure can be counted by hand.
 */
function scene(rows: string[]): { labels: Int32Array; width: number; height: number; count: number } {
  const height = rows.length;
  const width = rows[0].length;
  const classes = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) classes[y * width + x] = rows[y].charCodeAt(x);
  }
  const cc = connectedComponents(classes, width, height, -1);
  return { labels: cc.labels, width, height, count: cc.count };
}

function decompose(rows: string[]) {
  const { labels, width, height, count } = scene(rows);
  const loops = traceComponents(labels, width, height, count, 'left', undefined, true);
  const dec = decomposeToArcs(loops, labels, width, height);
  return { dec, loops, labels, width, height };
}

/** Equal as cycles: a closed path has no privileged starting vertex. */
function sameCycle(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  const m = a.length / 2;
  for (let r = 0; r < m; r++) {
    let ok = true;
    for (let i = 0; i < m; i++) {
      const j = (i + r) % m;
      if (a[i * 2] !== b[j * 2] || a[i * 2 + 1] !== b[j * 2 + 1]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

describe('decomposeToArcs', () => {
  it('shares one boundary between two regions instead of giving each a copy', () => {
    // Left half A, right half B. The vertical crack between them is one arc, and
    // both faces must reference that same arc, in opposite directions.
    const { dec } = decompose([
      'AAABBB',
      'AAABBB',
      'AAABBB',
      'AAABBB',
    ]);
    const interior = dec.arcs.filter(isInterior);
    expect(interior).toHaveLength(1);
    expect(interior[0].pts.length / 2).toBe(2); // straight run collapses to its ends

    const refs = [...dec.faces.values()];
    expect(refs).toHaveLength(2);
    const uses = refs.flat().filter((r) => isInterior(dec.arcs[r.arc]));
    expect(uses).toHaveLength(2);
    expect(uses.map((u) => u.reversed).sort()).toEqual([false, true]);
  });

  it('splits at a junction where three regions meet', () => {
    // A over the top, B and C splitting the bottom. The T-junction at the centre
    // must end A|B and begin A|C, so A's boundary is more than one arc.
    const { dec } = decompose([
      'AAAAAA',
      'AAAAAA',
      'BBBCCC',
      'BBBCCC',
    ]);
    const pairs = dec.arcs.filter(isInterior).map((a) => `${a.a}|${a.b}`).sort();
    // Three distinct region pairs meet: A|B, A|C and B|C.
    expect(new Set(pairs).size).toBe(3);
    expect(verifyTwins(dec).unpaired).toBe(0);
  });

  it('treats a region with no junction at all as one closed arc', () => {
    // An island inside a field. Neither boundary carries a junction, so the whole
    // ring is a single arc that both faces walk in opposite directions.
    //
    // A plus rather than a square, deliberately. Both faces of a rectangle happen
    // to start their walk at the same lattice vertex, so a rectangle cannot tell
    // whether closed arcs are being rotated to a common start — and without that
    // rotation the two faces key different strings and each ends up with a
    // private copy. Here the island starts at (4,1) and the hole at (3,1), which
    // is the case that matters; on the real corpus it is 26 to 118 unpaired arcs
    // across six of eight subjects.
    const { dec } = decompose([
      'AAAAAAA',
      'AAABAAA',
      'AABBBAA',
      'ABBBBBA',
      'AABBBAA',
      'AAABAAA',
      'AAAAAAA',
    ]);
    const interior = dec.arcs.filter(isInterior);
    expect(interior).toHaveLength(1);
    expect(interior[0].closed).toBe(true);

    const uses = [...dec.faces.values()].flat().filter((r) => isInterior(dec.arcs[r.arc]));
    expect(uses).toHaveLength(2);
    expect(uses.map((u) => u.reversed).sort()).toEqual([false, true]);
  });

  it('rebuilds every face from its arcs', () => {
    // The property that makes the decomposition safe to substitute for the loops.
    const { dec, loops } = decompose([
      'AAABBBCC',
      'AAABBBCC',
      'DDBBBBCC',
      'DDDDEECC',
      'DDDDEEEE',
      'FFFFEEEE',
    ]);
    let checked = 0;
    for (const perComponent of loops) {
      for (const loop of perComponent) {
        const refs = dec.faces.get(loop);
        expect(refs).toBeDefined();
        expect(sameCycle(rebuildFace(refs!, dec.arcs), loop.pts)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('pairs every interior arc on a busy scene', () => {
    const { dec } = decompose([
      'AABBCCAA',
      'ABBCCAAB',
      'BBCCAABB',
      'BCCAABBC',
      'CCAABBCC',
      'CAABBCCA',
      'AABBCCAA',
    ]);
    const report = verifyTwins(dec);
    expect(report.unpaired).toBe(0);
    expect(report.paired).toBeGreaterThan(5);
  });

  it('refuses loops traced without junction retention', () => {
    // Without splitAtJunctions the collinear collapse drops a junction sitting on
    // a straight run, and one face's arc would span two of its neighbour's. The
    // walk also omits otherSide, so this is caught rather than silently wrong.
    const { labels, width, height, count } = scene([
      'AAAAAA',
      'AAAAAA',
      'BBBCCC',
      'BBBCCC',
    ]);
    const loops = traceComponents(labels, width, height, count, 'left', undefined, true);
    for (const perComponent of loops) for (const l of perComponent) delete l.otherSide;
    expect(() => decomposeToArcs(loops, labels, width, height)).toThrow(/splitAtJunctions/);
  });

  it('splits where one region meets itself diagonally', () => {
    // The saddle, and the only thing the crack-degree half of the junction test
    // does. P occupies two diagonally-opposite cells around the centre vertex and
    // is a single component via the border; Q and R hold the other two corners.
    // Walking Q past that vertex, the neighbour is P before AND after, so the
    // otherSide test sees no change at all — but four cracks meet there, and P's
    // two arms pass it separately. Without the degree test Q emits one arc across
    // a vertex where P emits two, and the twins stop matching.
    //
    // Not hypothetical: on photo-parrots this fires 622 times, and a dump of the
    // cells around one reads tl=4 tr=1 bl=38 br=4 with otherSide 4 on both sides.
    const { dec } = decompose([
      'PPPPP',
      'PPQQQ',
      'PRPPP',
      'PPPPP',
    ]);
    expect(verifyTwins(dec).unpaired).toBe(0);
  });

  it('counts frame-touching arcs as boundary, not interior', () => {
    const { dec } = decompose([
      'AAABBB',
      'AAABBB',
    ]);
    const report = verifyTwins(dec);
    // Every region here touches the image border, so there is real boundary.
    expect(report.boundary).toBeGreaterThan(0);
    expect(report.unpaired).toBe(0);
  });
});
