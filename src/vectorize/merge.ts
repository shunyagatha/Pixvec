import type { RasterImage } from '../types.js';
import type { ComponentMap } from './components.js';
import { srgbToOklab, oklabToSrgb } from '../color.js';

/**
 * Region merging on the adjacency graph.
 *
 * Quantise-then-label produces one region per pixel that fell in a different
 * palette bin from its neighbours, and on a compressed source that is thousands
 * of single pixels: measured on a 100x100 JPEG, 4,438 regions with a median area
 * of **one pixel**. They are not subtle, either — the median colour distance
 * from such a fragment to the neighbour it borders most is 40.6 in RGB, because
 * JPEG ringing throws isolated pixels a long way. So a plain colour threshold
 * cannot remove them without also merging things that genuinely differ, and a
 * size threshold (`despeckle`) removes them by absorbing anything small, which
 * takes an eye or a nostril just as readily as a speck.
 *
 * The distinction those two miss is that **whether a merge is safe depends on
 * how much the regions being merged already vary internally**. A one-pixel
 * region has no internal variation, so it has no evidence that its colour means
 * anything, and it should join almost any neighbour. A large smooth region has
 * strong evidence, so it should join only a very similar one.
 *
 * That is Felzenszwalb & Huttenlocher's criterion, and it is why this is a merge
 * policy rather than another threshold: the tolerance is `k / area`, so it falls
 * as a region grows. Edges are considered cheapest-first, so a strong boundary is
 * never crossed early, and once two regions are joined the merged region's
 * tolerance drops — which stops a chain of individually-cheap merges from
 * quietly eating across a real edge.
 *
 * Measured baseline this replaces: at ~260 regions, `blur + despeckle` scores
 * SSIM 0.4557 and the picture is unrecognisable. Vectorizer.AI holds 0.8500 at
 * 257 regions. That difference is the policy, not the region count.
 */

export interface RegionGraph {
  /** Regions, as numbered by the source {@link ComponentMap}. */
  count: number;
  /** Pixels per region. */
  areas: Int32Array;
  /** Area-weighted mean colour per region, Oklab, three entries each. */
  lab: Float64Array;
  /** Edges as `[a, b, weight]` triples, ascending by weight. */
  edges: Float64Array;
  edgeCount: number;
}

/** Perceptual distance between two regions' colours. */
function labDistance(lab: Float64Array, a: number, b: number): number {
  const dl = lab[a * 3] - lab[b * 3];
  const da = lab[a * 3 + 1] - lab[b * 3 + 1];
  const db = lab[a * 3 + 2] - lab[b * 3 + 2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Adjacency and per-region colour in one pass over the image.
 *
 * Colours come from the SOURCE pixels, not from the palette entry the region was
 * assigned. That matters: quantisation is what scattered these fragments across
 * bins in the first place, so measuring their difference by bin exaggerates it.
 * The area-weighted mean is enough here — a fragment's own mean is noise, but the
 * moment it merges into anything larger the weighting drowns it.
 */
export function buildRegionGraph(comps: ComponentMap, img: RasterImage): RegionGraph {
  const { width: w, height: h, data } = img;
  const n = comps.count;
  const areas = new Int32Array(n);
  const sums = new Float64Array(n * 3);

  // One scratch triple, reused: this runs once per pixel and an allocation here
  // would dominate the whole pass.
  const px = new Float64Array(3);
  for (let i = 0; i < w * h; i++) {
    const c = comps.labels[i];
    if (c < 0) continue;
    const o = i * 4;
    srgbToOklab(data[o], data[o + 1], data[o + 2], px);
    sums[c * 3] += px[0]; sums[c * 3 + 1] += px[1]; sums[c * 3 + 2] += px[2];
    areas[c]++;
  }
  const lab = new Float64Array(n * 3);
  for (let c = 0; c < n; c++) {
    const a = Math.max(1, areas[c]);
    lab[c * 3] = sums[c * 3] / a;
    lab[c * 3 + 1] = sums[c * 3 + 1] / a;
    lab[c * 3 + 2] = sums[c * 3 + 2] / a;
  }

  // Each unordered adjacent pair once. A Map keyed on the packed pair is the
  // simplest thing that cannot double-count a border walked from both sides.
  const seen = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = comps.labels[i];
      if (c < 0) continue;
      // Right and down only: every pair is still visited, exactly once.
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
        if (j < 0) continue;
        const d = comps.labels[j];
        if (d < 0 || d === c) continue;
        const lo = c < d ? c : d;
        const hi = c < d ? d : c;
        const key = lo * n + hi;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }

  const edgeCount = seen.size;
  const edges = new Float64Array(edgeCount * 3);
  let k = 0;
  for (const key of seen.keys()) {
    const lo = Math.floor(key / n);
    const hi = key - lo * n;
    edges[k * 3] = lo;
    edges[k * 3 + 1] = hi;
    edges[k * 3 + 2] = labDistance(lab, lo, hi);
    k++;
  }

  // Ascending by weight: the whole method depends on considering the safest
  // merges first, so a strong boundary is never crossed while a weak one waits.
  const order = Array.from({ length: edgeCount }, (_, i) => i)
    .sort((p, q) => edges[p * 3 + 2] - edges[q * 3 + 2]);
  const sorted = new Float64Array(edgeCount * 3);
  for (let i = 0; i < edgeCount; i++) {
    sorted[i * 3] = edges[order[i] * 3];
    sorted[i * 3 + 1] = edges[order[i] * 3 + 1];
    sorted[i * 3 + 2] = edges[order[i] * 3 + 2];
  }
  return { count: n, areas, lab, edges: sorted, edgeCount };
}

export interface MergeOptions {
  /**
   * Merge tolerance. A region's allowance is `k / area`, so this is the colour
   * distance a single pixel may cross — and a 100-pixel region only `k / 100`.
   */
  k?: number;
  /** Stop merging once this many regions remain, if reached before `k` bites. */
  targetRegions?: number;
}

export interface MergeResult {
  /** Region id -> merged region id, renumbered densely from 0. */
  remap: Int32Array;
  /** Regions after merging. */
  count: number;
}

/**
 * Merge until every remaining boundary is stronger than both sides tolerate.
 *
 * Union-find over edges in ascending weight. `internal[c]` is the strongest edge
 * absorbed into `c` so far — its internal variation — and a merge is allowed only
 * when the edge is no stronger than what *both* sides already contain, plus each
 * side's size-scaled allowance. Merging raises `internal`, which is what makes
 * the criterion self-limiting rather than a cascade.
 */
export function mergeRegions(graph: RegionGraph, opts: MergeOptions = {}): MergeResult {
  const k = opts.k ?? 0.06;
  const target = opts.targetRegions ?? 0;
  const n = graph.count;

  const parent = new Int32Array(n);
  const size = new Int32Array(n);
  const internal = new Float64Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; size[i] = Math.max(1, graph.areas[i]); }

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Path compression, iteratively: these graphs reach hundreds of thousands
    // of regions on a large photograph and recursion would not survive it.
    while (parent[x] !== r) { const next = parent[x]; parent[x] = r; x = next; }
    return r;
  };

  let regions = n;
  for (let e = 0; e < graph.edgeCount && regions > target; e++) {
    const a = find(graph.edges[e * 3]);
    const b = find(graph.edges[e * 3 + 1]);
    if (a === b) continue;
    const w = graph.edges[e * 3 + 2];
    // The size-scaled allowance is the whole idea: a one-pixel region tolerates
    // `k`, a thousand-pixel region tolerates `k / 1000`. Small regions have no
    // evidence their colour means anything; large ones do.
    const limit = Math.min(internal[a] + k / size[a], internal[b] + k / size[b]);
    if (w > limit) continue;
    const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
    parent[small] = big;
    size[big] += size[small];
    internal[big] = Math.max(internal[a], internal[b], w);
    regions--;
  }

  // Renumber densely so downstream code can index by region without a sparse map.
  const dense = new Int32Array(n).fill(-1);
  const remap = new Int32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (dense[r] < 0) dense[r] = next++;
    remap[i] = dense[r];
  }
  return { remap, count: next };
}

/**
 * Segment the image itself, before any quantisation.
 *
 * {@link buildRegionGraph} merges regions that a palette already split, so it
 * inherits the damage it is trying to repair: on a 100x100 JPEG, quantising to
 * 48 colours produces 4,555 components with a median area of one pixel, and no
 * merge policy recovers a boundary that quantisation put in the wrong place.
 * Measured, merging those tops out at SSIM 0.5493 at 282 regions.
 *
 * This runs the same criterion on the pixel grid, where every edge weight is a
 * real colour difference between two adjacent pixels rather than a difference
 * between two palette bins. Quantisation then happens *after* segmentation, on
 * regions that are already coherent, which is the order the whole pipeline
 * should have been in.
 *
 * 8-connected, because 4-connectivity leaves diagonal hairlines that later show
 * up as separate regions along every diagonal edge.
 */
/**
 * WHICH KNOB IS ACTUALLY DOING THE WORK — measured twice, and it changed under me.
 *
 * This block previously said the opposite, and the earlier reading was correct
 * about the code as it stood. The runt-absorption fix below inverted it, so both
 * tables are kept: one describes behaviour that no longer exists, which is the
 * only way to see what the fix actually did.
 *
 * BEFORE the fix, when the size pass absorbed every runt regardless of where it
 * sat, `minRegion` compacted hard and paid for it in accuracy:
 *
 *              logo-tux                    JPEG sticker
 *   mr=0   0.9878 / 6,367 regions      0.9562 / 3,893 regions
 *   mr=8   0.9570 / 1,852              0.8503 / 1,049
 *
 * AFTER it, a runt is absorbed only when one neighbour owns two thirds of its
 * border — grain, not edge fringe. Most runts on real artwork are fringe, so they
 * are now spared, and `minRegion` stopped doing either thing. End to end, k=0.02:
 *
 *              logo-tux                    JPEG sticker
 *   mr=0   0.9799 / 101,964 B         0.9556 / 56,784 B
 *   mr=2   0.9792 / 100,412           0.9552 / 56,633
 *   mr=4   0.9765 /  95,932           0.9556 / 56,240
 *   mr=8   0.9769 /  93,393           0.9556 / 56,240
 *   mr=16  0.9769 /  93,404           0.9559 / 56,163
 *
 * On the sticker that is a 0.0007 spread in SSIM and 1.1% in bytes. The knob is
 * very nearly inert, and its accuracy cost is gone — which is the fix working,
 * not the knob failing.
 *
 * `k` is now the lever, and it is the honest one: it is a threshold on colour
 * difference, so it trades accuracy for compaction monotonically and legibly.
 *
 *              logo-tux                    JPEG sticker
 *   k=0.005  0.9832 / 113,415 B       0.9621 / 64,538 B
 *   k=0.02   0.9799 / 101,964         0.9556 / 56,784
 *   k=0.05   0.9770 /  94,136         0.9411 / 44,183
 *   k=0.1    0.9686 /  82,329         0.9167 / 32,316
 *   k=0.2    0.9541 /  69,471         0.8414 / 24,240
 *
 * (Unsegmented: 0.9815 / 110,407 B and 0.9620 / 64,934 B.) Note k=0.005 beats the
 * unsegmented trace on BOTH images — very light segmentation is a small free win,
 * and everything past k=0.05 is a deliberate purchase of size with accuracy.
 *
 * So: to compact, turn `k` up. `minRegion` is grain cleanup and nothing else, and
 * anyone reaching for it expecting compaction is reaching for the wrong one.
 *
 * The claim this module was built to support is untouched by the reversal. At
 * ~260-300 regions, blur-plus-despeckle scores 0.4557 where this scores 0.8415;
 * segmenting before quantising is what makes compaction survivable, whichever
 * knob applies it.
 *
 * A ramp-protection pass was tried here and removed: per region, fit a plane to
 * lightness and keep the original pixels where it explained the variation, so
 * shading would survive. It moved SSIM +0.006 to +0.016 while raising region
 * counts 40-80%, and it did not fix the case that motivated it — logo-tux stayed
 * at 0.9561 against an unsegmented 0.9884. Marginal gain, real cost, wrong target.
 */
export function segmentPixels(img: RasterImage, k = 300, minRegion = 0): Int32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;

  // Oklab once per pixel; every edge weight below is a difference of these.
  const lab = new Float64Array(n * 3);
  const px = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    srgbToOklab(data[o], data[o + 1], data[o + 2], px);
    lab[i * 3] = px[0]; lab[i * 3 + 1] = px[1]; lab[i * 3 + 2] = px[2];
  }
  const dist = (a: number, b: number): number => {
    const dl = lab[a * 3] - lab[b * 3];
    const da = lab[a * 3 + 1] - lab[b * 3 + 1];
    const db = lab[a * 3 + 2] - lab[b * 3 + 2];
    return Math.sqrt(dl * dl + da * da + db * db);
  };

  // Right, down, and both diagonals: each undirected edge visited once.
  const maxEdges = n * 4;
  const ea = new Int32Array(maxEdges);
  const eb = new Int32Array(maxEdges);
  const ew = new Float64Array(maxEdges);
  let m = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) { ea[m] = i; eb[m] = i + 1; ew[m] = dist(i, i + 1); m++; }
      if (y + 1 < h) { ea[m] = i; eb[m] = i + w; ew[m] = dist(i, i + w); m++; }
      if (x + 1 < w && y + 1 < h) { ea[m] = i; eb[m] = i + w + 1; ew[m] = dist(i, i + w + 1); m++; }
      if (x > 0 && y + 1 < h) { ea[m] = i; eb[m] = i + w - 1; ew[m] = dist(i, i + w - 1); m++; }
    }
  }

  const order = new Int32Array(m);
  for (let i = 0; i < m; i++) order[i] = i;
  // Sorting a typed array of indices by weight; the comparator is the hot path
  // on a large image, so `ew` is read directly rather than through a closure
  // over objects.
  const idx = Array.prototype.slice.call(order) as number[];
  idx.sort((p, q) => ew[p] - ew[q]);

  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  const internal = new Float64Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };

  for (let e = 0; e < m; e++) {
    const i = idx[e];
    const a = find(ea[i]);
    const b = find(eb[i]);
    if (a === b) continue;
    const wgt = ew[i];
    if (wgt > Math.min(internal[a] + k / size[a], internal[b] + k / size[b])) continue;
    const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
    parent[small] = big;
    size[big] += size[small];
    internal[big] = wgt;
  }

  // Cleanup pass: absorb runt regions, but only the ones that are grain.
  //
  // FH leaves runts behind by construction and they are the one thing it is
  // genuinely bad at. Absorbing all of them is what this pass used to do, and it
  // was measured to be the dominant cost in the whole module — logo-tux fell
  // 0.9878 -> 0.9570 SSIM as `minRegion` went 0 -> 8, with a visibly eroded
  // silhouette, while `k` across a tenfold range moved nothing.
  //
  // The reason is that "small" bundles two unrelated things. A runt sitting
  // INSIDE one region is grain, and absorbing it is free. A runt sitting BETWEEN
  // two regions is anti-aliasing fringe carrying the sub-pixel position of an
  // edge, and absorbing it drags the boundary — which is exactly the silhouette
  // erosion. So a runt is only absorbed when one neighbour dominates what it
  // borders; a runt on a real edge borders two substantial regions roughly
  // equally and is left alone.
  //
  // `despeckle` reached the same conclusion for the same reason and calls it
  // `speckleScope: 'isolated'`. The difference is that there it is opt-in, and
  // here it is the only behaviour, because the measurement says the other one
  // costs more than it buys.
  if (minRegion > 0) {
    // Border length per (runt, neighbour) pair, so "dominated by one neighbour"
    // is a measurement rather than a guess about topology.
    const borders = new Map<number, Map<number, number>>();
    for (let e = 0; e < m; e++) {
      const i = idx[e];
      const a = find(ea[i]), b = find(eb[i]);
      if (a === b) continue;
      if (size[a] >= minRegion && size[b] >= minRegion) continue;
      for (const [runt, other] of [[a, b], [b, a]] as const) {
        if (size[runt] >= minRegion) continue;
        let mm = borders.get(runt);
        if (!mm) borders.set(runt, mm = new Map());
        mm.set(other, (mm.get(other) ?? 0) + 1);
      }
    }
    for (const [runt, neigh] of borders) {
      if (find(runt) !== runt || size[runt] >= minRegion) continue;
      let best = -1, bestLen = 0, total = 0;
      for (const [other, len] of neigh) { total += len; if (len > bestLen) { bestLen = len; best = other; } }
      // Two thirds of the border against one neighbour means the runt is inside
      // that region rather than on a boundary between two. Below that it is
      // fringe, and moving it moves an edge.
      if (best < 0 || total === 0 || bestLen / total < 0.67) continue;
      const target = find(best);
      if (target === runt) continue;
      parent[runt] = target;
      size[target] += size[runt];
    }
  }

  const dense = new Int32Array(n).fill(-1);
  const out = new Int32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (dense[r] < 0) dense[r] = next++;
    out[i] = dense[r];
  }
  return out;
}

/**
 * Flatten an image onto its own segmentation.
 *
 * Each region from {@link segmentPixels} is repainted in its mean colour, which
 * turns a noisy source into flat coherent areas *before* quantisation sees it.
 * That is the whole point: quantise-then-label makes one region per pixel that
 * fell in a different bin, and no later merge recovers a boundary the palette
 * misplaced. Segmenting first means the palette is applied to areas that are
 * already whole.
 *
 * Deliberately a filter rather than a new pipeline stage. Everything downstream —
 * quantisation, components, despeckle, contour, fit, gradients — is unchanged and
 * simply receives a cleaner picture. `selectiveBlur` occupies the same slot and
 * does the same job far less well: it is a fixed neighbourhood that cannot know
 * where an edge is, and measured on a 100x100 JPEG it removed 18% of the spurious
 * regions where this removes 93%.
 */
/**
 * WHERE THIS IS WRONG, measured, so it does not become a default by accident.
 *
 * It is right for compression-artefact noise and wrong for smooth shading, and
 * nothing in the current option surface distinguishes them.
 *
 * On a 100x100 JPEG sticker it is a clear win: 4,438 regions -> 561, gzip 11.1 KB
 * -> 4.9 KB, and the render goes from speckle to flat coherent areas. On
 * `logo-tux.png` — an airbrushed logo with soft shading rather than grain — the
 * same settings collapse the shading into bands and visibly erode the silhouette:
 * SSIM 0.9884 -> 0.9506 for `segment` alone, 0.9236 with the lattice simplifier,
 * with a jagged head outline and ragged feet in the render.
 *
 * `interiorNoise` cannot separate those two cases: JPEG ringing and a smooth
 * gradient both raise it, and logo-tux measures 0.799 against the sticker's
 * 5.061 — same side of any threshold that catches the sticker. So this stays
 * opt-in until something can tell grain from shading, and the `gradients` option
 * is the obvious place to look, since a region it accepts as a ramp is exactly a
 * region this must not flatten.
 */
export function flattenToSegments(img: RasterImage, k: number, minRegion: number): RasterImage {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const labels = segmentPixels(img, k, minRegion);
  let count = 0;
  for (let i = 0; i < n; i++) if (labels[i] + 1 > count) count = labels[i] + 1;

  // Mean in Oklab, not sRGB: averaging gamma-encoded values darkens a boundary
  // between two flat colours, which is exactly where these means are taken.
  const sums = new Float64Array(count * 3);
  const alpha = new Float64Array(count);
  const cnt = new Float64Array(count);
  const px = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    srgbToOklab(data[o], data[o + 1], data[o + 2], px);
    const r = labels[i];
    sums[r * 3] += px[0]; sums[r * 3 + 1] += px[1]; sums[r * 3 + 2] += px[2];
    alpha[r] += data[o + 3];
    cnt[r]++;
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const r = labels[i];
    const c = Math.max(1, cnt[r]);
    const [R, G, B] = oklabToSrgb(sums[r * 3] / c, sums[r * 3 + 1] / c, sums[r * 3 + 2] / c);
    const o = i * 4;
    out[o] = R; out[o + 1] = G; out[o + 2] = B;
    out[o + 3] = Math.round(alpha[r] / c);
  }
  return { width: w, height: h, data: out };
}
