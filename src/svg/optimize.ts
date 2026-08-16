/**
 * SVG optimisation — a small, conservative minifier.
 *
 * Not a full SVGO clone: a focused pass that shrinks vecline's own output (and
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

/** Attributes whose value is a list of numbers, where separators are load-bearing. */
const NUMERIC_LISTS = /\s(d|points|transform|viewBox)="([^"]*)"/g;

/** A path/transform token: a command letter, or a number. Everything else is separator. */
const TOKEN = /[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Round one number, keeping the original text if it is not finite. */
function round(text: string, scale: number): string {
  const n = Math.round(parseFloat(text) * scale) / scale;
  return Number.isFinite(n) ? String(n) : text;
}

/**
 * Round numbers that stand alone — `x`, `y`, `offset`, `opacity`, `stroke-width`
 * and friends, plus any stray decimals in text. Each value is independent here,
 * so there is no separator to lose.
 */
function roundStandalone(chunk: string, scale: number): string {
  return chunk.replace(/-?\d*\.\d+(?:e-?\d+)?/gi, (m) => round(m, scale));
}

/**
 * Round the numbers in a numeric list, re-inserting separators where rounding
 * removed the one the grammar was relying on.
 *
 * SVG path data lets two numbers abut with no delimiter whenever the second
 * cannot be misread as part of the first — `l12.004.513` is *two* numbers,
 * because a second decimal point ends the first. Rounding each number in place
 * with a context-free regex is therefore not safe: `12.004` becomes `12`, the
 * `.` that was doing the separating disappears, and `12` followed by `0.51`
 * reads back as the single number `120.51`. The path silently moves, and since
 * the document is still well-formed XML, nothing downstream complains.
 *
 * So separators are decided *after* rounding, from the emitted text rather than
 * the source text: a delimiter is needed unless the next token starts with `-`
 * (always self-delimiting) or starts with `.` while the previous number still
 * has its decimal point to end on.
 */
function roundNumericList(value: string, scale: number): string {
  let out = '';
  let prevWasNumber = false;
  let prevHadDot = false;

  for (const m of value.matchAll(TOKEN)) {
    const tok = m[0];

    if (/[A-Za-z]/.test(tok)) {
      // A command letter delimits by itself, on both sides.
      out += tok;
      prevWasNumber = false;
      prevHadDot = false;
      continue;
    }

    const text = round(tok, scale);

    if (prevWasNumber) {
      const first = text[0];
      const selfDelimiting = first === '-' || (first === '.' && prevHadDot);
      if (!selfDelimiting) out += ' ';
    }

    out += text;
    prevWasNumber = true;
    prevHadDot = text.includes('.');
  }

  return out;
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
    // content (only <title> in vecline output) sits between tags, so this leaves
    // a lone title intact while removing pretty-print indentation.
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ');

  // Walk the document once, rounding numeric-list attributes under the path
  // grammar and everything else as standalone values. Splitting rather than
  // substituting placeholders keeps the two rounders from ever seeing each
  // other's text, with nothing to collide over.
  let rounded = '';
  let last = 0;
  NUMERIC_LISTS.lastIndex = 0;
  for (let m = NUMERIC_LISTS.exec(out); m !== null; m = NUMERIC_LISTS.exec(out)) {
    rounded += roundStandalone(out.slice(last, m.index), scale);
    rounded += ` ${m[1]}="${roundNumericList(m[2], scale)}"`;
    last = m.index + m[0].length;
  }
  rounded += roundStandalone(out.slice(last), scale);

  return rounded
    // Drop attributes equal to their SVG default.
    .replace(/\s(?:fill|stroke)-opacity="1"/g, '')
    .replace(/\sfill-rule="nonzero"/g, '')
    .trim();
}
