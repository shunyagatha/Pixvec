import { describe, expect, it } from 'vitest';
import { BYTES_PER_EDGE, traceComponents } from '../src/vectorize/contour.js';
import { heapLoopBudget } from '../src/io/loop-budget.js';
import { trace } from '../src/vectorize/trace.js';
import { flatArtwork } from './fixtures.js';

/**
 * The guard exists so an image too large for the machine ends with a sentence
 * instead of a V8 heap dump. Its two failure modes are opposite and both fatal
 * to trust: refusing work that would have finished, and letting a doomed run
 * proceed. Both are asserted here.
 */

/** A tiny label map: one filled square, so there is a boundary to trace. */
function labels(w: number, h: number): Int32Array {
  const l = new Int32Array(w * h).fill(-1);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) l[y * w + x] = 0;
  return l;
}

describe('loop budget guard', () => {
  it('is not consulted at all when no guard is passed', () => {
    const loops = traceComponents(labels(8, 8), 8, 8, 1);
    expect(loops[0]!.length).toBeGreaterThan(0);
  });

  it('proceeds when the guard approves, and reports the projected cost', () => {
    let seen = -1;
    const loops = traceComponents(labels(8, 8), 8, 8, 1, 'left', (bytes) => { seen = bytes; return null; });
    expect(loops[0]!.length).toBeGreaterThan(0);
    // A 6x6 filled square has 24 boundary edges; the projection is edges x the
    // measured per-edge cost, so it must be a positive multiple of it.
    expect(seen).toBeGreaterThan(0);
    expect(seen % BYTES_PER_EDGE).toBe(0);
  });

  it('aborts with the guard\'s own message rather than a generic one', () => {
    expect(() => traceComponents(labels(8, 8), 8, 8, 1, 'left', () => 'no room for this one'))
      .toThrow('no room for this one');
  });

  /**
   * The guard runs BEFORE the loops are built. If it ran after, it would be
   * reporting a cost already paid — which is the whole failure it exists to
   * prevent.
   */
  it('refuses before allocating, not after', () => {
    let calls = 0;
    expect(() => traceComponents(labels(64, 64), 64, 64, 1, 'left', () => { calls++; return 'stop'; }))
      .toThrow('stop');
    expect(calls).toBe(1);
  });

  it('reaches trace() through the loopBudget option', () => {
    expect(() => trace(flatArtwork(32, 24), { loopBudget: () => 'refused by policy' }))
      .toThrow('refused by policy');
    // And without it, the same image traces normally.
    expect(trace(flatArtwork(32, 24), {}).svg).toContain('<svg');
  });

  describe('heapLoopBudget', () => {
    it('allows a projection that fits the live heap', () => {
      expect(heapLoopBudget()(1024)).toBeNull();
    });

    it('refuses one that cannot, naming the numbers and a way forward', () => {
      // 50 GiB, chosen so its MB rendering is exact and cannot be confused with
      // the free-heap figure: reporting free where projected belongs produces a
      // message that reads fine and is wrong, so the number itself is asserted.
      const msg = heapLoopBudget()(50 * 1024 * 1024 * 1024);
      expect(msg).toContain('51,200 MB');
      expect(msg).toBeTruthy();
      expect(msg).toMatch(/heap/i);
      expect(msg).toMatch(/max-old-space-size/);
      expect(msg).toMatch(/min-area|mode embed/);
      // It must say nothing was written, because nothing was.
      expect(msg).toMatch(/Nothing was written/i);
    });
  });
});
