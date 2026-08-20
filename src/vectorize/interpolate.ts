import type { Rgba } from '../types.js';
import { shortHex } from '../color.js';

/**
 * Colour interpolation along region boundaries, by REFERENCE rather than by
 * repeating the geometry.
 *
 * WHAT THE PASS IS FOR. A flat fill cannot carry the antialiased blend that sits
 * along every boundary in the source raster: where two regions meet, the source
 * has a one- or two-pixel ramp between their colours, and a partition of flat
 * shapes has a step. Painting the blend of the two fills into that band recovers
 * the RAMP, which is what this pass is for.
 *
 * IT DOES NOT CLOSE THE GAP, and this note used to say it did. Two abutting
 * antialiased fills do not in general cover their shared pixel — source-over on
 * coverages `c` and `1 - c` gives `1 - c + c^2`, short of one — so whatever is
 * beneath still shows through as a hairline. The band cannot repair that: it is
 * clipped to a neighbour whose own clip mask is rasterised by the same
 * compositing and carries the same deficit. Measured on `clean`, this pass
 * removes 844 of logo-tux's 3,171 interior leaks and 2 of alpha-dice's 725, while
 * SUPPRESSING the `strokeWidth` that was covering some of them on its own — as
 * alpha deficit against the source (no fidelity metric involved), logo-tux reads
 * 175,892 bare / 75,634 at `strokeWidth: 0.5` / 68,350 with this pass, landing
 * level with the stroke it suppresses rather than ahead of it.
 *
 * `underpaint` in trace.ts is what actually closes the gap — an exact union of
 * the opaque classes, painted once, below this layer — and the two compose: the
 * ramp from here, full coverage from underneath. See its docstring for why a
 * clip-based approach cannot do the same job.
 *
 * WHY IT IS NOT ONE STROKED PATH PER BOUNDARY. The obvious implementation walks
 * the arc decomposition and emits one open stroked path per interior arc, in the
 * mean of the two fills either side. That is what the paid rival ships, and it
 * costs 25-45% of its file. Measured here at `clean` on the nine-subject corpus,
 * one path per arc grouped by blend colour costs +65.3% gzip and returns +0.0193
 * mean SSIM against the same document with no pass at all.
 *
 * This module gets +0.0187 — 97% of that — for +5.5% gzip, because it carries no
 * coordinates at all:
 *
 *   - Each class already emits ONE path holding every region of that colour. Give
 *     it an id and leave it exactly where it was, with its fill moved to a
 *     wrapping `<g>` so a `<use>` of it can inherit `fill="none"`.
 *   - For an adjacent pair of classes C and M, stroke `<use href="#C">` in
 *     blend(C, M) and clip it to M's territory: only the C|M half-band survives,
 *     because a stroke centred on C's outline lies inside M exactly where C
 *     borders M. The other half comes from `<use href="#M">` clipped to C.
 *   - The whole layer goes BEFORE the fills, so the fills cover it except at
 *     their own antialiased fringe — which is the hairline it is there to fill.
 *
 * The cost is therefore the number of adjacent class PAIRS (41-653 here, and at
 * most K(K-1)/2 for K classes) instead of the number of interior arcs (256 to
 * 12,473). On photo-motorcycles that is 119 pairs against 12,473 arcs, and the
 * pass costs +1.4% gzip instead of +84%.
 *
 * WHAT IT GIVES UP. On flat art with few, high-contrast classes the arc pass is
 * still better: logo-tux gains +0.0630 from the arcs and +0.0502 here, because a
 * class outline clipped to a neighbour reaches only the neighbour's own
 * antialiased coverage at the seam, so part of the hairline survives. Repeating
 * the clipped paint to raise that coverage was measured and does not pay
 * (+0.0008 SSIM for +4% gzip). On the other eight subjects the two mechanisms are
 * within 0.0032 SSIM of each other, and on alpha-dice this one is 0.0117 ahead.
 *
 * NULL CONTROL. The same geometry painted in each class's OWN colour — identical
 * byte count, no interpolation — returns +0.0145 mean against +0.0174 for the
 * blend at the same fixed width, and is NEGATIVE on photo-jpeg-artifacts
 * (-0.0010) and photo-motorcycles (-0.0085) where the blend is positive. So the
 * colour rule is doing work, not just the coverage it rides on.
 *
 * WHAT WAS TRIED AND DOES NOT WORK, so nobody spends the week again:
 *
 *   - ONE STROKE COLOUR PER CLASS, no clipping. The fills are painted largest
 *     first, so the later class's stroke wins every seam it touches; the
 *     least-squares choice is the length-weighted mean of its own blends. It is
 *     dead: the compromise sits a mean 42.9 RGB from the per-pair targets on
 *     logo-tux and scores 0.9012 on top of the fills against 0.9174 for the plain
 *     same-colour stroke. Under the fills it reaches 0.9147, still short of the
 *     0.9229 here and of doing nothing.
 *   - PAINTING THE LAYER ON TOP instead of underneath. -0.0149 to -0.0384 on the
 *     photographs, because a full-width band of flat blend replaces the fills'
 *     own correct ramp instead of filling the gap in it.
 *   - AN UNCLIPPED PER-CLASS BAND UNDERNEATH the clipped ones, to raise coverage
 *     where clipping falls short: -0.0091 on logo-tux, neutral elsewhere. It
 *     paints outside the silhouette, which is the same bleed `strokeWidth` pays.
 *
 * RENDERERS. `<use>`, `<clipPath>` holding a `<use>`, forward references to both,
 * and an inherited `clip-rule` are all SVG 1.1; `href` without the `xlink:` prefix
 * is SVG 2 and is what every current renderer reads. All of it is checked in resvg
 * (this project's verification renderer) and in librsvg 2.62, which agree to
 * within 0.002 SSIM on all nine subjects. Neither renderer falls back to the
 * referenced path's own `fill-rule` when clipping, so `clip-rule="evenodd"` must
 * be stated — it is inherited, so one attribute on the root serves every clip
 * path. A renderer that cannot resolve `href` loses the layer and keeps every
 * fill, because the fills are real `<path>` elements in document order and only
 * the layer references them.
 */

/** Shared boundary length in lattice edges, per unordered pair of classes. */
export type ClassAdjacency = Map<number, Map<number, number>>;

/**
 * Count the shared boundary between every pair of colour classes.
 *
 * Straight off the class grid rather than off the arc decomposition: the pass
 * needs only WHICH classes touch and HOW MUCH, never where, and reading the grid
 * keeps it independent of `mosaic` and of any tracing option. Each shared lattice
 * edge is counted exactly once. Void (-1) is not a class and is skipped, so a
 * silhouette against transparency contributes nothing — correctly, since there is
 * no second colour to blend with.
 */
export function classAdjacency(
  classes: Int32Array, width: number, height: number,
): ClassAdjacency {
  const adj: ClassAdjacency = new Map();
  const bump = (a: number, b: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    let inner = adj.get(lo);
    if (inner === undefined) { inner = new Map(); adj.set(lo, inner); }
    inner.set(hi, (inner.get(hi) ?? 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = classes[row + x];
      if (c < 0) continue;
      if (x + 1 < width) {
        const r = classes[row + x + 1];
        if (r >= 0 && r !== c) bump(c, r);
      }
      if (y + 1 < height) {
        const d = classes[row + x + width];
        if (d >= 0 && d !== c) bump(c, d);
      }
    }
  }
  return adj;
}

/**
 * The colour of the band between two fills: the per-channel arithmetic mean in
 * sRGB, premultiplied where either side is translucent, with the mean alpha
 * carried on `stroke-opacity`.
 *
 * Not a guess. Sampled against the rival's own files, plain sRGB reproduces
 * 2,557 of 2,558 stroke colours exactly while linear-light and Oklab means do
 * not, and the premultiplied form matches 76 of 76 alpha samples where a straight
 * mean matches 23.6%. Weighting each side by its own alpha IS the premultiplied
 * mean, since dividing the summed premultiplied colour by the summed alpha is the
 * same as an alpha-weighted mean of the un-premultiplied colours.
 */
export function blendPair(a: Rgba, b: Rgba): Rgba {
  const sum = a.a + b.a;
  if (sum === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const wa = a.a / sum;
  const wb = b.a / sum;
  return {
    r: Math.round(a.r * wa + b.r * wb),
    g: Math.round(a.g * wa + b.g * wb),
    b: Math.round(a.b * wa + b.b * wb),
    a: Math.round(sum / 2),
  };
}

export interface InterpolationInput {
  /** Shared boundary lengths, from {@link classAdjacency}. */
  adjacency: ClassAdjacency;
  /** The `<path>` id for each class that reached the document as one path. */
  pathId: Map<number, string>;
  /** Flat colour of a class. */
  colorOf: (cls: number) => Rgba;
  /** The class painted as a full-canvas rectangle, or -1. */
  backgroundClass: number;
  /** Stroke width of the band, in user units. */
  width: number;
  /**
   * Ignore pairs sharing fewer than this many lattice edges. 8 is free: measured
   * over the nine subjects it moves SSIM by at most 0.0006 and by -0.00001 on
   * average, while cutting the layer 5.7% on alpha-dice, whose 653 pairs have a
   * median shared boundary of 8 pixels.
   */
  minLength?: number;
}

export interface InterpolationLayer {
  /** The `<g>` to place before the fills, or '' when there is nothing to paint. */
  markup: string;
  /** Classes needing a `<clipPath>` in `<defs>`. */
  clipClasses: Set<number>;
}

/**
 * Build the interpolation layer.
 *
 * ORDER MATTERS TWICE. Within the layer, pairs involving the background class
 * come first and are stroked UNCLIPPED, because a full-canvas rectangle has no
 * outline to clip against. That paints the right colour along C|background and
 * the wrong one wherever C also meets another class — which every later,
 * clipped pair then repaints over. Between the layer and the fills, the layer
 * goes first: painted on top it would replace a whole stroke-width band with a
 * flat plateau and destroy the fills' own correct ramp, which measured -0.0149 to
 * -0.0384 on the photographs against +0.0270 to +0.0292 for the same layer
 * underneath.
 */
export function interpolationLayer(input: InterpolationInput): InterpolationLayer {
  const { adjacency, pathId, colorOf, backgroundClass, width, minLength = 8 } = input;
  const clipClasses = new Set<number>();
  const background: string[] = [];
  const byClip = new Map<number, string[]>();

  const paint = (fromId: string, colour: Rgba): string =>
    `<use href="#${fromId}" stroke="${shortHex(colour.r, colour.g, colour.b)}"${opacity(colour.a)}/>`;

  // Sorted so the document is a function of the image and not of Map insertion
  // order, which a future change to the scan could silently permute.
  const los = [...adjacency.keys()].sort((x, y) => x - y);
  for (const lo of los) {
    const inner = adjacency.get(lo)!;
    for (const hi of [...inner.keys()].sort((x, y) => x - y)) {
      if (inner.get(hi)! < minLength) continue;
      const blend = blendPair(colorOf(lo), colorOf(hi));
      if (lo === backgroundClass || hi === backgroundClass) {
        const other = lo === backgroundClass ? hi : lo;
        const id = pathId.get(other);
        if (id !== undefined) background.push(paint(id, blend));
        continue;
      }
      const loId = pathId.get(lo);
      const hiId = pathId.get(hi);
      if (loId === undefined || hiId === undefined) continue;
      // Two directed halves: `lo`'s outline clipped to `hi` covers the band on
      // hi's side, and the mirror covers lo's.
      for (const [clip, fromId] of [[hi, loId], [lo, hiId]] as Array<[number, string]>) {
        clipClasses.add(clip);
        let list = byClip.get(clip);
        if (list === undefined) { list = []; byClip.set(clip, list); }
        list.push(paint(fromId, blend));
      }
    }
  }

  if (background.length === 0 && byClip.size === 0) return { markup: '', clipClasses };
  const groups = [...byClip.keys()].sort((x, y) => x - y)
    .map((clip) => `<g clip-path="url(#c${pathId.get(clip)!})">${byClip.get(clip)!.join('')}</g>`);
  // `stroke-linejoin="round"` because these are closed outlines, not the rival's
  // open arcs: a miter join would throw a spike up to four stroke widths long
  // out of every sharp corner.
  return {
    markup: `<g fill="none" stroke-width="${width}" stroke-linejoin="round">`
      + `${background.join('')}${groups.join('')}</g>`,
    clipClasses,
  };
}

/** One `<clipPath>` per class the layer clips against. */
export function clipPathDef(pathIdOfClass: string): string {
  return `<clipPath id="c${pathIdOfClass}"><use href="#${pathIdOfClass}"/></clipPath>`;
}

/**
 * `stroke-opacity`, omitted at full alpha. `fill-opacity` does not apply to a
 * stroke, so a translucent blend has to say so itself.
 */
function opacity(a: number): string {
  if (a >= 255) return '';
  const v = (a / 255).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return ` stroke-opacity="${v.startsWith('0.') ? v.slice(1) : v}"`;
}
