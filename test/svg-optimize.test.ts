import { describe, expect, it } from 'vitest';
import { optimizeSvg } from '../src/svg/optimize.js';

/**
 * `optimize` must never make an SVG mean something different.
 *
 * It did. `transform` was routed through the numeric-list rounder, which rebuilds
 * its output from token matches alone and so dropped every parenthesis — the one
 * character that IS the transform grammar. Renderers discard an unparseable
 * transform, so the element drew untransformed, and the tool reported a saving.
 *
 * It never showed on our own output, which emits absolute paths and no transforms.
 * It only damaged SVGs that came from elsewhere — what `sprite --minify` ingests.
 */
describe('optimizeSvg leaves transforms intact', () => {
  const wrap = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

  it('keeps the parentheses that make a transform parseable', () => {
    const out = optimizeSvg(wrap('<g transform="matrix(1.7656463,0,0,1.7656463,324.90716,255.00942)"><rect width="1" height="1"/></g>'), {});
    expect(out).toContain('matrix(');
    expect(out).toContain(')');
    expect(out).not.toMatch(/matrix[\d-]/);
  });

  it('keeps multiple transform functions separated', () => {
    const out = optimizeSvg(wrap('<g transform="translate(20,30) rotate(45)"><rect width="1" height="1"/></g>'), {});
    // `translate20 30rotate45` was the old output: both parens gone and the two
    // function names fused to their arguments.
    expect(out).toMatch(/translate\(20[,\s]30\)/);
    expect(out).toMatch(/rotate\(45\)/);
    expect(out).not.toContain('30rotate');
  });

  it('does not round transform numbers, because they are multipliers not coordinates', () => {
    // Rounding a path coordinate to 2dp moves one point by <=0.005 user units.
    // Rounding a SCALE factor by the same amount rescales everything beneath it:
    // 1.7656463 -> 1.77 left the corpus tiger differing on 106,927 channels even
    // after the parentheses were restored.
    const t = 'matrix(1.7656463,0,0,1.7656463,324.90716,255.00942)';
    expect(optimizeSvg(wrap(`<g transform="${t}"><rect width="1" height="1"/></g>`), {})).toContain(t);
  });

  it('still rounds ordinary path coordinates', () => {
    const out = optimizeSvg(wrap('<path d="M1.23456 2.34567L3.45678 4.56789"/>'), {});
    expect(out).toContain('1.23');
    expect(out).not.toContain('1.23456');
  });
});

/**
 * `optimize` must never make an SVG mean something different.
 *
 * It did. `transform` was routed through the numeric-list rounder, which rebuilds
 * its output from token matches alone and so dropped every parenthesis — the one
 * character that IS the transform grammar. Renderers discard an unparseable
 * transform, so the element drew untransformed, and the tool reported a saving.
 *
 * It never showed on our own output, which emits absolute paths and no transforms.
 * It only damaged SVGs that came from elsewhere — what `sprite --minify` ingests.
 */
describe('optimizeSvg leaves transforms intact', () => {
  const wrap = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

  it('keeps the parentheses that make a transform parseable', () => {
    const out = optimizeSvg(wrap('<g transform="matrix(1.7656463,0,0,1.7656463,324.90716,255.00942)"><rect width="1" height="1"/></g>'), {});
    expect(out).toContain('matrix(');
    expect(out).not.toMatch(/matrix[\d-]/);
  });

  it('keeps multiple transform functions separated', () => {
    const out = optimizeSvg(wrap('<g transform="translate(20,30) rotate(45)"><rect width="1" height="1"/></g>'), {});
    // `translate20 30rotate45` was the old output: both parens gone and the two
    // function names fused to their arguments.
    expect(out).toMatch(/translate\(20[,\s]30\)/);
    expect(out).toMatch(/rotate\(45\)/);
    expect(out).not.toContain('30rotate');
  });

  it('does not round transform numbers, because they are multipliers not coordinates', () => {
    // Rounding a path coordinate to 2dp moves one point by <=0.005 user units.
    // Rounding a SCALE factor by the same amount rescales everything beneath it:
    // 1.7656463 -> 1.77 left the corpus tiger differing on 106,927 channels even
    // after the parentheses were restored.
    const t = 'matrix(1.7656463,0,0,1.7656463,324.90716,255.00942)';
    expect(optimizeSvg(wrap(`<g transform="${t}"><rect width="1" height="1"/></g>`), {})).toContain(t);
  });

  it('still rounds ordinary path coordinates', () => {
    const out = optimizeSvg(wrap('<path d="M1.23456 2.34567L3.45678 4.56789"/>'), {});
    expect(out).toContain('1.23');
    expect(out).not.toContain('1.23456');
  });
});

describe('optimizeSvg does not round a width as if it were a coordinate', () => {
  /**
   * `stroke-width` went through the standalone number rounder, which is written for
   * positions. Rounding a coordinate to `precision` moves a point by at most half a
   * unit — the trade `precision` exists to offer. Rounding a WIDTH by the same rule
   * doubles it: at precision 0, `stroke-width="0.5"` became `"1"`, painting the
   * stroke at twice its intended size.
   *
   * Same family as the `transform` defect above: a value rounded by a rule written
   * for something else. Found while measuring `strokeWidth`, which is what made it
   * reachable.
   */
  const wrap = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

  it('keeps the stroke width at every precision', () => {
    const svg = wrap('<path d="M1.234 1.234h8.567v8.9H1.234z" fill="#123" stroke="#123" stroke-width="0.5"/>');
    for (const precision of [2, 1, 0]) {
      const out = optimizeSvg(svg, { precision });
      expect(out, `precision ${precision} altered the stroke width`).toContain('stroke-width="0.5"');
    }
  });

  it('still rounds the coordinates beside it', () => {
    const svg = wrap('<path d="M1.234 1.234h8.567z" fill="#123" stroke="#123" stroke-width="0.5"/>');
    const out = optimizeSvg(svg, { precision: 1 });
    expect(out).toContain('stroke-width="0.5"');
    expect(out).toContain('1.2');
    expect(out).not.toContain('1.234');
  });

  it('protects the other width-valued attributes too', () => {
    const svg = wrap('<path d="M1 1h8z" stroke="#123" stroke-width="0.25" stroke-miterlimit="0.75" font-size="0.5"/>');
    const out = optimizeSvg(svg, { precision: 0 });
    expect(out).toContain('stroke-width="0.25"');
    expect(out).toContain('stroke-miterlimit="0.75"');
    expect(out).toContain('font-size="0.5"');
  });
});
