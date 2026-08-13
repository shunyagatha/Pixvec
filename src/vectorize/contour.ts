/**
 * Boundary extraction by crack following.
 *
 * Rather than walking pixel centres (which forces a choice between a boundary
 * that sits half a pixel inside the shape and one that sits half a pixel
 * outside), this walks the *cracks* between pixels. Every vertex lands on an
 * integer lattice point of the pixel grid, so the resulting polygon encloses
 * exactly the region's pixels — no half-pixel bias, and the un-simplified
 * polygon rasterises back to the original mask bit for bit.
 *
 * Edges are emitted so the interior lies to the right of the direction of
 * travel. Outer boundaries then come out with positive shoelace area and holes
 * with negative, which is all the caller needs to sort winding out.
 */

export interface Loop {
  /** Flat `x, y` pairs on the integer lattice, implicitly closed. */
  pts: Int32Array;
  /** Positive for an outer boundary, negative for a hole. */
  signedArea: number;
}

/**
 * Trace every boundary loop of every component.
 *
 * @returns One array of loops per component, in component-id order.
 */
export function traceComponents(
  labels: Int32Array,
  width: number,
  height: number,
  componentCount: number,
): Loop[][] {
  const VW = width + 1; // vertices per row
  const vertexCount = VW * (height + 1);

  // --- Pass 1: count boundary edges so the arrays can be sized exactly. ---
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      if (y === 0 || labels[row + x - width] !== c) edgeCount++;
      if (x === width - 1 || labels[row + x + 1] !== c) edgeCount++;
      if (y === height - 1 || labels[row + x + width] !== c) edgeCount++;
      if (x === 0 || labels[row + x - 1] !== c) edgeCount++;
    }
  }

  const edgeFrom = new Int32Array(edgeCount);
  const edgeTo = new Int32Array(edgeCount);
  const edgeComp = new Int32Array(edgeCount);
  const edgeNext = new Int32Array(edgeCount);
  const used = new Uint8Array(edgeCount);
  const head = new Int32Array(vertexCount).fill(-1);

  let e = 0;
  const emit = (from: number, to: number, comp: number): void => {
    edgeFrom[e] = from;
    edgeTo[e] = to;
    edgeComp[e] = comp;
    edgeNext[e] = head[from];
    head[from] = e;
    e++;
  };

  // --- Pass 2: emit edges, interior on the right. ---
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      const tl = y * VW + x;           // (x,   y)
      const tr = tl + 1;               // (x+1, y)
      const bl = (y + 1) * VW + x;     // (x,   y+1)
      const br = bl + 1;               // (x+1, y+1)

      if (y === 0 || labels[row + x - width] !== c) emit(tl, tr, c);           // top, →
      if (x === width - 1 || labels[row + x + 1] !== c) emit(tr, br, c);       // right, ↓
      if (y === height - 1 || labels[row + x + width] !== c) emit(br, bl, c);  // bottom, ←
      if (x === 0 || labels[row + x - 1] !== c) emit(bl, tl, c);               // left, ↑
    }
  }

  const result: Loop[][] = Array.from({ length: componentCount }, () => []);

  for (let start = 0; start < edgeCount; start++) {
    if (used[start]) continue;
    const loop = walkLoop(
      start, edgeComp[start], edgeFrom, edgeTo, edgeComp, edgeNext, head, used, VW, width, height,
    );
    if (loop) result[edgeComp[start]].push(loop);
  }

  return result;
}

function walkLoop(
  startEdge: number,
  comp: number,
  edgeFrom: Int32Array,
  edgeTo: Int32Array,
  edgeComp: Int32Array,
  edgeNext: Int32Array,
  head: Int32Array,
  used: Uint8Array,
  VW: number,
  width: number,
  height: number,
): Loop | null {
  const xs: number[] = [];
  const ys: number[] = [];

  let current = startEdge;
  let dx = 0;
  let dy = 0;

  for (;;) {
    used[current] = 1;

    const from = edgeFrom[current];
    const to = edgeTo[current];
    const fx = from % VW, fy = (from - fx) / VW;
    const tx = to % VW, ty = (to - tx) / VW;

    xs.push(fx);
    ys.push(fy);

    dx = tx - fx;
    dy = ty - fy;

    const next = pickNext(
      to, dx, dy, comp, edgeTo, edgeComp, edgeNext, head, used, VW, width, height,
    );
    if (next === -1) break;
    current = next;
  }

  if (xs.length < 3) return null;

  // Drop vertices that sit in the middle of a straight run. The walk advances
  // one pixel at a time, so an unsimplified 500-pixel edge would otherwise
  // arrive as 500 collinear points.
  const kx: number[] = [];
  const ky: number[] = [];
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const q = (i + 1) % n;
    const ax = xs[i] - xs[p], ay = ys[i] - ys[p];
    const bx = xs[q] - xs[i], by = ys[q] - ys[i];
    if (ax * by - ay * bx !== 0) {
      kx.push(xs[i]);
      ky.push(ys[i]);
    }
  }
  if (kx.length < 3) return null;

  const pts = new Int32Array(kx.length * 2);
  let area2 = 0;
  for (let i = 0; i < kx.length; i++) {
    pts[i * 2] = kx[i];
    pts[i * 2 + 1] = ky[i];
    const j = (i + 1) % kx.length;
    area2 += kx[i] * ky[j] - kx[j] * ky[i];
  }

  return { pts, signedArea: area2 / 2 };
}

/**
 * Choose the next edge leaving `vertex`.
 *
 * A lattice vertex can carry two outgoing edges of the same component when the
 * region winds around and touches itself diagonally — the checkerboard case.
 * Turning as far clockwise as possible resolves it the way a human reads the
 * picture: the two diagonal arms stay separate and the background passes
 * between them, rather than the loop crossing itself.
 *
 * Preference order relative to the incoming direction `(dx, dy)`, in screen
 * coordinates where y grows downward: clockwise, straight on, counter-clockwise,
 * reverse.
 */
function pickNext(
  vertex: number,
  dx: number,
  dy: number,
  comp: number,
  edgeTo: Int32Array,
  edgeComp: Int32Array,
  edgeNext: Int32Array,
  head: Int32Array,
  used: Uint8Array,
  VW: number,
  width: number,
  height: number,
): number {
  const vx = vertex % VW;
  const vy = (vertex - vx) / VW;

  const candidates = [
    [-dy, dx],   // clockwise
    [dx, dy],    // straight
    [dy, -dx],   // counter-clockwise
    [-dx, -dy],  // reverse
  ];

  for (const [cdx, cdy] of candidates) {
    const nx = vx + cdx;
    const ny = vy + cdy;
    if (nx < 0 || nx > width || ny < 0 || ny > height) continue;
    const target = ny * VW + nx;
    for (let g = head[vertex]; g !== -1; g = edgeNext[g]) {
      if (!used[g] && edgeComp[g] === comp && edgeTo[g] === target) return g;
    }
  }
  return -1;
}
