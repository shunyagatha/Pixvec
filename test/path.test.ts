import { describe, expect, it } from 'vitest';
import { PathBuilder, num } from '../src/svg/path.js';
import { rasterizeSvg } from '../src/io/rasterize.js';

/**
 * The compact path encoding is where correctness is easiest to lose and hardest
 * to notice: a missing separator produces a perfectly valid path string that
 * draws a different shape. These tests parse the output back rather than
 * comparing it to an expected string, so they check meaning rather than spelling.
 */

/** Minimal, strict tokeniser for SVG path number lists. */
function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?))/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(d)) !== null) {
    if (m.index !== consumed) {
      throw new Error(`Unparsed characters at ${consumed}: ${JSON.stringify(d.slice(consumed, m.index))}`);
    }
    out.push(m[1] ?? Number(m[2]));
    consumed = m.index + m[0].length;
    // Whitespace and commas are the only legal filler between tokens.
    while (consumed < d.length && /[\s,]/.test(d[consumed])) consumed++;
    re.lastIndex = consumed;
  }
  if (consumed !== d.length) {
    throw new Error(`Trailing garbage: ${JSON.stringify(d.slice(consumed))}`);
  }
  return out;
}

/** Replay a token stream into the absolute points it actually describes. */
function replay(tokens: Array<string | number>): number[] {
  const pts: number[] = [];
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd = '';

  const next = (): number => {
    const v = tokens[i++];
    if (typeof v !== 'number') throw new Error(`Expected number, got ${String(v)}`);
    return v;
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++] as string;
    switch (cmd) {
      case 'M': cx = next(); cy = next(); sx = cx; sy = cy; pts.push(cx, cy); cmd = 'L'; break;
      case 'm': cx += next(); cy += next(); sx = cx; sy = cy; pts.push(cx, cy); cmd = 'l'; break;
      case 'L': cx = next(); cy = next(); pts.push(cx, cy); break;
      case 'l': cx += next(); cy += next(); pts.push(cx, cy); break;
      case 'H': cx = next(); pts.push(cx, cy); break;
      case 'h': cx += next(); pts.push(cx, cy); break;
      case 'V': cy = next(); pts.push(cx, cy); break;
      case 'v': cy += next(); pts.push(cx, cy); break;
      case 'C': {
        const a = next(), b = next(), c = next(), dd = next();
        cx = next(); cy = next();
        pts.push(a, b, c, dd, cx, cy);
        break;
      }
      case 'c': {
        const a = cx + next(), b = cy + next(), c = cx + next(), dd = cy + next();
        const nx = cx + next(), ny = cy + next();
        pts.push(a, b, c, dd, nx, ny);
        cx = nx; cy = ny;
        break;
      }
      case 'z': case 'Z': cx = sx; cy = sy; break;
      default: throw new Error(`Unsupported command ${cmd}`);
    }
  }
  return pts;
}

describe('num', () => {
  it('drops the redundant leading zero', () => {
    expect(num(0.5, 2)).toBe('.5');
    expect(num(-0.5, 2)).toBe('-.5');
  });

  it('rounds to the requested precision', () => {
    expect(num(1.23456, 2)).toBe('1.23');
    expect(num(1.999, 2)).toBe('2');
    expect(num(3, 0)).toBe('3');
  });

  it('never emits exponent notation, which path data cannot parse', () => {
    expect(num(0.0000001, 8)).not.toContain('e');
    expect(num(1e-7, 8)).not.toContain('e');
  });

  it('normalises negative zero', () => {
    expect(num(-0.001, 2)).toBe('0');
  });
});

describe('PathBuilder separators', () => {
  it('round-trips a curve sequence through a strict parser', () => {
    const pb = new PathBuilder(3);
    pb.moveTo(24, 8);
    pb.curveTo(32.992, 8, 40.036, 10.045, 44, 15);
    pb.curveTo(44.416, 15.521, 43.63, 16.445, 44, 17);
    pb.curveTo(44.469, 17.704, 46.878, 19.084, 47, 20);
    pb.close();

    const points = replay(tokenize(pb.toString()));
    expect(points.slice(0, 2)).toEqual([24, 8]);
    // The final on-curve point of the last cubic.
    expect(points[points.length - 2]).toBeCloseTo(47, 6);
    expect(points[points.length - 1]).toBeCloseTo(20, 6);
  });

  /**
   * Regression: the command letter is omitted for repeated commands, which left
   * the separator logic looking at an empty buffer. "…3" followed by "1.341"
   * became "31.341" — a valid path describing a completely different shape.
   */
  it('separates numbers across an elided repeated command letter', () => {
    const pb = new PathBuilder(3);
    pb.moveTo(0, 0);
    pb.curveTo(1, 1, 2, 2, 3, 3);
    pb.curveTo(4.341, 13.054, 3.084, 22.132, -3, 27);

    const d = pb.toString();
    const points = replay(tokenize(d));
    expect(points[points.length - 2]).toBeCloseTo(-3, 6);
    expect(points[points.length - 1]).toBeCloseTo(27, 6);
    expect(d).not.toMatch(/31\.341/);
  });

  it('omits separators only where the grammar allows', () => {
    const pb = new PathBuilder(2);
    pb.moveTo(1, 1);
    pb.lineTo(1.5, 1);      // h.5 — dot is self-separating after "1"? no, needs space
    pb.lineTo(1.5, 2.5);
    pb.lineTo(-1.5, 2.5);
    const points = replay(tokenize(pb.toString()));
    expect(points).toEqual([1, 1, 1.5, 1, 1.5, 2.5, -1.5, 2.5]);
  });

  it('produces identical geometry to an absolute-coordinate encoding', async () => {
    const segments = [
      [32.992, 8, 40.036, 10.045, 44, 15],
      [44.416, 15.521, 43.63, 16.445, 44, 17],
      [44.469, 17.704, 46.878, 19.084, 47, 20],
      [48.341, 30.054, 47.084, 39.132, 41, 44],
      [40.479, 44.416, 39.555, 43.63, 39, 44],
    ];

    const pb = new PathBuilder(3);
    pb.moveTo(24, 8);
    for (const s of segments) pb.curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
    pb.close();

    let abs = 'M 24 8';
    for (const s of segments) abs += ` C ${s.map((v) => v.toFixed(3)).join(' ')}`;
    abs += ' Z';

    const render = async (d: string) => {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">` +
        `<path d="${d}" fill="#000"/></svg>`;
      const { image } = await rasterizeSvg(svg, { shapeRendering: 'crispEdges' });
      return image.data;
    };

    const [relative, absolute] = await Promise.all([render(pb.toString()), render(abs)]);
    expect(Buffer.from(relative.buffer as ArrayBuffer)).toEqual(
      Buffer.from(absolute.buffer as ArrayBuffer),
    );
  });
});

describe('PathBuilder.rect', () => {
  it('emits a closed axis-aligned rectangle', () => {
    const pb = new PathBuilder(0);
    pb.rect(3, 4, 10, 5);
    expect(replay(tokenize(pb.toString()))).toEqual([3, 4, 13, 4, 13, 9, 3, 9]);
  });

  it('keeps successive rectangles independent', () => {
    const pb = new PathBuilder(0);
    pb.rect(0, 0, 2, 2);
    pb.rect(5, 5, 3, 1);
    const pts = replay(tokenize(pb.toString()));
    expect(pts.slice(0, 8)).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
    expect(pts.slice(8)).toEqual([5, 5, 8, 5, 8, 6, 5, 6]);
  });
});
