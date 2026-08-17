import { packRgba, unpackRgba } from '../image.js';
import { SvgDoc, fillAttrs } from '../svg/build.js';
import { PathBuilder } from '../svg/path.js';
import { assertRasterImage, type RasterImage, type Rgba } from '../types.js';
import { connectedComponents } from './components.js';
import { traceComponents } from './contour.js';
import { vectorizePixels, type PixelVectorizeOptions } from './pixel.js';

/**
 * Exact vectorisation as real, editable geometry.
 *
 * There are two ways to describe a set of pixels exactly with vector shapes, and
 * neither wins everywhere:
 *
 * - **Rectangles** (greedy meshing). Cheap, and unbeatable when regions are
 *   blocky — a pixel-art sprite is mostly axis-aligned squares already.
 * - **Contours** (crack following). One outline per region instead of a tiling
 *   of it, so a large region with a complicated edge costs its perimeter rather
 *   than its area. On flat artwork with curved boundaries this is dramatically
 *   smaller: roughly half the bytes on a typical logo.
 *
 * Since the winner flips depending on the picture, {@link vectorizeExact}
 * computes both and keeps the smaller. Choosing this way never costs quality —
 * both candidates are bit-exact — but it is not free, and this file used to say
 * it "costs nothing". Building the candidate that then loses is **51% of
 * `vectorizeExact`**: 29.9%–68.6% depending on the image, measured as the
 * minimum of 5 runs over alpha-dice, logo-tux, and vector-tiger/vector-source
 * rasterised at 256, 512 and 1024.
 *
 * **Why that 51% is not reclaimed by predicting the sizes.** The obvious saving
 * is to compute each candidate's length without building its string, then build
 * only the winner. It was investigated and rejected, and the reason is the
 * failure mode rather than the arithmetic.
 *
 * A predictor is a second implementation of the byte-formatting rules in
 * `../svg/path.ts` and `../svg/build.ts`. When it is wrong, nothing detects it:
 * both candidates are bit-exact, so a wrong choice still yields a correct SVG
 * that is merely larger, every quality metric is unchanged, and the only trace
 * is a permanently wrong number in {@link ExactOutput.sizes}. Of five prototype
 * predictors written during that investigation, the two that were byte-correct
 * on the first attempt cost 65–117% of simply building the string — they lost —
 * and two of the three cheap enough to win were silently wrong, one by a
 * systematic 4.7% from charging a separator after the `M` command letter. The
 * margins here do not tolerate that: the winner on vector-tiger at 1024 is
 * decided by 1.3%.
 *
 * Reopening it takes a measurement, not an argument — how often exact geometry
 * is the output that actually ships rather than losing to the embedded bitmap,
 * and what share of a real run `vectorizeExact` is. If those justify it, the one
 * safe shape is a single emitter with two sinks, so that separators, `h`/`v`
 * selection and elision are *executed* against a counter rather than modelled.
 * Never a predictor that restates them.
 *
 * **Why contours are exact.** Crack following puts every vertex on an integer
 * lattice point of the pixel grid, so each polygon's boundary runs along pixel
 * edges and never through a pixel. An antialiasing rasteriser therefore computes
 * coverage of exactly 1.0 for interior pixels and exactly 0.0 for exterior ones:
 * there is no partial coverage anywhere, and nothing to round.
 */

export interface ExactOptions extends PixelVectorizeOptions {
  /**
   * Refuse to build contours beyond this many connected regions. Photographic
   * input produces roughly one region per pixel, where the contour form is both
   * enormous and pointless.
   */
  maxRegions?: number;
}

export interface ExactOutput {
  svg: string;
  shapes: number;
  colors: number;
  /** Which encoding won on size. */
  strategy: 'rectangles' | 'contours';
  /**
   * Size each candidate came to, for reporting.
   *
   * These are `String.length` — UTF-16 code units, not bytes. The two agree for
   * the ASCII-only output this produces, and diverge only if a non-ASCII `title`
   * is passed, where the CLI's own `Buffer.byteLength` figure for the delivered
   * file will read higher. The choice above is unaffected either way: both
   * candidates carry the same title, so any inflation is common to both.
   */
  sizes: { rectangles: number; contours?: number };
}

const DEFAULT_MAX_REGIONS = 200_000;

/** Build both exact encodings and return whichever is smaller. */
export function vectorizeExact(img: RasterImage, opts: ExactOptions = {}): ExactOutput {
  assertRasterImage(img, 'vectorizeExact');
  const rects = vectorizePixels(img, opts);
  const contours = tryContours(img, opts);

  if (!contours || contours.svg.length >= rects.svg.length) {
    return {
      svg: rects.svg,
      shapes: rects.shapes,
      colors: rects.colors,
      strategy: 'rectangles',
      sizes: { rectangles: rects.svg.length, contours: contours?.svg.length },
    };
  }

  return {
    svg: contours.svg,
    shapes: contours.shapes,
    colors: contours.colors,
    strategy: 'contours',
    sizes: { rectangles: rects.svg.length, contours: contours.svg.length },
  };
}

function tryContours(img: RasterImage, opts: ExactOptions): ContourOutput | null {
  try {
    return vectorizeExactContours(img, opts);
  } catch {
    // Region budget exceeded, or the image is simply unsuited to contours.
    // Rectangles always work, so this is a size optimisation, not a failure.
    return null;
  }
}

export interface ContourOutput {
  svg: string;
  shapes: number;
  colors: number;
  regions: number;
}

/**
 * Exact vectorisation by region outline.
 *
 * Unlike `trace`, nothing here is approximated: colours are used verbatim rather
 * than quantised, and contours are emitted at full lattice resolution with no
 * simplification or curve fitting. The only thing shared with the tracer is the
 * contour walker itself.
 */
export function vectorizeExactContours(img: RasterImage, opts: ExactOptions = {}): ContourOutput {
  assertRasterImage(img, 'vectorizeExactContours');
  const { width, height, data } = img;
  const n = width * height;
  const maxRegions = opts.maxRegions ?? DEFAULT_MAX_REGIONS;

  // Map every distinct RGBA to a dense class index. Fully transparent pixels
  // collapse into one void class: colour under zero alpha cannot be observed,
  // so preserving it would cost bytes to encode something nobody can see.
  const classOf = new Map<number, number>();
  const classes = new Int32Array(n);
  const colors: Rgba[] = [];
  // Noted here rather than rediscovered later: whether anything is transparent
  // decides the background shortcut below, and this loop is already the only
  // place that knows. It used to be answered with `classes.includes(-1)`, a
  // second full pass over a megapixel array to produce one bit.
  let hasVoid = false;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) {
      classes[i] = -1;
      hasVoid = true;
      continue;
    }
    const key = packRgba(data[o], data[o + 1], data[o + 2], a);
    let cls = classOf.get(key);
    if (cls === undefined) {
      cls = colors.length;
      classOf.set(key, cls);
      colors.push(unpackRgba(key));
    }
    classes[i] = cls;
  }

  const comps = connectedComponents(classes, width, height, -1);
  if (comps.count > maxRegions) {
    throw new Error(
      `Exact contours would need ${comps.count.toLocaleString('en-US')} regions, over the ` +
        `${maxRegions.toLocaleString('en-US')} budget. This input is photographic.`,
    );
  }

  const loops = traceComponents(comps.labels, width, height, comps.count);

  // Group components by colour so one path serves each.
  const areaByClass = new Map<number, number>();
  const componentsByClass = new Map<number, number[]>();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    areaByClass.set(cls, (areaByClass.get(cls) ?? 0) + comps.areas[c]);
    let list = componentsByClass.get(cls);
    if (!list) { list = []; componentsByClass.set(cls, list); }
    list.push(c);
  }

  const ordered = [...areaByClass.keys()].sort(
    (a, b) => (areaByClass.get(b) ?? 0) - (areaByClass.get(a) ?? 0) || a - b,
  );

  const doc = new SvgDoc({
    width,
    height,
    generator: opts.generator,
    title: opts.title,
    // Integer geometry renders identically either way, but disabling
    // antialiasing removes any dependence on the renderer's edge rules.
    shapeRendering: opts.crispEdges === false ? 'auto' : 'crispEdges',
  });

  const backgroundClass =
    opts.background !== false && !hasVoid && ordered.length > 1 ? ordered[0] : -1;
  if (backgroundClass >= 0) doc.addBackground(colors[backgroundClass]);

  for (const cls of ordered) {
    if (cls === backgroundClass) continue;
    const path = new PathBuilder(0); // lattice coordinates are whole numbers

    for (const c of componentsByClass.get(cls)!) {
      for (const loop of loops[c]) {
        const pts = loop.pts;
        path.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
        path.close();
      }
    }

    if (path.isEmpty()) continue;
    doc.add(`<path fill-rule="evenodd" d="${path.toString()}"${fillAttrs(colors[cls])}/>`);
  }

  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: areaByClass.size,
    regions: comps.count,
  };
}
