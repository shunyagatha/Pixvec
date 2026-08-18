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
