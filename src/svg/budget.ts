/**
 * SVG complexity measurement — the honest half of a size budget.
 *
 * "Make it smaller" is the loudest request every tracer gets, and the usual
 * answer is an opaque simplification slider: you move it, the file shrinks, and
 * nobody tells you what it cost. Vecline can do better, because it already
 * renders its own output and scores it — so a budget here is always paired with
 * a *receipt* saying exactly how much accuracy the smaller file bought.
 *
 * This module is the measuring half: given an SVG string it reports the two
 * quantities a budget can target, which are **not** interchangeable —
 *
 * - **bytes** — what a browser downloads. Coordinate precision and whitespace
 *   move this without touching geometry at all.
 * - **nodes** — how many anchor points the geometry carries. This is what an
 *   illustrator feels when editing, and what survives minification.
 *
 * Cutting precision shrinks bytes and leaves nodes untouched; dropping a colour
 * removes whole regions and changes both, non-monotonically. That is exactly
 * why the two are reported (and targeted) separately rather than hidden behind
 * one "quality" knob.
 *
 * Pure: a string in, counts out. No dependencies, no Node built-ins.
 */

export interface SvgComplexity {
  /** UTF-8 byte length — what actually crosses the wire. */
  bytes: number;
  /** Total anchor points across all geometry (see the per-element notes below). */
  nodes: number;
  /** Drawable elements: `<path>`, `<circle>`, `<rect>`, `<image>`, … */
  shapes: number;
}

/** Anchor-producing path commands and how many numbers each consumes. */
const PARAMS: Record<string, number> = {
  m: 2, l: 2, t: 2, // moveto / lineto / smooth-quadratic
  h: 1, v: 1,       // horizontal / vertical lineto
  c: 6,             // cubic
  s: 4, q: 4,       // smooth-cubic / quadratic
  a: 7,             // elliptical arc
  z: 0,             // closepath adds no anchor
};

/**
 * Count the anchor points in one `d` attribute.
 *
 * Path data allows *implicit repetition* — `M10 10 20 20` is a moveto followed
 * by an implied lineto — so counting command letters alone under-reports. The
 * numbers between commands are counted and divided by the command's arity,
 * which handles both forms.
 */
export function countPathNodes(d: string): number {
  let nodes = 0;
  // Split into [command letter, the run of numbers that follows].
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const arity = PARAMS[m[1].toLowerCase()];
    if (!arity) continue; // Z/z, or an unknown command
    // Numbers may be separated by commas, spaces, or just a sign / decimal
    // point (`10-5`, `.5.5`), so match them rather than splitting.
    const count = (m[2].match(/-?\.?\d[\d.eE+-]*/g) ?? []).length;
    nodes += Math.max(1, Math.floor(count / arity));
  }
  return nodes;
}

/**
 * Measure an SVG's size and geometric complexity.
 *
 * Primitives are counted as the anchor count of their Bézier equivalent — a
 * `<circle>` is 4, the same as the four-curve path it replaces — so switching a
 * region to a primitive shows up as the byte win it is without pretending the
 * shape vanished.
 */
export function measureSvgComplexity(svg: string): SvgComplexity {
  const bytes = new TextEncoder().encode(svg).length;

  let nodes = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) nodes += countPathNodes(m[1]);
  // Point lists carry one anchor per coordinate pair.
  for (const m of svg.matchAll(/<(?:polygon|polyline)\b[^>]*\spoints="([^"]*)"/g)) {
    nodes += Math.floor((m[1].match(/-?\.?\d[\d.eE+-]*/g) ?? []).length / 2);
  }
  nodes += 4 * count(svg, /<(?:circle|ellipse|rect)\b/g);
  nodes += 2 * count(svg, /<line\b/g);

  const shapes = count(svg, /<(?:path|circle|ellipse|rect|line|polygon|polyline|image)\b/g);
  return { bytes, nodes, shapes };
}

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}
