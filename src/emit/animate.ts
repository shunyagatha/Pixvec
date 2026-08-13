/**
 * Animated SVG assembly — a flipbook from traced frames.
 *
 * An animated GIF or APNG carries a stack of frames; tracing each to vector and
 * stacking them into one SVG gives an animation that scales without blur and
 * often weighs less than the GIF. The frames are shown one at a time by CSS: a
 * single keyframe flips opacity, and each frame group carries a negative
 * `animation-delay` that shifts its visible slot into place — the standard,
 * dependency-free sprite-flipbook technique, so the file is self-contained and
 * needs no JavaScript. Frame 0 is the static poster (what a non-animating
 * renderer, or `prefers-reduced-motion`, shows). Pure string transformation.
 */

export interface AnimateOptions {
  /** Total loop duration in seconds. Default `frames.length / 10` (10 fps). */
  duration?: number;
  /** Frames per second, if `duration` is not given. Default 10. */
  fps?: number;
  /** Loop forever (default). `false` freezes on frame 0 with no animation. */
  loop?: boolean;
  /** Emit a `prefers-reduced-motion` guard that shows frame 0 static. Default true. */
  respectReducedMotion?: boolean;
}

/** Combine per-frame SVG strings into one CSS-animated SVG. */
export function framesToAnimatedSvg(frames: string[], opts: AnimateOptions = {}): string {
  if (frames.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg"/>\n';
  if (frames.length === 1 || opts.loop === false) {
    // Nothing to animate (or animation opted out): return frame 0 as-is.
    return frames[0];
  }

  const n = frames.length;
  const duration = opts.duration ?? n / (opts.fps ?? 10);
  const viewBox = frames[0].match(/viewBox="([^"]*)"/)?.[1] ?? sizeToViewBox(frames[0]) ?? '0 0 100 100';
  const reduced = opts.respectReducedMotion !== false;

  // A frame is visible for one 1/n slice of the cycle. The keyframe holds
  // opacity 1 across that slice then drops; per-frame negative delays fan the
  // slices out so exactly one frame shows at any instant.
  const slot = 100 / n;
  const eps = Math.min(0.0001, slot / 1000);
  const keyframes =
    `@keyframes pv-flip{0%,${trim(slot)}%{opacity:1}${trim(slot + eps)}%,100%{opacity:0}}`;

  // Frame 0 is opaque in the *base* style, not only via the animation, so a
  // renderer that ignores CSS animation (resvg, an `<img>` element, reduced
  // motion) shows frame 0 as the poster instead of a blank canvas. This matches
  // the animation's own t=0 state exactly, so nothing jumps when it starts.
  //
  // A negative delay of A advances the internal clock, so frame k is visible in
  // wall-clock slot `(n − k) mod n`. To play *forward* (0, 1, 2, …) the delay
  // must therefore be −((n − k) mod n)·D/n, NOT −k·D/n — the latter runs every
  // frame after 0 in reverse, which is subtle because the poster still looks
  // right and n = 2 happens to be symmetric.
  const delays = Array.from({ length: n }, (_, k) =>
    `.pv-f${k}{animation-delay:${trim((-((n - k) % n) * duration) / n)}s${k === 0 ? ';opacity:1' : ''}}`).join('');

  const reducedCss = reduced
    ? '@media(prefers-reduced-motion:reduce){.pv-f{animation:none}.pv-f0{opacity:1}}'
    : '';

  const style =
    `<style>` +
    `.pv-f{opacity:0;animation:pv-flip ${trim(duration)}s linear infinite}` +
    delays +
    keyframes +
    reducedCss +
    `</style>`;

  const groups = frames
    .map((svg, k) => `<g class="pv-f pv-f${k}">${innerSvg(svg)}</g>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${style}${groups}</svg>\n`;
}

/** The markup between the outer `<svg …>` and `</svg>`, prologue stripped. */
function innerSvg(svg: string): string {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/^[\s\S]*?<svg\b[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
}

/** Derive a viewBox from the opening tag's width/height (delimiter-anchored). */
function sizeToViewBox(svg: string): string | undefined {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? svg;
  const attr = (name: string): string | undefined =>
    openTag.match(new RegExp(`[\\s"']${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'i'))?.[1];
  const w = attr('width');
  const h = attr('height');
  return w && h ? `0 0 ${w} ${h}` : undefined;
}

/** Compact number: drop trailing zeros, keep at most four decimals. */
function trim(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}
