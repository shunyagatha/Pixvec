/**
 * Count what an SVG path actually draws.
 *
 * Counting command LETTERS undercounts, and badly: SVG lets one letter carry many
 * parameter groups, so `c a b c d e f  g h i j k l` is one `c` and two curves. A
 * letter census of logo-tux reported 299 curves where the path draws 1,062.
 *
 * The same trap in the other direction — matching `[A-Za-z]` over the whole file
 * rather than inside `d="..."` — counts hex digits in fill colours as path
 * commands, which is how `clean` was once reported to emit 4 curves when it emits
 * none at all.
 */

/** Parameters per group, by command. `z` closes and takes none. */
const ARITY = {
  m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0,
};

/** Numbers in a path: optional sign, digits, optional fraction, optional exponent. */
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/**
 * Expand one `d` attribute into a flat list of drawing commands.
 *
 * A repeated group after `m` is an implicit `l` (and after `M` an implicit `L`),
 * which is in the spec and is easy to miss — it is why a polygon traced as one
 * `M` plus a run of pairs must not be counted as a single move.
 */
export function commands(d) {
  const out = [];
  for (const chunk of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const letter = chunk[1];
    const key = letter.toLowerCase();
    const arity = ARITY[key];
    if (arity === undefined) continue;
    if (arity === 0) { out.push(key); continue; }
    const nums = chunk[2].match(NUMBER) ?? [];
    const groups = Math.max(1, Math.floor(nums.length / arity));
    for (let g = 0; g < groups; g++) {
      // Only the first group keeps the letter's own meaning; a repeat after a
      // moveto draws a line.
      out.push(g === 0 || key !== 'm' ? key : 'l');
    }
  }
  return out;
}

const CURVE = new Set(['c', 's', 'q', 't', 'a']);
const LINE = new Set(['l', 'h', 'v']);

/** Segment census over every path in a document. */
export function pathStats(svg) {
  const counts = Object.create(null);
  let curves = 0;
  let lines = 0;
  let subpaths = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    for (const c of commands(m[1])) {
      counts[c] = (counts[c] ?? 0) + 1;
      if (CURVE.has(c)) curves++;
      else if (LINE.has(c)) lines++;
      else if (c === 'm') subpaths++;
    }
  }
  // Primitive elements draw real geometry too, and a mosaic that promotes a
  // region to <circle> would otherwise look like it lost segments.
  const primitives = (svg.match(/<(?:circle|ellipse|rect|polygon)\b/g) ?? []).length;
  const segments = curves + lines;
  return {
    counts, curves, lines, segments, subpaths, primitives,
    curvePct: segments === 0 ? 0 : (curves / segments) * 100,
  };
}
