import { describe, expect, it } from 'vitest';
import { measureSvgComplexity, countPathNodes } from '../src/svg/budget.js';
import { loadRaster, vectorize } from '../src/api.js';
import { encode, photoLike, flatArtwork } from './fixtures.js';

describe('countPathNodes', () => {
  it('counts one anchor per explicit command', () => {
    // M + 2×L + Z → 3 anchors (Z closes, it is not an anchor).
    expect(countPathNodes('M0 0 L10 0 L10 10 Z')).toBe(3);
  });

  it('counts implicit repetition, not just command letters', () => {
    // `M0 0 10 0 10 10` is a moveto plus two implied linetos.
    expect(countPathNodes('M0 0 10 0 10 10')).toBe(3);
    // One C with two coordinate sets is two curves.
    expect(countPathNodes('M0 0 C1 1 2 2 3 3 4 4 5 5 6 6')).toBe(3);
  });

  it('handles compact number forms (no separators, negatives, decimals)', () => {
    expect(countPathNodes('M10-5L.5.5')).toBe(2);
  });

  it('respects per-command arity', () => {
    expect(countPathNodes('M0 0 H10 V10')).toBe(3); // H/V take one number each
    expect(countPathNodes('M0 0 A5 5 0 0 1 10 10')).toBe(2); // arc takes seven
  });

  it('ignores unknown commands and empty input', () => {
    expect(countPathNodes('')).toBe(0);
    expect(countPathNodes('Z')).toBe(0);
  });
});

describe('measureSvgComplexity', () => {
  it('reports bytes, nodes and shapes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0 L10 10 Z"/></svg>';
    const c = measureSvgComplexity(svg);
    expect(c.bytes).toBe(new TextEncoder().encode(svg).length);
    expect(c.nodes).toBe(3);
    expect(c.shapes).toBe(1);
  });

  it('counts primitives as their Bézier-equivalent anchors', () => {
    const c = measureSvgComplexity('<svg><circle cx="5" cy="5" r="4"/><rect width="2" height="2"/></svg>');
    expect(c.nodes).toBe(8); // 4 + 4
    expect(c.shapes).toBe(2);
  });

  it('counts point lists by coordinate pair', () => {
    const c = measureSvgComplexity('<svg><polygon points="0,0 10,0 10,10"/></svg>');
    expect(c.nodes).toBe(3);
  });

  it('measures UTF-8 bytes, not JS string length', () => {
    const svg = '<svg><title>—</title></svg>'; // em dash is 3 bytes
    expect(measureSvgComplexity(svg).bytes).toBeGreaterThan(svg.length);
  });
});

describe('size budget (end to end)', () => {
  it('meets a byte budget and reports what it cost', async () => {
    const input = await loadRaster(await encode(photoLike(96, 72), 'png'));
    const unconstrained = await vectorize(input, { mode: 'trace' });
    const target = Math.floor(unconstrained.svg.length * 0.5);

    const r = await vectorize(input, { mode: 'trace', maxBytes: target });
    expect(r.budget).toBeDefined();
    const b = r.budget!;
    expect(b.targetBytes).toBe(target);
    expect(b.bytes).toBeLessThanOrEqual(target);
    expect(b.met).toBe(true);
    expect(b.steps).toBeGreaterThan(0);
    // The receipt: it knows the baseline and what the smaller file cost.
    expect(b.baselineBytes).toBeGreaterThan(b.bytes);
    expect(typeof b.ssim).toBe('number');
    expect(typeof b.baselineSsim).toBe('number');
    expect(b.ssimCost).toBeCloseTo(b.ssim! - b.baselineSsim!, 10);
  });

  it('meets a node budget', async () => {
    const input = await loadRaster(await encode(photoLike(96, 72), 'png'));
    const unconstrained = await vectorize(input, { mode: 'trace' });
    const target = Math.floor(measureSvgComplexity(unconstrained.svg).nodes * 0.5);

    const r = await vectorize(input, { mode: 'trace', maxNodes: target });
    expect(r.budget!.nodes).toBeLessThanOrEqual(target);
    expect(r.budget!.met).toBe(true);
  });

  it('takes no steps when the default already fits, and still reports', async () => {
    const input = await loadRaster(await encode(flatArtwork(60, 45), 'png'));
    const r = await vectorize(input, { mode: 'trace', maxBytes: 5_000_000 });
    expect(r.budget!.met).toBe(true);
    expect(r.budget!.steps).toBe(0);
    expect(r.budget!.bytes).toBe(r.budget!.baselineBytes);
    expect(r.budget!.ssimCost).toBe(0);
  });

  it('reports honestly when the budget is unreachable instead of silently failing', async () => {
    const input = await loadRaster(await encode(photoLike(96, 72), 'png'));
    const r = await vectorize(input, { mode: 'trace', maxBytes: 200 }); // absurd
    expect(r.budget!.met).toBe(false);
    expect(r.notes.join(' ')).toMatch(/could not reach the budget/i);
    // Still returns the closest real result, not an empty document.
    expect(r.svg).toContain('<svg');
  });
});
