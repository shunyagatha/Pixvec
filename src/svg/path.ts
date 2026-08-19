/**
 * SVG path serialisation.
 *
 * Path data dominates the size of a vectorised file, so this builder is fussy
 * about two things: emitting the fewest possible characters, and never letting
 * that thrift change the geometry. Coordinates are snapped to the output
 * precision *before* relative offsets are computed, so rounding error cannot
 * accumulate along a path and drag corners out of place.
 */

/** Round to `precision` decimals and render without redundant characters. */
export function num(value: number, precision: number): string {
  const f = 10 ** precision;
  let v = Math.round(value * f) / f;
  if (Object.is(v, -0)) v = 0;

  let s = String(v);
  // Path data has no exponent form; force positional notation for tiny values.
  if (s.includes('e')) s = v.toFixed(Math.max(0, precision)).replace(/\.?0+$/, '') || '0';
  // ".5" and "-.5" are legal and one byte shorter than "0.5" / "-0.5".
  if (s.startsWith('0.')) s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s;
}

/** True when the number currently being built at the end of `chunk` contains a `.`. */
function trailingNumberHasDot(chunk: string): boolean {
  for (let i = chunk.length - 1; i >= 0; i--) {
    const c = chunk[i];
    if (c === '.') return true;
    if (c < '0' || c > '9') return false;
  }
  return false;
}

/**
 * Accumulates path commands, tracking the cursor so relative forms stay correct.
 *
 * Callers pass absolute user-space coordinates; the builder picks the encoding.
 */
export class PathBuilder {
  private out = '';
  private cx = 0;
  private cy = 0;
  private startX = 0;
  private startY = 0;
  private lastCommand = '';
  /**
   * The most recent `lineTo`, computed but not yet written.
   *
   * Held back so `close()` can see it. `z` already draws a straight line from
   * the current point back to the subpath's start, so a final line that lands
   * on the start is that same line written twice — but whether it lands there
   * is only decidable here, after snapping, and the caller that produced the
   * segment cannot know.
   */
  private pendingLine: { dx: number; dy: number } | null = null;

  constructor(private readonly precision: number = 2) {}

  private snap(v: number): number {
    const f = 10 ** this.precision;
    return Math.round(v * f) / f;
  }

  /**
   * Emit one command, omitting the letter where implicit repetition allows it
   * and the separator where the grammar makes it unambiguous.
   */
  private push(command: string, args: readonly number[]): void {
    // A repeated command letter may be dropped — except after a moveto, where
    // implicit repetition means "lineto", not "another moveto".
    const repeatable = command !== 'M' && command !== 'm' && command !== 'z';
    let chunk = repeatable && command === this.lastCommand ? '' : command;

    for (const a of args) {
      const s = num(a, this.precision);

      // The separator decision must see whatever character actually precedes
      // this number in the finished string. When the command letter is elided,
      // `chunk` is still empty and the real predecessor is the last number of
      // the *previous* command — consulting only `chunk` there would run two
      // numbers together, turning "…3" + "1.341" into "31.341".
      const context = chunk.length > 0 ? chunk : this.out;
      if (context.length > 0) {
        const last = context[context.length - 1];
        if ((last >= '0' && last <= '9') || last === '.') {
          // `-` always starts a new number. `.` does too, but only when the
          // previous number already spent its decimal point.
          if (s[0] !== '-' && !(s[0] === '.' && trailingNumberHasDot(context))) {
            chunk += ' ';
          }
        }
      }
      chunk += s;
    }

    this.out += chunk;
    this.lastCommand = command;
  }

  /** Write the held-back line, if there is one. Idempotent. */
  private flushLine(): void {
    const p = this.pendingLine;
    if (!p) return;
    // Clear first: `push` must not see a pending line, or a re-entrant read of
    // `length` from inside it would write the same segment twice.
    this.pendingLine = null;
    if (p.dy === 0) this.push('h', [p.dx]);
    else if (p.dx === 0) this.push('v', [p.dy]);
    else this.push('l', [p.dx, p.dy]);
  }

  moveTo(x: number, y: number): this {
    this.flushLine();
    const ax = this.snap(x), ay = this.snap(y);
    if (this.out === '') this.push('M', [ax, ay]);
    else this.push('m', [ax - this.cx, ay - this.cy]);
    this.cx = ax; this.cy = ay;
    this.startX = ax; this.startY = ay;
    return this;
  }

  lineTo(x: number, y: number): this {
    const ax = this.snap(x), ay = this.snap(y);
    const dx = ax - this.cx, dy = ay - this.cy;
    if (dx === 0 && dy === 0) return this;
    // The delta is fixed now, so holding the write back cannot change it: the
    // cursor advances here and every other emitter flushes before it writes.
    this.flushLine();
    this.pendingLine = { dx, dy };
    this.cx = ax; this.cy = ay;
    return this;
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.flushLine();
    const a1x = this.snap(x1), a1y = this.snap(y1);
    const a2x = this.snap(x2), a2y = this.snap(y2);
    const ax = this.snap(x), ay = this.snap(y);
    this.push('c', [
      a1x - this.cx, a1y - this.cy,
      a2x - this.cx, a2y - this.cy,
      ax - this.cx, ay - this.cy,
    ]);
    this.cx = ax; this.cy = ay;
    return this;
  }

  /**
   * Quadratic Bézier — four numbers where {@link curveTo} spends six.
   *
   * The zero test is the same one `lineTo` makes, and for the same reason. A `q`
   * whose control point and endpoint both land on the current point draws
   * nothing and leaves the cursor where it was, so writing it costs bytes and
   * changes no geometry — and after snapping, a short curve on a dense boundary
   * becomes exactly that. A previous attempt at this method omitted the test and
   * wrote runs of `q0 0 0 0 0 0 0 0` where the correct output was nothing at all.
   * Tested BEFORE `flushLine`, so a held-back line is not forced out by a command
   * that turns out not to exist.
   */
  quadTo(x1: number, y1: number, x: number, y: number): this {
    const a1x = this.snap(x1), a1y = this.snap(y1);
    const ax = this.snap(x), ay = this.snap(y);
    const d1x = a1x - this.cx, d1y = a1y - this.cy;
    const dx = ax - this.cx, dy = ay - this.cy;
    if (d1x === 0 && d1y === 0 && dx === 0 && dy === 0) return this;
    this.flushLine();
    this.push('q', [d1x, d1y, dx, dy]);
    this.cx = ax; this.cy = ay;
    return this;
  }

  /** Axis-aligned rectangle as a closed subpath — the workhorse of pixel mode. */
  rect(x: number, y: number, w: number, h: number): this {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    return this.close();
  }

  close(): this {
    // Drop a final line that returns to the start; `z` draws it. Endpoints are
    // compared after snapping, so a segment that misses the start in user space
    // but rounds onto it counts too. Geometry is untouched either way: with the
    // line gone the pen sits where that line began, and `z` runs from there to
    // the start — the same straight line, one command instead of two.
    //
    // A closing *curve* is real geometry `z` cannot reproduce, so only the line
    // case qualifies, and only when it is the last thing written.
    if (this.pendingLine && this.cx === this.startX && this.cy === this.startY) {
      this.pendingLine = null;
    } else {
      this.flushLine();
    }
    this.push('z', []);
    this.cx = this.startX; this.cy = this.startY;
    return this;
  }

  get length(): number {
    this.flushLine();
    return this.out.length;
  }

  isEmpty(): boolean {
    this.flushLine();
    return this.out.length === 0;
  }

  toString(): string {
    // Flushing here is what keeps an *open* path whole. `centerline` builds
    // polylines and never calls `close()`, so without this its last segment
    // would be held back for a command that never comes and simply vanish.
    this.flushLine();
    return this.out;
  }
}
