/**
 * SVG optimisation — a small, conservative minifier.
 *
 * Not a full SVGO clone: a focused pass that shrinks graver's own output (and
 * any SVG handed in) without changing what it renders — strip comments and the
 * XML prologue, collapse inter-tag whitespace, round coordinates, and drop
 * default attributes. Everything here is render-preserving by construction, so
 * it is safe to run by default. Pure string transformation.
 */

export interface OptimizeOptions {
  /** Decimals to keep in numeric values. Default 2. */
  precision?: number;
  /** Strip XML/doctype prologue and comments. Default true. */
  stripProlog?: boolean;
}

/** Minify an SVG string, preserving what it renders. */
export function optimizeSvg(svg: string, opts: OptimizeOptions = {}): string {
  const precision = opts.precision ?? 2;
  const scale = 10 ** precision;
  const stripProlog = opts.stripProlog !== false;

  let out = svg;
  if (stripProlog) {
    out = out
      .replace(/<\?xml[\s\S]*?\?>\s*/gi, '')
      .replace(/<!DOCTYPE[^>]*>\s*/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  out = out
    // Collapse whitespace *between* tags and runs of spaces inside them. Text
    // content (only <title> in graver output) sits between tags, so this leaves
    // a lone title intact while removing pretty-print indentation.
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    // Round decimal numbers (path data, coordinates, offsets, opacities). Only
    // values with a decimal point are touched; integers are already minimal and
    // hex colours have none.
    .replace(/-?\d*\.\d+(?:e-?\d+)?/gi, (m) => {
      const n = Math.round(parseFloat(m) * scale) / scale;
      return Number.isFinite(n) ? String(n) : m;
    })
    // Drop attributes equal to their SVG default.
    .replace(/\s(?:fill|stroke)-opacity="1"/g, '')
    .replace(/\sfill-rule="nonzero"/g, '')
    .trim();

  return out;
}
