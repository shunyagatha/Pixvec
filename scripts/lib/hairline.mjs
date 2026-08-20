/**
 * The interior alpha hairline instrument.
 *
 * A LEAK is a pixel the SOURCE calls fully opaque that the rendered candidate
 * returns below `alpha`. It needs no fidelity metric and no reference renderer:
 * the source's own alpha plane is the ground truth and one byte answers "is this
 * pixel see-through". That is the whole reason this defect is worth chasing —
 * nothing here can be gamed by a candidate the way a similarity score can.
 *
 * TWO THINGS THAT MUST ALWAYS BE STATED WITH A COUNT, because a count alone is
 * inert:
 *
 * - THE THRESHOLD. At `alpha 255` the count includes pixels that are one step
 *   short of opaque; at 250 it is the visible defect. The two differ by 3x on
 *   the same document.
 * - THE DEFICIT. `sum(255 - a)` is the statistic that moves. A document that
 *   improves every leaking pixel from 191 to 254 has the same count and a
 *   sixteenth of the deficit.
 *
 * Leaks are classified by DISTANCE from the source silhouette — the Chebyshev
 * distance to the nearest source pixel that is not fully opaque, with the canvas
 * frame seeded as transparent. A leak at distance <= 1 sits against the edge of
 * the artwork and may be the correct antialiased fringe of a shape that
 * genuinely ends there. A leak at distance >= 2 cannot be: every pixel within
 * one step is one the source calls solid, so nothing about the silhouette
 * explains it. That is the INTERIOR count, and it is the one to fix.
 */

/** Chebyshev distance to the nearest source pixel with alpha < 255. */
export function silhouetteDistance(img) {
  const { width, height, data } = img;
  const n = width * height;
  const dist = new Int32Array(n).fill(1 << 28);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 255) { dist[i] = 0; queue[tail++] = i; }
  }
  // Outside the canvas counts as transparent, so the frame seeds too.
  const seedEdge = (i) => { if (dist[i] > 0) { dist[i] = 0; queue[tail++] = i; } };
  for (let x = 0; x < width; x++) { seedEdge(x); seedEdge((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seedEdge(y * width); seedEdge(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width, y = (p / width) | 0, d = dist[p] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (dist[q] > d) { dist[q] = d; queue[tail++] = q; }
      }
    }
  }
  return dist;
}

/**
 * Count leaks against a source, split by silhouette distance.
 *
 * `render` is the rasterised candidate. It may be a MAGNIFIED render, in which
 * case `scale` says by how much and each source pixel is scored by the WORST
 * alpha in the block it became — magnification is where a hairline that has been
 * merely pushed below one sampling grid comes back.
 */
export function hairline(src, render, { alpha = 250, scale = 1, dist } = {}) {
  const { width, height } = src;
  const d = dist ?? silhouetteDistance(src);
  const sx = render.width / width, sy = render.height / height;
  if (Math.abs(sx - scale) > 0.02 || Math.abs(sy - scale) > 0.02) {
    throw new Error(`render ${render.width}x${render.height} is not ${scale}x of ${width}x${height}`);
  }
  let total = 0, worst = 255, sum = 0, interior = 0, interiorWorst = 255;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (src.data[i * 4 + 3] !== 255) continue;
      // The worst alpha anywhere in this source pixel's rendered block.
      let a = 255;
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      for (let ry = y0; ry < Math.min(y1, render.height); ry++) {
        for (let rx = x0; rx < Math.min(x1, render.width); rx++) {
          const v = render.data[(ry * render.width + rx) * 4 + 3];
          if (v < a) a = v;
        }
      }
      if (a >= alpha) continue;
      total++;
      sum += 255 - a;
      if (a < worst) worst = a;
      mask[i] = 255 - a;
      if (d[i] >= 2) { interior++; if (a < interiorWorst) interiorWorst = a; }
    }
  }
  return {
    total,
    interior,
    worst: total === 0 ? 255 : worst,
    interiorWorst: interior === 0 ? 255 : interiorWorst,
    deficit: sum,
    meanDeficit: total === 0 ? 0 : sum / total,
    mask,
  };
}
