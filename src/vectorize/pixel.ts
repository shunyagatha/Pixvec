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

export function vectorizePixels(
  img: RasterImage,
  opts: PixelVectorizeOptions = {},
): PixelVectorizeOutput {
  const { width, height, data } = img;
  const maxRects = opts.maxRects ?? DEFAULT_MAX_RECTS;

  const n = width * height;
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
          `Pixel-exact vectorisation would need more than ${maxRects.toLocaleString()} ` +
            `rectangles. This input is photographic; use --mode embed for a lossless ` +
            `result or --mode trace for real curves.`,
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
  const ordered = [...byColor.keys()]
    .filter((k) => k !== backgroundKey)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a - b);

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
