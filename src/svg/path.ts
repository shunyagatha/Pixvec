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

  moveTo(x: number, y: number): this {
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
    if (dy === 0) this.push('h', [dx]);
    else if (dx === 0) this.push('v', [dy]);
    else this.push('l', [dx, dy]);
    this.cx = ax; this.cy = ay;
    return this;
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
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

  /** Axis-aligned rectangle as a closed subpath — the workhorse of pixel mode. */
  rect(x: number, y: number, w: number, h: number): this {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    return this.close();
  }

  close(): this {
    this.push('z', []);
    this.cx = this.startX; this.cy = this.startY;
    return this;
  }

  get length(): number {
    return this.out.length;
  }

  isEmpty(): boolean {
    return this.out.length === 0;
  }

  toString(): string {
    return this.out;
  }
}
