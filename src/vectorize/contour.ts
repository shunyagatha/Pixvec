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
 * How to resolve a diagonal self-touch (the checkerboard saddle), mirroring
 * potrace's `turnPolicy`. The choice only ever matters at a vertex where the
 * component being traced occupies two diagonally-opposite cells and so offers
 * two ways to continue: *hug* joins the two arms into one self-touching loop,
 * *cut* keeps them separate with the background passing between.
 *
 * - `left` / `white` — always cut. **The default**, and the only policy that
 *   guarantees non-self-crossing loops, so it is what the exact (lossless)
 *   tracer relies on.
 * - `right` / `black` — always hug.
 * - `majority` — hug when the local neighbourhood is mostly this component.
 * - `minority` — the opposite; hug when the component is locally outnumbered.
 */
export type TurnPolicy = 'black' | 'white' | 'left' | 'right' | 'minority' | 'majority';

/**
 * Trace every boundary loop of every component.
 *
 * @param turnPolicy How to resolve diagonal self-touches. Defaults to `left`,
 *   which is byte-for-byte the historical behaviour and keeps every loop free
 *   of self-crossings — required for the exact tracer to rasterise back
 *   identically. Only the lossy tracer should pass anything else.
 * @returns One array of loops per component, in component-id order.
 */
export function traceComponents(
  labels: Int32Array,
  width: number,
  height: number,
  componentCount: number,
  turnPolicy: TurnPolicy = 'left',
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
      start, edgeComp[start], edgeFrom, edgeTo, edgeComp, edgeNext, head, used,
      VW, width, height, labels, turnPolicy,
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
  labels: Int32Array,
  turnPolicy: TurnPolicy,
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
      to, dx, dy, comp, edgeTo, edgeComp, edgeNext, head, used,
      VW, width, height, labels, turnPolicy,
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
 * That is the only place the choice is not forced, and `turnPolicy` decides it.
 *
 * In this tracer's geometry (edges emitted interior-on-the-right, screen
 * coordinates with y growing downward), turning *clockwise* keeps the two
 * diagonal arms separate — a *cut*, and the only choice that never lets the
 * loop cross itself — while turning *counter-clockwise* joins them — a *hug*.
 * The `left`/`white` policies always cut (the default, and what the exact
 * tracer depends on); `right`/`black` always hug; `majority`/`minority` decide
 * from the surrounding pixels.
 *
 * Away from a saddle at most one forward edge exists, so every policy resolves
 * to the same natural order — clockwise, straight on, counter-clockwise,
 * reverse — and the result is identical to the historical fixed rule.
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
  labels: Int32Array,
  turnPolicy: TurnPolicy,
): number {
  const vx = vertex % VW;
  const vy = (vertex - vx) / VW;

  // Directions relative to travel, in the fixed preference order.
  const dirs = [
    [-dy, dx],   // 0 clockwise  (cut: arms stay separate)
    [dx, dy],    // 1 straight
    [dy, -dx],   // 2 counter-clockwise (hug: arms join)
    [-dx, -dy],  // 3 reverse
  ];

  const edges = [-1, -1, -1, -1];
  for (let d = 0; d < 4; d++) {
    const nx = vx + dirs[d][0];
    const ny = vy + dirs[d][1];
    if (nx < 0 || nx > width || ny < 0 || ny > height) continue;
    const target = ny * VW + nx;
    for (let g = head[vertex]; g !== -1; g = edgeNext[g]) {
      if (!used[g] && edgeComp[g] === comp && edgeTo[g] === target) {
        edges[d] = g;
        break;
      }
    }
  }

  const clockwise = edges[0];
  const ccw = edges[2];

  // The saddle: both a cut and a hug are available. This is the one vertex the
  // policy actually governs.
  if (clockwise !== -1 && ccw !== -1) {
    return shouldHug(turnPolicy, vx, vy, comp, labels, width, height) ? ccw : clockwise;
  }

  // Otherwise take the first available in the natural order.
  for (let d = 0; d < 4; d++) if (edges[d] !== -1) return edges[d];
  return -1;
}

/**
 * At a saddle, decide whether to *hug* (join the component's two diagonal arms)
 * or *cut* (keep them apart). Follows potrace's turn-policy semantics, adapted
 * to a per-component tracer: the component being traced always plays the role
 * of potrace's foreground, so `black`≡`right` and `white`≡`left` here.
 */
function shouldHug(
  policy: TurnPolicy,
  vx: number,
  vy: number,
  comp: number,
  labels: Int32Array,
  width: number,
  height: number,
): boolean {
  switch (policy) {
    case 'right':
    case 'black':
      return true;
    case 'left':
    case 'white':
      return false;
    case 'majority':
      return componentIsLocalMajority(vx, vy, comp, labels, width, height);
    case 'minority':
      return !componentIsLocalMajority(vx, vy, comp, labels, width, height);
  }
}

/**
 * Vote over concentric square rings (radius 2, 3, 4) centred on the saddle
 * vertex, `+1` for each pixel belonging to `comp` and `-1` otherwise. The
 * innermost ring with a non-zero tally decides; a total tie reads as "not the
 * majority". This mirrors potrace's `majority()` exactly, with out-of-bounds
 * pixels counting against the component (as its falsy `getValueAt` does).
 */
function componentIsLocalMajority(
  vx: number,
  vy: number,
  comp: number,
  labels: Int32Array,
  width: number,
  height: number,
): boolean {
  const isComp = (px: number, py: number): number =>
    px >= 0 && px < width && py >= 0 && py < height && labels[py * width + px] === comp ? 1 : -1;

  for (let i = 2; i < 5; i++) {
    let ct = 0;
    for (let a = -i + 1; a <= i - 1; a++) {
      ct += isComp(vx + a, vy + i - 1);
      ct += isComp(vx + i - 1, vy + a - 1);
      ct += isComp(vx + a - 1, vy - i);
      ct += isComp(vx - i, vy + a);
    }
    if (ct > 0) return true;
    if (ct < 0) return false;
  }
  return false;
}
