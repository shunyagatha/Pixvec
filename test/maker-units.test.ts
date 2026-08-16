/**
 * Physical units, verified by measuring the file.
 *
 * A maker's failure mode is not an ugly curve — it is a part that comes out the
 * wrong size, discovered after the cut, in material. So these tests do not check
 * that a unit *option* was accepted; they parse the emitted coordinates back and
 * assert the geometry actually spans the promised physical distance.
 */

import { describe, expect, it } from 'vitest';
import { traceGeometry, toDxf, toGcode, DXF_UNITS } from '../src/io/export/index.js';
import { flatArtwork } from './fixtures.js';

/**
 * Every X and Y coordinate in the DXF's ENTITIES section.
 *
 * DXF is strictly alternating — a group code on one line, its value on the
 * next — so this must step in pairs. Scanning line by line instead reads a
 * *value* that happens to be `10` as though it were the X group code, and then
 * treats the following coordinate as data. The bug is invisible until the
 * numbers change: at one scale the file contained six such values, at another
 * none, and the two runs disagreed on how many coordinates existed.
 */
function coordinates(dxf: string): { xs: number[]; ys: number[] } {
  const lines = dxf.split('\n');
  const xs: number[] = [];
  const ys: number[] = [];
  // `ENTITIES` is itself the value of a `2` code, so the next group code
  // follows it — that is where the strict pairing begins.
  const start = lines.indexOf('ENTITIES') + 1;
  for (let i = start; i < lines.length - 1; i += 2) {
    const code = lines[i]?.trim();
    const value = Number(lines[i + 1]);
    if (!Number.isFinite(value)) continue;
    if (code === '10') xs.push(value);
    if (code === '20') ys.push(value);
  }
  return { xs, ys };
}

function headerValue(dxf: string, variable: string): string | null {
  const lines = dxf.split('\n');
  const at = lines.findIndex((l) => l.trim() === variable);
  // `9 / $VAR / 70 / <value>` — the value sits two lines past the name.
  return at === -1 ? null : (lines[at + 2] ?? null).trim();
}

describe('DXF physical units', () => {
  const source = flatArtwork(200, 100);
  const geometry = traceGeometry(source, { colors: 4 });

  it('declares no units by default, and says so rather than guessing', () => {
    const dxf = toDxf(geometry);
    // No HEADER at all is honest: the file makes no claim about scale.
    expect(dxf).not.toContain('$INSUNITS');
    expect(dxf).toContain('ENTITIES');
  });

  it('writes $INSUNITS and $MEASUREMENT when a unit is named', () => {
    const mm = toDxf(geometry, { units: 'mm' });
    expect(headerValue(mm, '$INSUNITS')).toBe(String(DXF_UNITS.mm));
    expect(headerValue(mm, '$MEASUREMENT')).toBe('1'); // metric

    const inch = toDxf(geometry, { units: 'in' });
    expect(headerValue(inch, '$INSUNITS')).toBe(String(DXF_UNITS.in));
    expect(headerValue(inch, '$MEASUREMENT')).toBe('0'); // imperial
  });

  it('emits geometry at the promised physical size', () => {
    // 200 px wide at 10 px/mm must span 20 mm. This is the assertion that
    // matters: a header saying "mm" over coordinates still in pixels would pass
    // every check except this one, and would cut ten times too big.
    const dxf = toDxf(geometry, { units: 'mm', pixelsPerUnit: 10 });
    const { xs, ys } = coordinates(dxf);

    expect(xs.length).toBeGreaterThan(0);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    // The traced outline need not touch every edge, so this bounds rather than
    // equates — but it must sit in millimetre territory, not pixel territory.
    expect(spanX).toBeLessThanOrEqual(20 + 0.01);
    expect(spanY).toBeLessThanOrEqual(10 + 0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(20 + 0.01);
  });

  it('scales every entity, not just some of them', () => {
    // The first version of this feature scaled the circle and ellipse
    // coordinates and missed the polyline vertices — which are the bulk of a
    // real file. The header would have promised millimetres over pixels.
    const unscaled = coordinates(toDxf(geometry, { units: 'mm' }));
    const scaled = coordinates(toDxf(geometry, { units: 'mm', pixelsPerUnit: 10 }));

    expect(scaled.xs.length).toBe(unscaled.xs.length);
    for (let i = 0; i < scaled.xs.length; i++) {
      expect(scaled.xs[i]!).toBeCloseTo(unscaled.xs[i]! / 10, 2);
    }
    for (let i = 0; i < scaled.ys.length; i++) {
      expect(scaled.ys[i]!).toBeCloseTo(unscaled.ys[i]! / 10, 2);
    }
  });

  it('refuses a zero or negative scale instead of collapsing the drawing', () => {
    // A scale of 0 would divide every coordinate into Infinity or NaN and emit
    // a structurally valid file containing no usable geometry — the kind of
    // failure that survives every check until it reaches a machine.
    for (const bad of [0, -5]) {
      const dxf = toDxf(geometry, { units: 'mm', pixelsPerUnit: bad });
      const { xs } = coordinates(dxf);
      expect(xs.every((v) => Number.isFinite(v))).toBe(true);
      expect(xs.some((v) => v > 0)).toBe(true);
    }
  });

  it('keeps the Y flip while scaling — DXF is Y-up, images are Y-down', () => {
    const dxf = toDxf(geometry, { units: 'mm', pixelsPerUnit: 10 });
    const { ys } = coordinates(dxf);
    // Nothing may fall below the origin; a mishandled flip is the usual way a
    // part ends up mirrored or off the bed.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.01);
  });
});

/**
 * The three ways these exporters used to produce a file that looked fine and
 * ruined a piece of material. All of them exited 0.
 */
describe('exports refuse rather than mislead', () => {
  it('will not scale a DXF without saying what the numbers mean', () => {
    // `pixelsPerUnit` divides every coordinate, but the HEADER declaring
    // $INSUNITS is written only when `units` is set — so this emitted a drawing
    // spanning 8.00 of *something*, and the importer guessed. That is the exact
    // failure the file's own doc comment warns about.
    const g = traceGeometry(flatArtwork(64, 64), {});
    expect(() => toDxf(g, { pixelsPerUnit: 8 })).toThrow(/units/i);
    // With both, it is fine — the guard must not block the legitimate call.
    expect(() => toDxf(g, { pixelsPerUnit: 8, units: 'mm' })).not.toThrow();
    // And no scale at all is fine: unscaled pixel coordinates are honest.
    expect(() => toDxf(g, {})).not.toThrow();
  });

  it('will not emit G-code that cuts nothing', () => {
    // Centreline returns [] for a blank image, an over-eager threshold, or ink
    // that is light on dark. The old behaviour was a valid 9-line program with
    // zero cutting moves, discovered at the machine.
    expect(() => toGcode([], { height: 64, units: 'mm' })).toThrow(/no polylines/i);
    expect(() => toGcode([[{ x: 0, y: 0 }]], { height: 64, units: 'mm' })).toThrow(/no polylines/i);
  });

  it('will not emit G-code with the whole job below the origin', () => {
    // Y is flipped as `height - y`, so a missing height made every coordinate
    // negative — measured -62..0 on a 64px drawing, the entire job off the bed.
    const poly = [[{ x: 0, y: 0 }, { x: 10, y: 10 }]];
    // @ts-expect-error height is required now; this is the call that used to work
    expect(() => toGcode(poly, { units: 'mm' })).toThrow(/height/i);

    const out = toGcode(poly, { height: 64, units: 'mm' });
    const ys = [...out.matchAll(/Y(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });
});
