/**
 * The structure gate's instrument, checked against known answers.
 *
 * This repo has been burned twice by a measurement that could not fail: a curve
 * census that counted command LETTERS read 299 where the path drew 1,062, and a
 * later one that matched `[A-Za-z]` over the whole file counted hex digits in
 * fill colours as path commands. Both reported confident numbers. So the thing
 * that decides whether CI goes red gets its own tests, on inputs whose answers
 * are known by construction rather than by running the tracer and writing down
 * what came out.
 */

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line
import { canvas, coordinateDecimals, edgeKey, elements, segmentLength, segments, structure } from '../scripts/lib/svg-structure.mjs';
// eslint-disable-next-line
import { TOLERANCE, diff, within } from '../scripts/lib/structure-gate.mjs';

describe('segments', () => {
  it('expands an implicit repeat after a moveto into linetos', () => {
    // "M 0 0 10 0 10 10" is one moveto and TWO lines, per the SVG grammar. A
    // reader that treats every group after `M` as another moveto sees three
    // movetos and no geometry at all.
    const segs = segments('M0 0 10 0 10 10Z');
    expect(segs.map((s: { type: string }) => s.type)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    // The last L is the one `z` draws, from (10,10) back to (0,0).
    expect(segs[3].p).toEqual([10, 10, 0, 0]);
  });

  it('does not invent a closing line when the path already returned to the start', () => {
    // Four explicit sides, cursor back on the start, so `z` draws nothing.
    expect(segments('M0 0h10v10h-10v-10z').filter((s: { type: string }) => s.type === 'L')).toHaveLength(4);
    // Three explicit sides: `z` draws the fourth, and it is a real edge.
    expect(segments('M0 0h10v10h-10z').filter((s: { type: string }) => s.type === 'L')).toHaveLength(4);
  });

  it('resolves relative commands and the h/v shorthands against the cursor', () => {
    const segs = segments('M5 5h10v-4l-2 2');
    expect(segs[1].p).toEqual([5, 5, 15, 5]);
    expect(segs[2].p).toEqual([15, 5, 15, 1]);
    expect(segs[3].p).toEqual([15, 1, 13, 3]);
  });

  it('reflects the previous control point for S and T', () => {
    const [, , smooth] = segments('M0 0C1 1 2 2 3 3S5 5 6 6');
    // S reflects (2,2) about (3,3), giving (4,4).
    expect(smooth.p.slice(0, 4)).toEqual([3, 3, 4, 4]);
  });
});

describe('segmentLength', () => {
  it('measures a half-circle drawn as an arc to within a thousandth of pi*r', () => {
    const [, arc] = segments('M0 0A10 10 0 0 1 0 20');
    expect(segmentLength(arc)).toBeCloseTo(Math.PI * 10, 2);
  });

  it('measures a straight cubic as its chord', () => {
    const [, cubic] = segments('M0 0C3 0 6 0 9 0');
    expect(segmentLength(cubic)).toBeCloseTo(9, 6);
  });
});

describe('edgeKey', () => {
  const keyOf = (d: string, i = 1) => edgeKey(segments(d)[i], 2);

  it('gives a line and the same line drawn backwards one key', () => {
    expect(keyOf('M1 2L7 9')).toBe(keyOf('M7 9L1 2'));
  });

  it('gives a cubic and its reverse one key, control points swapped', () => {
    expect(keyOf('M0 0C1 4 6 5 8 2')).toBe(keyOf('M8 2C6 5 1 4 0 0'));
  });

  it('gives a quadratic and its reverse one key', () => {
    expect(keyOf('M0 0Q3 7 9 1')).toBe(keyOf('M9 1Q3 7 0 0'));
  });

  it('flips the sweep flag when an elliptical arc is reversed', () => {
    // Reversing an arc keeps rx, ry, rotation and the large-arc flag and
    // inverts sweep. Miss this and every arc in a file that uses them — 24% of
    // the rival's segments on logo-tux — reads as an unshared edge.
    expect(keyOf('M0 0A5 3 20 1 1 8 6')).toBe(keyOf('M8 6A5 3 20 1 0 0 0'));
  });

  it('does not merge an arc with one of the opposite sweep', () => {
    expect(keyOf('M0 0A5 3 20 1 1 8 6')).not.toBe(keyOf('M0 0A5 3 20 1 0 8 6'));
  });

  it('does not merge a cubic with one whose control points differ', () => {
    expect(keyOf('M0 0C1 4 6 5 8 2')).not.toBe(keyOf('M0 0C1 4 6 4 8 2'));
  });

  it('does not merge a line with a cubic that draws over it', () => {
    expect(keyOf('M0 0L9 0')).not.toBe(keyOf('M0 0C3 0 6 0 9 0'));
  });
});

describe('elements', () => {
  it('inherits fill from an enclosing group, so a stroke pass is not a face', () => {
    // The rival wraps 95 seam-cover strokes in <g fill="none">. Reading only the
    // element's own attribute would count all of them as faces.
    const svg = '<svg viewBox="0 0 10 10"><g fill="none" stroke="#123456">'
      + '<path d="M0 0L5 5"/></g><path d="M0 0h10v10h-10z" fill="#ff0000"/></svg>';
    const els = elements(svg);
    expect(els).toHaveLength(2);
    expect(els[0].fill).toBe('none');
    expect(els[1].fill).toBe('#ff0000');
  });
});

describe('coordinateDecimals and canvas', () => {
  it('reads the deepest precision any coordinate is written with', () => {
    expect(coordinateDecimals('<path d="M0 0L1.5 2.25 3.125 4"/>')).toBe(3);
  });

  it('ignores numbers outside d, so a colour is not mistaken for a coordinate', () => {
    expect(coordinateDecimals('<path fill="#1.23456" d="M0 0L1.5 2"/>')).toBe(1);
  });

  it('prefers the viewBox over width/height', () => {
    expect(canvas('<svg width="80" height="90" viewBox="0 0 40 50">')).toEqual({ x: 0, y: 0, w: 40, h: 50 });
  });
});

describe('structure: the twin census', () => {
  /**
   * Two squares meeting along x=5, each drawing the shared edge in its own
   * direction. This is the mosaic property in its smallest form: every edge
   * that is not on the canvas border is drawn exactly twice, in opposite
   * directions, so the answer is 100%.
   */
  const MOSAIC = '<svg viewBox="0 0 10 10">'
    + '<path fill="#a00" d="M0 0L5 0L5 10L0 10Z"/>'
    + '<path fill="#0a0" d="M5 0L10 0L10 10L5 10Z"/>'
    + '</svg>';

  it('scores a two-face mosaic at 100% and finds one interior edge per side', () => {
    const s = structure(MOSAIC);
    expect(s.interiorEdges).toBe(2);
    expect(s.twinnedEdges).toBe(2);
    expect(s.twinPct).toBe(100);
  });

  it('excludes edges that run along the canvas border', () => {
    // Each square draws four edges: three along the frame and one along the
    // divider. Six of the eight are frame; the divider is drawn twice and both
    // copies stay in the census.
    expect(structure(MOSAIC).borderEdges).toBe(6);
  });

  it('does not mistake a divider that spans the image for a frame edge', () => {
    // Both endpoints of the divider touch the frame — one the top edge, one the
    // bottom. "Both ends are on a border" therefore classifies the most
    // interior edge in the picture as a frame edge, and empties the census.
    const s = structure(MOSAIC);
    expect(s.interiorEdges).toBe(2);
    expect(s.borderEdges + s.interiorEdges).toBe(8);
  });

  it('scores the same two faces at 0% when they disagree about the divider', () => {
    // The same picture, but the right-hand face puts its divider at 5.02 —
    // a seam of one fiftieth of a pixel, invisible in a render, and exactly
    // what independent per-face fitting produces.
    const seam = '<svg viewBox="0 0 10 10">'
      + '<path fill="#a00" d="M0 0L5 0L5 10L0 10Z"/>'
      + '<path fill="#0a0" d="M5.02 0L10 0L10 10L5.02 10Z"/>'
      + '</svg>';
    const s = structure(seam);
    expect(s.interiorEdges).toBe(2);
    expect(s.twinPct).toBe(0);
  });

  it('counts a twin across two subpaths of one element, not just across elements', () => {
    // Two same-colour faces are emitted as one <path> with two subpaths. The
    // boundary between them is genuinely shared; a rule that demanded a
    // different element would call it unshared for a serialisation reason.
    const merged = '<svg viewBox="0 0 10 10">'
      + '<path fill="#a00" d="M0 0L5 0L5 10L0 10ZM5 0L10 0L10 10L5 10Z"/>'
      + '</svg>';
    expect(structure(merged).twinPct).toBe(100);
  });

  it('does not let one subpath twin with itself', () => {
    // A degenerate loop that retraces its own edge. Counting that as sharing
    // would let any producer reach 100% by drawing every boundary twice.
    const selfy = '<svg viewBox="0 0 100 100"><path fill="#a00" d="M20 20L60 40L20 20Z"/></svg>';
    expect(structure(selfy).twinnedEdges).toBe(0);
  });

  it('ignores zero-length edges rather than pairing them with each other', () => {
    const degenerate = '<svg viewBox="0 0 10 10">'
      + '<path fill="#a00" d="M2 2L2 2L8 8Z"/><path fill="#0a0" d="M3 3L3 3L9 9Z"/>'
      + '</svg>';
    const s = structure(degenerate);
    expect(s.degenerateEdges).toBe(2);
    expect(s.twinnedEdges).toBe(0);
  });

  it('counts anchors and boundary length so px-per-anchor is the real ratio', () => {
    // One 10x10 square: four anchors, forty pixels of boundary.
    const square = '<svg viewBox="0 0 20 20"><path fill="#a00" d="M5 5h10v10h-10z"/></svg>';
    const s = structure(square);
    expect(s.anchors).toBe(4);
    expect(s.boundaryLength).toBeCloseTo(40, 9);
    expect(s.pxPerAnchor).toBeCloseTo(10, 9);
  });

  it('does not count a stroke-only path as a face', () => {
    const withSeamCover = '<svg viewBox="0 0 10 10">'
      + '<g fill="none"><path stroke="#123" d="M5 0L5 10"/></g>'
      + '<path fill="#a00" d="M0 0L5 0L5 10L0 10Z"/>'
      + '<path fill="#0a0" d="M5 0L10 0L10 10L5 10Z"/>'
      + '</svg>';
    const s = structure(withSeamCover);
    expect(s.faces).toBe(2);
    expect(s.strokeOnly).toBe(1);
    // The stroke retraces a boundary that is already shared. If it were counted,
    // a producer could raise its own score by drawing more strokes.
    expect(s.interiorEdges).toBe(2);
    expect(s.twinPct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// The comparison half. A gate that cannot go red is the defect this whole file
// exists to prevent, so the conditions under which it goes red are tested
// directly rather than inferred from one green run.
// ---------------------------------------------------------------------------

/** A measured row with every gated figure present and plausible. */
const row = (over: Record<string, unknown> = {}) => ({
  subject: 'flat-disc',
  producer: 'vecline clean',
  gated: true,
  curvePct: 88.82,
  twinPct: 87.5,
  pxPerAnchor: 27.22,
  segments: 161,
  subpaths: 7,
  fills: 4,
  bytes: 3459,
  gzip: 1318,
  ssim: 0.9811,
  ...over,
});
const baselineOf = (r = row()) => ({ preset: 'clean', rows: [r] });

describe('structure gate', () => {
  it('passes when nothing moved', () => {
    expect(diff([row()], baselineOf())).toEqual([]);
  });

  it('fails when the curve fraction collapses — the v2.1.0 defect', () => {
    const problems = diff([row({ curvePct: 0 })], baselineOf());
    expect(problems.map((p: { metric: string }) => p.metric)).toContain('curvePct');
  });

  it('fails when faces stop agreeing about the boundary between them', () => {
    const problems = diff([row({ twinPct: 40.5 })], baselineOf());
    expect(problems.find((p: { metric: string }) => p.metric === 'twinPct')?.verdict).toBe('WORSE');
  });

  it('fails when a rectangle subject starts emitting curves', () => {
    // keycap is rectangles: 0% is correct there and any curve is a regression,
    // which a one-sided "curves must not fall" gate would wave straight through.
    const keycap = row({ subject: 'keycap', curvePct: 0 });
    const problems = diff([{ ...keycap, curvePct: 23.08 }], baselineOf(keycap));
    expect(problems.map((p: { metric: string }) => p.metric)).toContain('curvePct');
  });

  it('fails when a figure improves, so the baseline cannot go stale', () => {
    // Not pedantry. A floor nobody refreshes drifts far below the real output
    // and stops being able to catch anything short of a collapse.
    expect(diff([row({ bytes: 2000 })], baselineOf())
      .find((p: { metric: string }) => p.metric === 'bytes')?.verdict).toBe('better');
  });

  it('fails when SSIM is in the baseline but this run measured none', () => {
    // The renderer is an optional dependency. Skipping an absent figure would
    // remove the fidelity floor silently, and every structural axis above it is
    // then won outright by emitting one big ellipse.
    const ssim = diff([row({ ssim: null })], baselineOf())
      .find((p: { metric: string }) => p.metric === 'ssim');
    expect(ssim?.kind).toBe('unmeasured');
    expect(ssim?.message).toMatch(/no fidelity floor/);
  });

  it('fails when the run produced a row the baseline does not have', () => {
    expect(diff([row({ subject: 'brand-new' })], baselineOf())[0].kind).toBe('new');
  });

  it('fails when the baseline has a row the run did not produce', () => {
    // Deleting a subject is how a gate gets quietly disarmed.
    expect(diff([], baselineOf())[0].kind).toBe('missing');
  });

  it('ignores rows that are reported but not gated', () => {
    // Corpus subjects have no committed inputs, so they can never be gated —
    // but the baseline row still has to be accounted for.
    const problems = diff([row({ subject: 'logo-tux', gated: false, curvePct: 1 })], baselineOf());
    expect(problems.map((p: { kind: string }) => p.kind)).toEqual(['missing']);
  });

  it('accepts either the absolute or the relative allowance, whichever is kinder', () => {
    // 2% of 7 subpaths is 0.14, which would hold a small count to an impossible
    // standard; the absolute allowance of 1 is what applies there.
    expect(within(8, 7, TOLERANCE.subpaths)).toBe(true);
    expect(within(9, 7, TOLERANCE.subpaths)).toBe(false);
    // On a large count the relative allowance is the kinder one.
    expect(within(3520, 3459, TOLERANCE.bytes)).toBe(true);
    expect(within(3600, 3459, TOLERANCE.bytes)).toBe(false);
  });
});
