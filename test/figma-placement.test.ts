import { describe, expect, it } from 'vitest';
import { GAP, placement, type PlacementSource } from '../extensions/figma/src/place.js';

/**
 * The Figma plugin promises the traced copy lands beside your layer and never
 * over it. That promise is on the Community listing, in the plugin panel and on
 * a carousel slide, and it was false for every layer that lived inside a frame.
 *
 * The bug was a coordinate-space mix-up: `createNodeFromSvg` parents the result
 * to the page, where x and y are absolute, while `source.x` is relative to the
 * source's container. Adding them gave the right answer only when the container
 * *was* the page — which is what the single manual check used, so it passed.
 *
 * The plugin's own harness could not have caught it either: it asserted that one
 * node was inserted and never read where it went, and its fake node had no
 * parent, so it could not represent a nested layer at all. These cases are the
 * replacement. Each one asserts the copy does not overlap the source, in the
 * space the copy is actually positioned in.
 */

const source = (over: Partial<PlacementSource> = {}): PlacementSource => ({
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
  parent: null,
  ...over,
});

describe('figma placement', () => {
  it('puts a top-level layer to the right of itself', () => {
    const p = placement(source({
      x: 10, y: 20,
      absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 200 },
      parent: { canAppend: true, layoutMode: 'NONE' },
    }));
    expect(p.x).toBe(10 + 200 + GAP);
    expect(p.y).toBe(20);
  });

  it('does not add two coordinate spaces together for a nested layer', () => {
    // The regression. Source sits at (25, 30) inside a frame that is itself at
    // (300, 50), so its absolute position is (325, 80). The old code produced
    // x = 25 + 200 + 40 = 265 on the page — 60px to the LEFT of the frame origin
    // and squarely on top of the original, which is at absolute 325.
    const p = placement(source({
      x: 25, y: 30,
      absoluteBoundingBox: { x: 325, y: 80, width: 200, height: 200 },
      parent: { canAppend: true, layoutMode: 'NONE' },
    }));

    // Adopted by the frame, so the answer is in the frame's space alongside the
    // source — and must clear the source's right edge in that same space.
    expect(p.reparent).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(25 + 200);
    expect(p.x).toBe(25 + 200 + GAP);
    expect(p.y).toBe(30);

    // The specific wrong answer the old arithmetic gave, stated so a
    // reintroduction fails loudly rather than subtly.
    expect(p.x).not.toBe(325 + 200 + GAP);
  });

  it('stays on the page and uses absolute coordinates under auto-layout', () => {
    // Adopting the node here would let the parent reflow it into the stack, so
    // it stays a page child — where only the absolute box is meaningful.
    const p = placement(source({
      x: 25, y: 30,
      absoluteBoundingBox: { x: 325, y: 80, width: 200, height: 200 },
      parent: { canAppend: true, layoutMode: 'VERTICAL' },
    }));
    expect(p.reparent).toBe(false);
    expect(p.x).toBe(325 + 200 + GAP);
    expect(p.y).toBe(80);
  });

  it('uses absolute coordinates when the parent cannot take a child', () => {
    const p = placement(source({
      x: 25, y: 30,
      absoluteBoundingBox: { x: 325, y: 80, width: 200, height: 200 },
      parent: { canAppend: false },
    }));
    expect(p.reparent).toBe(false);
    expect(p.x).toBe(325 + 200 + GAP);
    expect(p.y).toBe(80);
  });

  it('still places to the right when there is no absolute box', () => {
    const p = placement(source({
      x: 25, y: 30, absoluteBoundingBox: null, parent: null,
    }));
    expect(p.reparent).toBe(false);
    expect(p.x).toBe(25 + 200 + GAP);
  });

  it('never overlaps the source, in the space the copy is positioned in', () => {
    // The listing says "never", so sweep the container origins rather than
    // trusting the four cases above to be representative.
    for (const px of [-500, -1, 0, 1, 300, 4096]) {
      for (const py of [-500, 0, 77, 4096]) {
        for (const layoutMode of ['NONE', 'VERTICAL'] as const) {
          const src = source({
            x: 25, y: 30,
            absoluteBoundingBox: { x: px + 25, y: py + 30, width: 200, height: 200 },
            parent: { canAppend: true, layoutMode },
          });
          const p = placement(src);
          // Compare like with like: a reparented copy shares the source's space,
          // otherwise both are expressed absolutely.
          const srcLeft = p.reparent ? src.x : src.absoluteBoundingBox!.x;
          const srcRight = srcLeft + src.width;
          expect(p.x, `origin ${px},${py} ${layoutMode}`).toBeGreaterThanOrEqual(srcRight);
        }
      }
    }
  });
});
