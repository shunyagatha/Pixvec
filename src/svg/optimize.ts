/**
 * SVG optimisation — a small, conservative minifier.
 *
 * Not a full SVGO clone: a focused pass that shrinks vecline's own output (and
 * any SVG handed in) — strip comments and the XML prologue, collapse inter-tag
 * whitespace, round coordinates, and drop default attributes. Pure string
 * transformation.
 *
 * "Render-preserving by construction" is what this header used to claim, and it
 * was not true. Measured, rendered at 512px and compared channel by channel:
 *
 *   our own traced output   logo-tux, sticker: IDENTICAL. alpha-dice differs on
 *                           29,163 channels at max 3/255 — coordinate rounding,
 *                           below visibility.
 *   third-party SVGs        vector-tiger, vector-source, vector-comparison all
 *                           differ, max 48/255, because their artwork sits under
 *                           a scaling transform that amplifies the 0.005 user-unit
 *                           rounding error.
 *
 * So: safe on our own output, and lossy at the anti-aliasing level on scaled
 * third-party artwork. Raise `precision` when that matters. What it must never be
 * again is STRUCTURALLY destructive — see the transform note below for the defect
 * that made this worth measuring.
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
/**
 * WHY `transform` IS COPIED THROUGH UNTOUCHED.
 *
 * Two separate defects lived here, and only the first one looked like a defect.
 *
 * 1. `roundNumericList` rebuilds its output from the token matches alone, so every
 *    character that is not a letter or a number was discarded — including the
 *    parentheses that ARE the transform grammar. `matrix(1.77,0,0,1.77,324.9,255)`
 *    came back as `matrix1.77 0 0 1.77 324.9 255`, and `translate(20,30) rotate(45)`
 *    as `translate20 30rotate45`. Renderers drop an unparseable transform, so the
 *    element draws untransformed.
 *
 * 2. Fixing that and rounding the numbers in place was still wrong, which is the
 *    part worth recording. A transform's numbers are MULTIPLIERS, not coordinates.
 *    Rounding a path coordinate to two decimals moves that point by at most 0.005
 *    user units; rounding a SCALE factor by the same 0.005 rescales everything
 *    beneath it. On the corpus tiger, 1.7656463 -> 1.77 is a 0.2% scale error, and
 *    the render still differed on 106,927 channels after the parentheses were back.
 *
 * The saving was one attribute per document — tens of bytes — against a whole-subtree
 * geometric error. So the numbers are left exactly as they were found, and the
 * attribute is matched above only to keep the standalone rounder away from it.
 *
 * None of this ever touched our own output: the tracer emits absolute paths and no
 * transforms. It only ever damaged SVGs that came from somewhere else, which is
 * precisely what `sprite --minify` ingests.
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

/**
 * Remove every `open … close` span, in a single forward pass.
 *
 * This is a hand-rolled scan rather than a regex because every regex shape for
 * the job is quadratic on adversarial input. A lazy `/<!--[\s\S]*?-->/g` rescans
 * to end-of-string from each start position, and so does the "unrolled loop"
 * form `/<!--[^-]*(?:-(?!->)[^-]*)*-->/g` — the cost is not backtracking inside
 * one match, it is *failing* a match at every one of n start positions. On a
 * document of repeated unterminated `<!--` that measured 94 ms at 32 KB rising
 * to 3.8 s at 250 KB, clean 4x-per-doubling growth, reachable from
 * `vecline optimize` and `sprite --minify` with a file the user did not write.
 *
 * `indexOf` only ever moves forward, so the whole scan is linear. An
 * unterminated opener ends the scan and leaves the remainder untouched, which
 * is what the regexes did too — a comment nobody closed is not a comment.
 */
function stripSpans(
  text: string,
  open: string,
  close: string,
  opts: { trailingSpace?: boolean; caseInsensitive?: boolean } = {},
): string {
  const first = text.indexOf(open[0]);
  if (first === -1) return text;

  const matchesOpen = (at: number): boolean =>
    opts.caseInsensitive
      ? text.slice(at, at + open.length).toLowerCase() === open.toLowerCase()
      : text.startsWith(open, at);

  let out = '';
  let cursor = 0;
  let from = 0;
  let found = false;

  for (;;) {
    // Scan on the opener's first character, then confirm — this keeps the
    // case-insensitive form linear without lowercasing the whole document,
    // which is not length-preserving for every Unicode input.
    let start = -1;
    for (let i = text.indexOf(open[0], from); i !== -1; i = text.indexOf(open[0], i + 1)) {
      if (matchesOpen(i)) { start = i; break; }
    }
    if (start === -1) break;

    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;

    out += text.slice(cursor, start);
    cursor = end + close.length;
    if (opts.trailingSpace) {
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
    }
    from = cursor;
    found = true;
  }

  return found ? out + text.slice(cursor) : text;
}

/** Minify an SVG string, preserving what it renders. */
export function optimizeSvg(svg: string, opts: OptimizeOptions = {}): string {
  const precision = opts.precision ?? 2;
  const scale = 10 ** precision;
  const stripProlog = opts.stripProlog !== false;

  let out = svg;
  if (stripProlog) {
    out = stripSpans(out, '<?xml', '?>', { trailingSpace: true, caseInsensitive: true });
    out = stripSpans(out, '<!DOCTYPE', '>', { trailingSpace: true, caseInsensitive: true });
    out = stripSpans(out, '<!--', '-->');
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
    // `transform` is matched here only so the standalone rounder cannot reach it.
    const value = m[1] === 'transform' ? m[2] : roundNumericList(m[2], scale);
    rounded += ` ${m[1]}="${value}"`;
    last = m.index + m[0].length;
  }
  rounded += roundStandalone(out.slice(last), scale);

  return rounded
    // Drop attributes equal to their SVG default.
    .replace(/\s(?:fill|stroke)-opacity="1"/g, '')
    .replace(/\sfill-rule="nonzero"/g, '')
    .trim();
}
