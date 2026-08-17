import { packRgba, unpackRgba } from '../image.js';
import { SvgDoc, fillAttrs } from '../svg/build.js';
import { PathBuilder } from '../svg/path.js';
import type { RasterImage, Rgba } from '../types.js';

/**
 * Pixel-exact vectorisation.
 *
 * This produces real vector geometry — no embedded bitmap — that rasterises back
 * to the input **bit for bit**. Two properties make that guarantee hold rather
 * than merely usually hold:
 *
 * - Every rectangle has integer corners on the pixel grid, so an antialiasing
 *   rasteriser computes coverage of exactly 1.0 for the pixels inside it and
 *   exactly 0.0 for everything else. There is no partial coverage to round.
 * - All rectangles of one colour go into a *single* `<path>`. Coverage is
 *   accumulated across a path before it is composited, so abutting rectangles
 *   inside it cannot produce the hairline seams you get from separate elements.
 *
 * The rectangles come from greedy meshing: extend right while the colour holds,
 * then extend down while the whole span still holds. On flat-colour artwork this
 * collapses thousands of pixels into a handful of rectangles. On a photograph it
 * degenerates towards one rectangle per pixel, which is why `auto` mode sends
 * photographs elsewhere.
 */

export interface PixelVectorizeOptions {
  /** Emit a full-canvas rectangle for the dominant colour instead of repeating it. */
  background?: boolean;
  /** Refuse to emit more than this many rectangles. */
  maxRects?: number;
  /**
   * Refuse once rectangles stop compressing, as a fraction of the pixel count.
   * Defaults to {@link DEFAULT_MAX_RECTS_PER_PIXEL}. Pass `1` to allow the fully
   * degenerate one-rectangle-per-pixel case.
   */
  maxRectsPerPixel?: number;
  /** Add `shape-rendering="crispEdges"`, belt-and-braces against sloppy renderers. */
  crispEdges?: boolean;
  title?: string;
  generator?: string;
}

export interface PixelVectorizeOutput {
  svg: string;
  /** Number of `<path>` elements, one per distinct colour. */
  shapes: number;
  colors: number;
  rects: number;
}

const DEFAULT_MAX_RECTS = 4_000_000;

/**
 * The share of an image's pixels that may become rectangles before this mode
 * admits it is the wrong tool.
 *
 * `maxRects` alone does not protect anything, because it bounds the wrong
 * quantity: a 2.56 MP photograph meshes into 1.47 M rectangles, comfortably
 * under the 4 M ceiling, and then emits a **22.4 MB SVG with 105 058 `<path>`
 * elements** at 622 MB peak RSS — exit code 0, and a file no browser will do
 * anything useful with. The cap was set far above the point where the output
 * stops being worth having.
 *
 * A ratio is the right *shape* test, because it is the failure this file
 * already names: meshing "degenerates towards one rectangle per pixel" on a
 * photograph. The corpus separates on it with room to spare — 14.6% for a logo,
 * 23.8% for alpha-blended artwork, 32.8% for a small JPEG, against 57.5% to
 * 98.0% for every photograph.
 *
 * A cap on distinct colours was tried first and is not usable: alpha-dice has
 * *more* colours (85 732) than the parrots photograph (72 079) while being
 * exactly the input this mode is for, so any threshold that refuses the photo
 * also refuses legitimate artwork.
 */
export const DEFAULT_MAX_RECTS_PER_PIXEL = 0.5;

/**
 * The ratio alone is not sufficient, and shipping it alone would have been a
 * regression.
 *
 * A 1 728-pixel patch of noise meshes at ~100% — perfectly degenerate — and
 * produces a handful of kilobytes: bit-exact, small, and completely usable.
 * Several tests encode exactly that, and one of them, "honours --prefer
 * geometry even when the file gets large", is a deliberate promise that a
 * caller who asks for geometry gets it.
 *
 * So the refusal needs both halves: the shape must be wrong *and* the result
 * must be big enough to hurt. Below this many rectangles the degenerate case
 * costs a few hundred kilobytes at worst and there is nothing to protect anyone
 * from. Above it, and still meshing at photographic density, the output is the
 * multi-megabyte path-soup described above.
 */
export const MIN_RECTS_BEFORE_REFUSING = 250_000;

export function vectorizePixels(
  img: RasterImage,
  opts: PixelVectorizeOptions = {},
): PixelVectorizeOutput {
  const { width, height, data } = img;
  const maxRects = opts.maxRects ?? DEFAULT_MAX_RECTS;

  const n = width * height;
  // Checked as the mesh is built, not after: `rectTotal` only grows, so once it
  // passes the budget the answer cannot change, and refusing there skips both
  // the rest of the walk and the megabytes of string building behind it.
  const ratio = opts.maxRectsPerPixel ?? DEFAULT_MAX_RECTS_PER_PIXEL;
  const rectBudget = Math.max(1, Math.ceil(n * ratio));
  const keys = new Uint32Array(n);
  let opaque = true;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) {
      keys[i] = 0; // nothing to draw; RGB under zero alpha is unobservable
      opaque = false;
    } else {
      if (a !== 255) opaque = false;
      keys[i] = packRgba(data[o], data[o + 1], data[o + 2], a);
    }
  }

  // Rectangles per colour, stored flat as x, y, w, h.
  const byColor = new Map<number, number[]>();
  const counts = new Map<number, number>();
  const visited = new Uint8Array(n);
  let rectTotal = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (visited[i]) continue;
      const key = keys[i];
      if (key === 0) continue;

      // Extend right along this row.
      let w = 1;
      while (x + w < width && !visited[i + w] && keys[i + w] === key) w++;

      // Extend down while the entire span matches.
      let h = 1;
      outer: while (y + h < height) {
        const probe = i + h * width;
        for (let t = 0; t < w; t++) {
          if (visited[probe + t] || keys[probe + t] !== key) break outer;
        }
        h++;
      }

      for (let dy = 0; dy < h; dy++) {
        const start = i + dy * width;
        visited.fill(1, start, start + w);
      }

      let list = byColor.get(key);
      if (!list) { list = []; byColor.set(key, list); }
      list.push(x, y, w, h);
      counts.set(key, (counts.get(key) ?? 0) + w * h);

      if (++rectTotal > maxRects) {
        throw new Error(
          `Pixel-exact vectorisation would need more than ${maxRects.toLocaleString('en-US')} ` +
            `rectangles. This input is photographic; use --mode embed for a lossless ` +
            `result or --mode trace for real curves.`,
        );
      }
      if (rectTotal > rectBudget && rectTotal > MIN_RECTS_BEFORE_REFUSING) {
        // 'en-US' pinned, as elsewhere: an unqualified toLocaleString follows
        // the machine's locale, so this same message reads "360,000" on one box
        // and "3,60,000" on another. Diagnostics should not depend on where
        // they run.
        // Rounded *up*, and to one decimal. `toFixed(0)` on a ratio a hair over
        // the budget printed "50%, over the 50% budget", which reads as a
        // contradiction: the number that triggered the refusal appeared equal
        // to the number it was compared against.
        const pct = (Math.ceil((rectTotal / n) * 1000) / 10).toFixed(1);
        throw new Error(
          `Pixel-exact vectorisation has stopped compressing this image: ` +
            `${rectTotal.toLocaleString('en-US')} rectangles for ${n.toLocaleString('en-US')} pixels ` +
            `(${pct}%, over the ${(ratio * 100).toFixed(0)}% budget). Finishing would ` +
            `emit roughly one <path> per distinct colour — megabytes of SVG that no ` +
            `renderer handles well. Use --mode embed for a lossless result or ` +
            `--mode trace for real curves; pass --max-rects-per-pixel 1 if you want ` +
            `the output regardless.`,
        );
      }
    }
  }

  // The dominant colour is cheaper as one canvas-sized rectangle than as
  // thousands of tiles — but only when nothing is transparent, otherwise it
  // would paint over areas that must stay clear.
  let backgroundKey = 0;
  if (opts.background !== false && opaque && counts.size > 1) {
    let best = 0;
    for (const [key, count] of counts) {
      if (count > best) { best = count; backgroundKey = key; }
    }
  }

  const doc = new SvgDoc({
    width,
    height,
    generator: opts.generator,
    title: opts.title,
    shapeRendering: opts.crispEdges === false ? 'auto' : 'crispEdges',
  });

  if (backgroundKey !== 0) doc.addBackground(unpackRgba(backgroundKey));

  // Largest colours first: better gzip locality, and a stable output order.
  //
  // The count is read into the array *before* sorting rather than looked up
  // inside the comparator. A comparator runs O(n log n) times and did two Map
  // lookups each, so on an 800x600 image with 79,761 distinct colours that was
  // ~2.6M hash lookups: 70.5 ms of a 291.6 ms pixel-mode run, 24% of the total,
  // spent re-reading numbers already in hand. Hoisting them is the same ordering
  // — the tie-break on the key still makes it total, so output is byte-identical.
  const ordered = [...byColor.keys()]
    .filter((k) => k !== backgroundKey)
    .map((k) => [counts.get(k) ?? 0, k] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, k]) => k);

  for (const key of ordered) {
    const rects = byColor.get(key)!;
    // Integer geometry throughout, so zero decimal places loses nothing.
    const path = new PathBuilder(0);
    for (let i = 0; i < rects.length; i += 4) {
      path.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
    }
    doc.add(`<path d="${path.toString()}"${fillAttrs(unpackRgba(key))}/>`);
  }

  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: byColor.size,
    rects: rectTotal,
  };
}

/** Distinct colour count, capped so photographs bail out fast. */
export function countDistinctColors(img: RasterImage, cap: number): { count: number; capped: boolean } {
  const seen = new Set<number>();
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = d[o + 3];
    seen.add(a === 0 ? 0 : packRgba(d[o], d[o + 1], d[o + 2], a));
    if (seen.size > cap) return { count: seen.size, capped: true };
  }
  return { count: seen.size, capped: false };
}

/** Convenience for callers that already know the colour they want as a background. */
export function dominantColor(img: RasterImage): Rgba {
  const counts = new Map<number, number>();
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const key = packRgba(d[o], d[o + 1], d[o + 2], d[o + 3]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestKey = packRgba(255, 255, 255, 255);
  for (const [key, count] of counts) {
    if (count > best) { best = count; bestKey = key; }
  }
  return unpackRgba(bestKey);
}
