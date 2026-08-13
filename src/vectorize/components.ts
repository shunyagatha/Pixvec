/**
 * Connected-component labelling over a class map.
 *
 * Uses 4-connectivity, and that choice is load-bearing rather than incidental:
 * with 4-connected regions, two diagonally touching pixels of the same colour
 * belong to different components unless some 4-connected path joins them. That
 * keeps the boundary walk in `contour.ts` well defined — see the note there
 * about checkerboard vertices.
 *
 * The implementation is a two-pass union–find (Hoshen–Kopelman): one raster
 * sweep to assign provisional labels and record equivalences, one to resolve
 * them. It touches each pixel twice and allocates only in proportion to the
 * number of provisional labels, which matters on noisy inputs where a
 * stack-based flood fill would need a frame per pixel.
 */

export interface ComponentMap {
  /** Component id per pixel, or -1 for pixels belonging to the void class. */
  labels: Int32Array;
  count: number;
  /** Pixel count per component. */
  areas: Int32Array;
  /** Source class (palette index) per component. */
  classes: Int32Array;
  /** `[minX, minY, maxX, maxY]` per component, four entries each. */
  bounds: Int32Array;
}

class UnionFind {
  private parent: Int32Array;
  private size = 0;

  constructor(capacity: number) {
    this.parent = new Int32Array(Math.max(16, capacity));
  }

  make(): number {
    if (this.size === this.parent.length) {
      const grown = new Int32Array(this.parent.length * 2);
      grown.set(this.parent);
      this.parent = grown;
    }
    const id = this.size++;
    this.parent[id] = id;
    return id;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression, iterative so deep chains cannot blow the stack.
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    // Always point the larger id at the smaller so roots stay stable in
    // raster order, which makes the final relabelling deterministic.
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent[hi] = lo;
    return lo;
  }

  get length(): number {
    return this.size;
  }
}

/**
 * Label 4-connected runs of equal class.
 *
 * @param classes  Per-pixel class index.
 * @param voidClass Class treated as "nothing here"; those pixels get label -1
 *                  and are never part of a component.
 */
export function connectedComponents(
  classes: Int32Array,
  width: number,
  height: number,
  voidClass = -1,
): ComponentMap {
  const n = width * height;
  const provisional = new Int32Array(n).fill(-1);
  const uf = new UnionFind(Math.max(16, Math.ceil(n / 4)));

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const cls = classes[i];
      if (cls === voidClass) continue;

      const left = x > 0 && classes[i - 1] === cls ? provisional[i - 1] : -1;
      const up = y > 0 && classes[i - width] === cls ? provisional[i - width] : -1;

      if (left === -1 && up === -1) {
        provisional[i] = uf.make();
      } else if (left === -1) {
        provisional[i] = up;
      } else if (up === -1) {
        provisional[i] = left;
      } else {
        provisional[i] = uf.union(left, up);
      }
    }
  }

  // Resolve equivalences and renumber to a dense 0..count-1 range.
  const remap = new Int32Array(uf.length).fill(-1);
  const labels = new Int32Array(n).fill(-1);
  let count = 0;

  for (let i = 0; i < n; i++) {
    const p = provisional[i];
    if (p === -1) continue;
    const root = uf.find(p);
    let dense = remap[root];
    if (dense === -1) {
      dense = count++;
      remap[root] = dense;
    }
    labels[i] = dense;
  }

  const areas = new Int32Array(count);
  const componentClasses = new Int32Array(count).fill(-1);
  const bounds = new Int32Array(count * 4);
  for (let c = 0; c < count; c++) {
    bounds[c * 4] = Number.MAX_SAFE_INTEGER;
    bounds[c * 4 + 1] = Number.MAX_SAFE_INTEGER;
    bounds[c * 4 + 2] = -1;
    bounds[c * 4 + 3] = -1;
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      areas[c]++;
      if (componentClasses[c] === -1) componentClasses[c] = classes[row + x];
      const b = c * 4;
      if (x < bounds[b]) bounds[b] = x;
      if (y < bounds[b + 1]) bounds[b + 1] = y;
      if (x > bounds[b + 2]) bounds[b + 2] = x;
      if (y > bounds[b + 3]) bounds[b + 3] = y;
    }
  }

  return { labels, count, areas, classes: componentClasses, bounds };
}

/**
 * Absorb components smaller than `minArea` into the neighbour they share the
 * longest border with.
 *
 * Isolated specks are what make a traced file enormous: a few thousand
 * three-pixel regions each cost a path, and none of them is visible. Merging by
 * longest shared border (rather than, say, nearest colour) keeps the result
 * looking like the original because the speck adopts whatever already surrounds
 * it.
 *
 * Returns the number of components absorbed. `classes` is modified in place;
 * the caller must re-run {@link connectedComponents} afterwards.
 */
export function despeckle(
  classes: Int32Array,
  comps: ComponentMap,
  width: number,
  height: number,
  minArea: number,
  voidClass = -1,
): number {
  if (minArea <= 1) return 0;

  const small: number[] = [];
  for (let c = 0; c < comps.count; c++) {
    if (comps.areas[c] < minArea) small.push(c);
  }
  if (small.length === 0) return 0;

  // Process smallest first so a speck never absorbs into another speck that is
  // itself about to disappear.
  small.sort((a, b) => comps.areas[a] - comps.areas[b]);

  const isSmall = new Uint8Array(comps.count);
  for (const c of small) isSmall[c] = 1;

  const borderTally = new Map<number, number>();
  let merged = 0;

  for (const c of small) {
    borderTally.clear();
    const b = c * 4;
    const x0 = comps.bounds[b], y0 = comps.bounds[b + 1];
    const x1 = comps.bounds[b + 2], y1 = comps.bounds[b + 3];

    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        if (comps.labels[row + x] !== c) continue;
        tally(borderTally, comps, classes, row + x - 1, x > 0, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x + 1, x < width - 1, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x - width, y > 0, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x + width, y < height - 1, c, isSmall, voidClass);
      }
    }

    // -2 is the "no candidate" sentinel: -1 is a legitimate answer, meaning the
    // speck is mostly surrounded by transparency and should become transparent.
    let bestClass = -2;
    let bestLen = 0;
    for (const [cls, len] of borderTally) {
      if (len > bestLen) { bestLen = len; bestClass = cls; }
    }
    if (bestClass === -2) continue; // fully enclosed by other specks; leave it

    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        if (comps.labels[row + x] === c) classes[row + x] = bestClass;
      }
    }
    isSmall[c] = 0; // it is gone; later specks may now border its replacement
    merged++;
  }

  return merged;
}

function tally(
  out: Map<number, number>,
  comps: ComponentMap,
  classes: Int32Array,
  idx: number,
  inBounds: boolean,
  self: number,
  isSmall: Uint8Array,
  voidClass: number,
): void {
  if (!inBounds) return;
  const other = comps.labels[idx];
  if (other === self) return;
  if (other !== -1 && isSmall[other]) return; // do not merge into another speck
  const cls = other === -1 ? voidClass : classes[idx];
  out.set(cls, (out.get(cls) ?? 0) + 1);
}
