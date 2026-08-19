import { describe, expect, it } from 'vitest';
import { blendPair, classAdjacency, clipPathDef, interpolationLayer } from '../src/vectorize/interpolate.js';
import { trace } from '../src/vectorize/trace.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { createImage, setPixel } from './fixtures.js';
import type { Rgba } from '../src/types.js';

/**
 * The colour-interpolation pass, and specifically the property that distinguishes
 * it from the obvious implementation: it adds NO coordinates.
 *
 * Every assertion here was mutation-checked — the defect it describes was
 * reintroduced and the test observed to fail — because a test that cannot fail is
 * worse than no test.
 */

const grid = (rows: number[][]): { classes: Int32Array; width: number; height: number } => ({
  classes: Int32Array.from(rows.flat()),
  width: rows[0].length,
  height: rows.length,
});

const shared = (adj: Map<number, Map<number, number>>, a: number, b: number): number =>
  adj.get(Math.min(a, b))?.get(Math.max(a, b)) ?? 0;

describe('class adjacency', () => {
  it('counts each shared lattice edge exactly once', () => {
    // Two 2x3 columns of classes 0 and 1: three horizontal edges between them.
    const { classes, width, height } = grid([
      [0, 0, 1, 1],
      [0, 0, 1, 1],
      [0, 0, 1, 1],
    ]);
    const adj = classAdjacency(classes, width, height);
    expect(shared(adj, 0, 1)).toBe(3);
    // Same class either side contributes nothing, in either direction.
    expect(shared(adj, 0, 0)).toBe(0);
  });

  it('counts vertical and horizontal contacts, and a corner touch not at all', () => {
    const { classes, width, height } = grid([
      [0, 1],
      [1, 0],
    ]);
    const adj = classAdjacency(classes, width, height);
    // Four edges: (0,0)-(1,0), (0,0)-(0,1), (1,0)-(1,1), (0,1)-(1,1).
    expect(shared(adj, 0, 1)).toBe(4);
  });

  it('ignores void, so a silhouette against transparency is not a pair', () => {
    const { classes, width, height } = grid([
      [-1, -1, 2],
      [-1, 3, 2],
      [-1, 3, 2],
    ]);
    const adj = classAdjacency(classes, width, height);
    expect(shared(adj, 2, 3)).toBe(2);
    expect(adj.has(-1)).toBe(false);
    for (const inner of adj.values()) expect(inner.has(-1)).toBe(false);
  });
});

describe('the blend colour', () => {
  const rgba = (r: number, g: number, b: number, a = 255): Rgba => ({ r, g, b, a });

  it('is the per-channel arithmetic mean in sRGB when both sides are opaque', () => {
    expect(blendPair(rgba(0, 0, 0), rgba(255, 255, 255))).toEqual(rgba(128, 128, 128));
    expect(blendPair(rgba(200, 10, 60), rgba(100, 20, 80))).toEqual(rgba(150, 15, 70));
  });

  it('weights each side by its own alpha, and carries the mean alpha', () => {
    // Premultiplied mean: the fully transparent side contributes no colour, but
    // it does halve the alpha. A straight mean would answer 128 here, and does
    // not match the rival's files on 76 of 76 sampled boundaries.
    expect(blendPair(rgba(0, 0, 0, 0), rgba(255, 255, 255, 255)))
      .toEqual(rgba(255, 255, 255, 128));
    // Unequal alphas pull the colour toward the more opaque side.
    const mixed = blendPair(rgba(0, 0, 0, 64), rgba(240, 240, 240, 192));
    expect(mixed.a).toBe(128);
    expect(mixed.r).toBe(180);
  });

  it('is fully transparent only when both sides are', () => {
    expect(blendPair(rgba(10, 20, 30, 0), rgba(40, 50, 60, 0))).toEqual(rgba(0, 0, 0, 0));
  });
});

describe('the interpolation layer', () => {
  const colours = new Map<number, Rgba>([
    [0, { r: 0, g: 0, b: 0, a: 255 }],
    [1, { r: 255, g: 255, b: 255, a: 255 }],
    [2, { r: 255, g: 0, b: 0, a: 255 }],
  ]);
  const pathId = new Map([[0, 'i0'], [1, 'i1'], [2, 'i2']]);
  const adjacency = (pairs: Array<[number, number, number]>): Map<number, Map<number, number>> => {
    const adj = new Map<number, Map<number, number>>();
    for (const [lo, hi, len] of pairs) {
      let inner = adj.get(lo);
      if (!inner) { inner = new Map(); adj.set(lo, inner); }
      inner.set(hi, len);
    }
    return adj;
  };
  const build = (
    pairs: Array<[number, number, number]>,
    over: Partial<Parameters<typeof interpolationLayer>[0]> = {},
  ): ReturnType<typeof interpolationLayer> => interpolationLayer({
    adjacency: adjacency(pairs),
    pathId,
    colorOf: (cls) => colours.get(cls)!,
    backgroundClass: -1,
    width: 1.5,
    ...over,
  });

  it('paints both halves of every pair, each clipped to the other side', () => {
    const { markup, clipClasses } = build([[0, 1, 100]]);
    expect(markup).toContain('<g clip-path="url(#ci1)"><use href="#i0" stroke="#808080"/></g>');
    expect(markup).toContain('<g clip-path="url(#ci0)"><use href="#i1" stroke="#808080"/></g>');
    expect(clipClasses).toEqual(new Set([0, 1]));
  });

  it('carries no path data at all — that is the whole point of the mechanism', () => {
    const { markup } = build([[0, 1, 100], [1, 2, 100], [0, 2, 100]]);
    expect(markup).not.toContain(' d="');
    expect(markup).not.toMatch(/[MmLlCcQqZz]\s*-?\d/);
  });

  it('strokes a background pair unclipped, and puts it before the clipped ones', () => {
    // A background class is a full-canvas rectangle with no outline to clip
    // against, so its band is painted first and every clipped pair repaints over
    // the part of it that falls on another seam.
    const { markup, clipClasses } = build([[0, 1, 100], [0, 2, 100], [1, 2, 100]], { backgroundClass: 0 });
    const bg = markup.indexOf('<use href="#i1" stroke="#808080"/>');
    const clipped = markup.indexOf('<g clip-path=');
    expect(bg).toBeGreaterThan(-1);
    expect(clipped).toBeGreaterThan(bg);
    // Class 0 is the background, so nothing is ever clipped to it.
    expect(clipClasses.has(0)).toBe(false);
  });

  it('drops pairs whose shared boundary is shorter than minLength', () => {
    const kept = build([[0, 1, 100], [1, 2, 3]], { minLength: 8 });
    expect(kept.markup).toContain('#i0');
    expect(kept.markup).not.toContain('href="#i2"');
    const all = build([[0, 1, 100], [1, 2, 3]], { minLength: 0 });
    expect(all.markup).toContain('href="#i2"');
  });

  it('skips a pair whose class never reached the document as one path', () => {
    // A class emitted as primitives or as a gradient has no id, so it takes no
    // part rather than producing a dangling reference.
    const known = new Map([[0, 'i0'], [1, 'i1']]);
    const { markup } = build([[0, 1, 100], [1, 2, 100]], { pathId: known });
    expect(markup).toContain('#i0');
    // Every reference in the layer must resolve. Asserting only the absence of
    // `#i2` is not enough: dropping the guard emits `#undefined`, which contains
    // no `i2` either and would let the defect through.
    const ids = new Set([...known.values()].flatMap((id) => [id, `c${id}`]));
    const refs = [...markup.matchAll(/href="#([^"]+)"|url\(#([^)]+)\)/g)]
      .map((m) => m[1] ?? m[2]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(ref)).toBe(true);
  });

  it('is empty when there is nothing to paint', () => {
    expect(build([]).markup).toBe('');
  });

  it('orders the document by class, not by scan order', () => {
    const forward = build([[0, 1, 100], [1, 2, 100]]);
    const reversed = interpolationLayer({
      adjacency: adjacency([[1, 2, 100], [0, 1, 100]]),
      pathId,
      colorOf: (cls) => colours.get(cls)!,
      backgroundClass: -1,
      width: 1.5,
    });
    expect(reversed.markup).toBe(forward.markup);
  });

  it('names a clip path after the class path it wraps', () => {
    expect(clipPathDef('i7')).toBe('<clipPath id="ci7"><use href="#i7"/></clipPath>');
  });
});

/**
 * The interpolation layer, cut out of a document by balancing its groups. Doing
 * it by `indexOf('</g>')` would stop at the first nested clip group and report a
 * layer that shrinks whenever the mechanism gets WORSE, which is the wrong way
 * round for a size assertion.
 */
function extractLayer(svg: string): string {
  const start = svg.indexOf('<g fill="none" stroke-width=');
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < svg.length; i++) {
    if (svg.startsWith('</g>', i)) {
      depth--;
      if (depth === 0) return svg.slice(start, i + 4);
    } else if (svg.startsWith('<g', i)) depth++;
  }
  throw new Error('unbalanced interpolation layer');
}

/** Two abutting colour fields plus a third block, so several class pairs exist. */
function threeFields(width = 60, height = 40): ReturnType<typeof createImage> {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < width / 3) setPixel(img, x, y, 20, 30, 200);
      else if (x < (2 * width) / 3) setPixel(img, x, y, 230, 220, 40);
      else setPixel(img, x, y, 240, 245, 250);
    }
  }
  return img;
}

/**
 * The same three colour fields, separated by waves of a FIXED spatial period, so
 * a taller image carries proportionally more boundary — and therefore more path
 * data — while still holding exactly three colours and three adjacent pairs.
 */
function wavyFields(width: number, height: number): ReturnType<typeof createImage> {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const a = width / 3 + 6 * Math.sin(y / 4);
    const b = (2 * width) / 3 + 6 * Math.sin(y / 5);
    for (let x = 0; x < width; x++) {
      if (x < a) setPixel(img, x, y, 20, 30, 200);
      else if (x < b) setPixel(img, x, y, 230, 220, 40);
      else setPixel(img, x, y, 240, 245, 250);
    }
  }
  return img;
}

describe('trace with interpolate', () => {
  const opts = { colors: 8, minArea: 4, smooth: 1, mosaic: true, quadratics: false } as const;

  it('is off by default and changes nothing', () => {
    const img = threeFields();
    const plain = trace(img, { ...opts }).svg;
    const explicit = trace(img, { ...opts, interpolate: false }).svg;
    expect(explicit).toBe(plain);
    expect(plain).not.toContain('<use');
    expect(plain).not.toContain('clip-rule');
  });

  it('references the class paths instead of repeating them', () => {
    const img = threeFields();
    const svg = trace(img, { ...opts, interpolate: true }).svg;
    expect(svg).toContain('clip-rule="evenodd"');
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('<use href="#i0"');
    // The layer sits between the background rectangle and the first fill, and
    // forward-references it.
    const layer = svg.indexOf('<g fill="none" stroke-width=');
    const firstFill = svg.indexOf('<path id="i0"');
    expect(layer).toBeGreaterThan(-1);
    expect(firstFill).toBeGreaterThan(layer);
    // Every outline appears exactly once: as many `d="` as there are `<path`
    // elements, and none of them inside the layer.
    expect(svg.split(' d="').length).toBe(svg.split('<path').length);
    expect(extractLayer(svg)).not.toContain(' d="');
    expect(extractLayer(svg)).not.toContain('<path');
  });

  it('keeps every fill a real path, so a renderer that ignores href loses only the layer', () => {
    const svg = trace(threeFields(), { ...opts, interpolate: true }).svg;
    // Strip the layer and every reference; what is left must still be the whole
    // picture — the same `<path>` elements the fills-only document has.
    const withoutLayer = svg.replace(extractLayer(svg), '');
    const plain = trace(threeFields(), { ...opts, strokeWidth: 0 }).svg;
    const paths = (s: string): string[] => [...s.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(paths(withoutLayer)).toEqual(paths(plain));
    // The fill must sit on the wrapping <g>, never on the referenced path: a
    // `fill` on the path itself beats the layer's inherited `fill="none"` and
    // turns every stroke reference into a repaint of the whole region.
    for (const [, attrs] of svg.matchAll(/<path id="i\d+"([^/]*)\/>/g)) {
      expect(attrs).not.toContain('fill="');
    }
    expect(svg).toMatch(/<g fill="[^"]+"><path id="i0" fill-rule="evenodd" d="/);
  });

  it('never repaints a region interior, only its boundary', async () => {
    // The same defect seen from the rendering side, where it is not cosmetic:
    // a repaint under a translucent fill composites twice and darkens the whole
    // region, not just the seam.
    const img = threeFields(90, 60);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width / 3; x++) setPixel(img, x, y, 20, 30, 200, 128);
    }
    const plain = trace(img, { ...opts, strokeWidth: 0, alphaLevels: 4 }).svg;
    const blended = trace(img, { ...opts, interpolate: true, alphaLevels: 4 }).svg;
    const a = (await rasterizeSvg(plain, { width: 90 })).image;
    const b = (await rasterizeSvg(blended, { width: 90 })).image;
    const at = (im: typeof a, x: number, y: number): number[] => {
      const o = (y * im.width + x) * 4;
      return [im.data[o], im.data[o + 1], im.data[o + 2], im.data[o + 3]];
    };
    // Deep inside the translucent field, ten pixels from the nearest boundary.
    expect(at(b, 5, 30)).toEqual(at(a, 5, 30));
    expect(at(b, 15, 10)).toEqual(at(a, 15, 10));
  });

  it('costs what the class PAIRS cost, not what the boundary costs', () => {
    // The mechanism's reason to exist, stated as a scaling law. Quadrupling the
    // image quadruples the boundary a per-arc pass would have to encode, and
    // leaves the number of adjacent class pairs where it was.
    const layerOf = (w: number, h: number): { layer: number; total: number } => {
      const svg = trace(wavyFields(w, h), { ...opts, interpolate: true }).svg;
      return { layer: extractLayer(svg).length, total: svg.length };
    };
    const small = layerOf(90, 60);
    const large = layerOf(360, 240);
    expect(large.total).toBeGreaterThan(small.total * 2);
    expect(large.layer).toBeLessThan(small.layer * 1.25);
  });

  it('suppresses the same-colour stroke, which would repaint the same band flat', () => {
    const img = threeFields();
    const withStroke = trace(img, { ...opts, interpolate: true, strokeWidth: 1 }).svg;
    const without = trace(img, { ...opts, interpolate: true, strokeWidth: 0 }).svg;
    expect(withStroke).toBe(without);
    expect(withStroke).not.toContain('stroke-width="1"');
  });

  it('narrows the band where the image carries translucent pixels', () => {
    const opaque = threeFields();
    const translucent = threeFields();
    for (let y = 0; y < translucent.height; y++) {
      for (let x = 0; x < translucent.width / 3; x++) setPixel(translucent, x, y, 20, 30, 200, 128);
    }
    expect(trace(opaque, { ...opts, interpolate: true }).svg).toContain('stroke-width="1.5"');
    expect(trace(translucent, { ...opts, interpolate: true, alphaLevels: 4 }).svg)
      .toContain('stroke-width="1"');
    // And an explicit width outranks the rule.
    expect(trace(opaque, { ...opts, interpolate: true, interpolateWidth: 3 }).svg)
      .toContain('stroke-width="3"');
  });

  it('declines where a class is not one referenceable path', () => {
    const img = threeFields();
    // `groupByColor` exists to be split into standalone separations, which a
    // document of cross-references cannot survive.
    const layered = trace(img, { ...opts, interpolate: true, groupByColor: true }).svg;
    expect(layered).not.toContain('<clipPath');
    expect(layered).not.toContain('clip-rule');
  });

  it('paints the interpolated colour into the seam, and renders in resvg', async () => {
    const img = threeFields(90, 60);
    const plain = trace(img, { ...opts, strokeWidth: 0 }).svg;
    const blended = trace(img, { ...opts, interpolate: true }).svg;
    const a = await rasterizeSvg(plain, { width: 90 });
    const b = await rasterizeSvg(blended, { width: 90 });
    // Somewhere along the blue|yellow boundary the two documents must differ, and
    // the difference must be the blend rather than either fill.
    let seen = 0;
    for (let i = 0; i < a.image.data.length; i += 4) {
      if (a.image.data[i] !== b.image.data[i]
        || a.image.data[i + 1] !== b.image.data[i + 1]
        || a.image.data[i + 2] !== b.image.data[i + 2]) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});
