/**
 * Structural facts about a finished SVG, read from the file and nothing else.
 *
 * WHY FROM THE FILE. The properties this measures — how much of the outline is
 * curved, how much boundary each anchor buys, whether neighbouring faces agree
 * on the edge between them — are properties of the artwork someone receives, not
 * of the pipeline that made it. Reading them from our own internals would score
 * a rival's file at zero by construction, and would keep scoring green after a
 * serialisation bug threw the property away on the way out. Everything here
 * parses `d` attributes, so a paid third-party SVG measures on the same terms as
 * ours.
 *
 * Segment CENSUS (curves, lines, subpaths) is deliberately not re-implemented
 * here: scripts/lib/path-stats.mjs already does it and has been corrected twice
 * for undercounting. This module adds the things a census cannot see —
 * geometry (length), identity (twinning) and paint (fills).
 *
 * KNOWN LIMITS, stated rather than discovered later:
 *   - `transform` on a drawing element or an enclosing group is NOT applied.
 *     Lengths and twin keys are in each element's own coordinate system. The
 *     rival promotes some regions to `<ellipse transform="translate() rotate()">`
 *     and those elements are excluded from the path metrics anyway (they have no
 *     `d`), but a future tracer that emits transformed paths would need this.
 *   - `<use>`, `<clipPath>` and markers are not resolved.
 *   - `style="fill:…"` is not parsed; only the `fill` presentation attribute is.
 */

/** Parameters per group, by command. `z` closes and takes none. */
const ARITY = {
  m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0,
};

/** Numbers in a path: optional sign, digits, optional fraction, optional exponent. */
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/** Elements that draw geometry of their own. */
const DRAWING = new Set(['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line']);

// ------------------------------------------------------------------ tokenising

/**
 * Split one `d` attribute into `{ letter, args }` groups, expanding the implicit
 * repeats that make a letter census lie.
 *
 * The rule that catches people out is in the spec: a repeated parameter group
 * after `m`/`M` is a *lineto*, not another moveto. path-stats.mjs carries the
 * same rule; the two must not disagree, so if you change one, change both.
 */
export function groups(d) {
  const out = [];
  for (const chunk of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const letter = chunk[1];
    const key = letter.toLowerCase();
    const arity = ARITY[key];
    if (arity === undefined) continue;
    if (arity === 0) { out.push({ letter, args: [] }); continue; }
    const nums = (chunk[2].match(NUMBER) ?? []).map(Number);
    const count = Math.floor(nums.length / arity);
    for (let g = 0; g < Math.max(1, count); g++) {
      const args = nums.slice(g * arity, g * arity + arity);
      if (args.length < arity) break;
      // Only the first group keeps the letter's own meaning.
      const eff = g === 0 ? letter : (key === 'm' ? (letter === 'M' ? 'L' : 'l') : letter);
      out.push({ letter: eff, args });
    }
  }
  return out;
}

/**
 * Largest number of decimal places any coordinate in the document is written
 * with, capped, used as the grid that twin matching quantises to.
 *
 * Measured rather than assumed because it differs per producer — the rival
 * writes 2 decimals and lifts to 4 for sub-pixel features, and we write 2 by
 * default but a caller can ask for more. Quantising at a fixed depth would
 * either fuse genuinely distinct edges in a high-precision file or, at the other
 * end, split a real twin apart over the 1e-15 that accumulating relative deltas
 * leaves behind.
 */
export function coordinateDecimals(svg, cap = 6) {
  let max = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    for (const n of m[1].match(NUMBER) ?? []) {
      const dot = n.indexOf('.');
      if (dot === -1) continue;
      const exp = n.search(/[eE]/);
      const decimals = (exp === -1 ? n.length : exp) - dot - 1;
      if (decimals > max) max = decimals;
      if (max >= cap) return cap;
    }
  }
  return max;
}

// ------------------------------------------------------------------- geometry

/**
 * Absolute-coordinate segments for one `d`, with the closing line materialised.
 *
 * `z` draws a line back to the subpath start, and our own builder relies on that
 * — it drops a final lineto that lands on the start because `z` already draws
 * it. A twin census that ignored `z` would therefore miss one real edge per face
 * on our output and none on the rival's, which is precisely the kind of
 * asymmetry that makes a cross-tool comparison meaningless.
 */
export function segments(d) {
  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevCtrl = null;       // control point of the previous C/S (for S)
  let prevQCtrl = null;      // control point of the previous Q/T (for T)
  let open = false;          // a subpath has been started
  let sinceMove = 0;         // drawing commands in the current subpath

  const closeIfNeeded = (closed) => {
    if (!open) return;
    if (closed && (cx !== sx || cy !== sy)) {
      out.push({ type: 'L', subpath: out.length === 0 ? 0 : undefined, p: [cx, cy, sx, sy], implicit: true });
      cx = sx; cy = sy;
    }
  };

  for (const { letter, args } of groups(d)) {
    const rel = letter >= 'a';
    const key = letter.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;

    if (key === 'm') {
      // A moveto ends the previous subpath without closing it.
      open = true; sinceMove = 0;
      cx = args[0] + ox; cy = args[1] + oy;
      sx = cx; sy = cy;
      prevCtrl = null; prevQCtrl = null;
      out.push({ type: 'M', p: [cx, cy] });
      continue;
    }
    if (key === 'z') {
      closeIfNeeded(true);
      out.push({ type: 'Z' });
      prevCtrl = null; prevQCtrl = null;
      open = false;
      continue;
    }

    const x0 = cx, y0 = cy;
    if (key === 'l' || key === 'h' || key === 'v') {
      const nx = key === 'v' ? cx : args[0] + ox;
      const ny = key === 'h' ? cy : args[key === 'l' ? 1 : 0] + oy;
      out.push({ type: 'L', p: [x0, y0, nx, ny] });
      cx = nx; cy = ny;
      prevCtrl = null; prevQCtrl = null;
    } else if (key === 'c' || key === 's') {
      let c1x, c1y;
      if (key === 'c') { c1x = args[0] + ox; c1y = args[1] + oy; }
      else { c1x = prevCtrl ? 2 * x0 - prevCtrl[0] : x0; c1y = prevCtrl ? 2 * y0 - prevCtrl[1] : y0; }
      const b = key === 'c' ? 2 : 0;
      const c2x = args[b] + ox, c2y = args[b + 1] + oy;
      const nx = args[b + 2] + ox, ny = args[b + 3] + oy;
      out.push({ type: 'C', p: [x0, y0, c1x, c1y, c2x, c2y, nx, ny] });
      cx = nx; cy = ny; prevCtrl = [c2x, c2y]; prevQCtrl = null;
    } else if (key === 'q' || key === 't') {
      let qx, qy;
      if (key === 'q') { qx = args[0] + ox; qy = args[1] + oy; }
      else { qx = prevQCtrl ? 2 * x0 - prevQCtrl[0] : x0; qy = prevQCtrl ? 2 * y0 - prevQCtrl[1] : y0; }
      const b = key === 'q' ? 2 : 0;
      const nx = args[b] + ox, ny = args[b + 1] + oy;
      out.push({ type: 'Q', p: [x0, y0, qx, qy, nx, ny] });
      cx = nx; cy = ny; prevQCtrl = [qx, qy]; prevCtrl = null;
    } else if (key === 'a') {
      const [rx, ry, rot, laf, sweep] = args;
      const nx = args[5] + ox, ny = args[6] + oy;
      out.push({ type: 'A', p: [x0, y0, nx, ny], arc: [Math.abs(rx), Math.abs(ry), rot, laf ? 1 : 0, sweep ? 1 : 0] });
      cx = nx; cy = ny; prevCtrl = null; prevQCtrl = null;
    }
    sinceMove++;
  }
  return out;
}

/** Sample a cubic. */
const cubicAt = (p, t) => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
  return [
    a * p[0] + b * p[2] + c * p[4] + e * p[6],
    a * p[1] + b * p[3] + c * p[5] + e * p[7],
  ];
};

/** Sample a quadratic. */
const quadAt = (p, t) => {
  const u = 1 - t;
  const a = u * u, b = 2 * u * t, c = t * t;
  return [a * p[0] + b * p[2] + c * p[4], a * p[1] + b * p[3] + c * p[5]];
};

/**
 * Endpoint -> centre parameterisation, per the SVG 1.1 implementation notes.
 * Returns null for a degenerate arc, which the spec says to draw as a line.
 */
function arcCentre(x0, y0, x1, y1, rx, ry, rotDeg, laf, sweep) {
  if (rx === 0 || ry === 0) return null;
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // Radii too small to span the endpoints are scaled up, again per the spec.
  let rxs = rx * rx, rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry;
  }
  const denom = rxs * y1p * y1p + rys * x1p * x1p;
  if (denom === 0) return null;
  let factor = (rxs * rys - denom) / denom;
  if (factor < 0) factor = 0;
  const coef = (laf === sweep ? -1 : 1) * Math.sqrt(factor);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;

  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, t1, dt };
}

/**
 * Arc-length of one segment.
 *
 * Curves are sampled rather than integrated in closed form. 64 chords is far
 * more than the sub-pixel arcs a tracer emits need: on a full circle of radius
 * 100 it is within 0.001% of 2*pi*r, and the figure this feeds — boundary pixels
 * per anchor — is reported to two decimals.
 */
export function segmentLength(seg, samples = 64) {
  if (seg.type === 'L') return Math.hypot(seg.p[2] - seg.p[0], seg.p[3] - seg.p[1]);
  if (seg.type === 'M' || seg.type === 'Z') return 0;
  if (seg.type === 'A') {
    const [x0, y0, x1, y1] = seg.p;
    const [rx, ry, rot, laf, sweep] = seg.arc;
    const c = arcCentre(x0, y0, x1, y1, rx, ry, rot, laf, sweep);
    if (!c) return Math.hypot(x1 - x0, y1 - y0);
    let len = 0, px = x0, py = y0;
    for (let i = 1; i <= samples; i++) {
      const t = c.t1 + (c.dt * i) / samples;
      const ct = Math.cos(t), st = Math.sin(t);
      const x = c.cx + c.rx * Math.cos(c.phi) * ct - c.ry * Math.sin(c.phi) * st;
      const y = c.cy + c.rx * Math.sin(c.phi) * ct + c.ry * Math.cos(c.phi) * st;
      len += Math.hypot(x - px, y - py); px = x; py = y;
    }
    return len;
  }
  const at = seg.type === 'C' ? cubicAt : quadAt;
  let len = 0, prev = at(seg.p, 0);
  for (let i = 1; i <= samples; i++) {
    const pt = at(seg.p, i / samples);
    len += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
    prev = pt;
  }
  return len;
}

// ----------------------------------------------------------------- twin edges

/**
 * A key that is the same for an edge and for that edge traced backwards.
 *
 * This is the whole point of the mosaic property. Two faces that meet share one
 * boundary, and the face on each side walks it in the opposite direction — so
 * the test for "these two faces agree about the edge between them" is that the
 * forward spelling of one equals the reversed spelling of the other, control
 * points and all. For an elliptical arc, reversal also flips the sweep flag; get
 * that wrong and every arc in the rival's file reads as unshared.
 *
 * Coordinates are quantised to the document's own precision grid, so this is
 * "identical as written", not "close enough".
 */
export function edgeKey(seg, decimals) {
  const q = (v) => {
    const f = 10 ** decimals;
    const r = Math.round(v * f) / f;
    return Object.is(r, -0) ? '0' : String(r);
  };
  const pt = (i) => `${q(seg.p[i])},${q(seg.p[i + 1])}`;
  let fwd, rev;
  if (seg.type === 'L') {
    fwd = `L|${pt(0)}|${pt(2)}`;
    rev = `L|${pt(2)}|${pt(0)}`;
  } else if (seg.type === 'C') {
    fwd = `C|${pt(0)}|${pt(2)}|${pt(4)}|${pt(6)}`;
    rev = `C|${pt(6)}|${pt(4)}|${pt(2)}|${pt(0)}`;
  } else if (seg.type === 'Q') {
    fwd = `Q|${pt(0)}|${pt(2)}|${pt(4)}`;
    rev = `Q|${pt(4)}|${pt(2)}|${pt(0)}`;
  } else if (seg.type === 'A') {
    const [rx, ry, rot, laf, sweep] = seg.arc;
    const head = `A|${q(rx)},${q(ry)},${q(rot)},${laf}`;
    fwd = `${head},${sweep}|${pt(0)}|${pt(2)}`;
    rev = `${head},${1 - sweep}|${pt(2)}|${pt(0)}`;
  } else {
    return null;
  }
  return fwd < rev ? fwd : rev;
}

// ------------------------------------------------------------------- document

/** Attributes of one tag, as written. */
function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Every drawing element, with the `fill` it actually paints with.
 *
 * Fill is inherited, and the rival puts its whole seam-cover pass inside a
 * `<g fill="none">`. Reading only the element's own attribute would count 95
 * stroke-only paths as faces and drag every per-face figure sideways.
 */
export function elements(svg) {
  const out = [];
  const stack = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    const [, closing, tag, body, selfClose] = m;
    if (closing) { if (tag === 'g' || tag === 'svg') stack.pop(); continue; }
    const a = attrs(body);
    if (tag === 'g' || tag === 'svg') {
      if (!selfClose) stack.push(a);
      continue;
    }
    if (!DRAWING.has(tag)) continue;
    let fill = a.fill;
    for (let i = stack.length - 1; i >= 0 && fill === undefined; i--) fill = stack[i].fill;
    let stroke = a.stroke;
    for (let i = stack.length - 1; i >= 0 && stroke === undefined; i--) stroke = stack[i].stroke;
    out.push({ tag, attrs: a, fill: fill ?? 'black', stroke: stroke ?? 'none', d: a.d });
  }
  return out;
}

/** Canvas box, for deciding which edges run along the image border. */
export function canvas(svg) {
  const vb = /viewBox\s*=\s*"([^"]*)"/.exec(svg);
  if (vb) {
    const n = (vb[1].match(NUMBER) ?? []).map(Number);
    if (n.length >= 4) return { x: n[0], y: n[1], w: n[2], h: n[3] };
  }
  const w = /\swidth\s*=\s*"([\d.]+)/.exec(svg);
  const h = /\sheight\s*=\s*"([\d.]+)/.exec(svg);
  if (w && h) return { x: 0, y: 0, w: Number(w[1]), h: Number(h[1]) };
  return null;
}

/**
 * The full structural report for one document.
 *
 * `faces` are the elements that paint an area. Only those take part in the twin
 * census: a seam-cover stroke retraces a boundary that is already shared, and
 * counting it would let a producer raise its own score by drawing more strokes.
 *
 * TWO CHOICES IN THE TWIN CENSUS, AND WHY.
 *
 * A twin must come from a different SUBPATH rather than a different `<path>`
 * element. On every subject measured so far the two rules give the same number
 * to two decimals, so this is not a correction of anything — it is the rule that
 * stays correct when the emitter changes its mind about grouping. Two faces of
 * the same colour can land in one element as two subpaths, and an
 * element-based rule would then score the boundary between them as unshared for
 * a reason that has nothing to do with whether the faces agree about it. A twin
 * from the *same* subpath is still rejected: an edge that only matches itself is
 * a degenerate loop, not a shared boundary.
 *
 * Zero-length edges are dropped rather than counted. They can only ever match
 * each other, so leaving them in would let a producer raise its score with
 * segments that draw nothing.
 *
 * WHY 100% IS NOT THE CEILING, measured rather than assumed. An edge can only
 * have a twin if a face is painted on both sides of it. Two situations break
 * that, and both are legitimate:
 *
 *   - The artwork sits on transparent background. logo-tux's silhouette faces
 *     nothing, so those edges are unshared in the rival's file (73 of 919, and
 *     it scores 92.06%) exactly as they are in ours (124 of 1806, 93.13%).
 *   - A background is painted as one full-bleed rectangle underneath rather
 *     than as a tile in the mosaic. Our `clean` output does this: on a
 *     four-colour fixture with a full-bleed blue field, all 18 unmatched edges
 *     out of 158 are edges whose other side is that background rectangle.
 *
 * So read this as "of the boundaries that could be shared, how many are", with a
 * per-subject ceiling that the baseline captures. It is not a percentage to
 * compare across subjects.
 */
export function structure(svg, { borderEpsilon = 0.51 } = {}) {
  const decimals = coordinateDecimals(svg);
  const box = canvas(svg);
  const els = elements(svg);
  const faces = els.filter((e) => e.fill !== 'none');
  const facePaths = faces.filter((e) => typeof e.d === 'string');
  const primitives = faces.filter((e) => typeof e.d !== 'string').length;

  /**
   * True when the whole segment lies along ONE side of the canvas.
   *
   * The obvious version — "both endpoints touch some border" — is wrong, and
   * wrong in a way that quietly empties the census. The divider between two
   * faces that span the image runs from the top edge to the bottom edge, so
   * both of its endpoints touch a border while the edge itself is the most
   * interior thing in the picture. Written that way, a two-square mosaic
   * reported 0 interior edges and a twin percentage of zero.
   *
   * Control points count too: a curve that starts and ends on the frame but
   * bulges into the image is not a frame edge.
   */
  const borderEdge = (seg) => {
    if (!box) return false;
    const pts = [];
    for (let i = 0; i + 1 < seg.p.length; i += 2) pts.push([seg.p[i], seg.p[i + 1]]);
    const sides = [
      (p) => Math.abs(p[0] - box.x) <= borderEpsilon,
      (p) => Math.abs(p[0] - (box.x + box.w)) <= borderEpsilon,
      (p) => Math.abs(p[1] - box.y) <= borderEpsilon,
      (p) => Math.abs(p[1] - (box.y + box.h)) <= borderEpsilon,
    ];
    return sides.some((on) => pts.every(on));
  };

  /** Occurrences of each edge key, by the index of the path that drew it. */
  const seen = new Map();
  const edges = [];
  let length = 0;
  let anchors = 0;
  let closedSubpaths = 0;
  let openSubpaths = 0;

  let subpathId = 0;
  let degenerate = 0;
  facePaths.forEach((el, pathIndex) => {
    const segs = segments(el.d);
    // Anchors: one on-path node per drawing command, plus a start node for a
    // subpath that never closes back onto it.
    let drawn = 0;
    let started = false;
    const finishSubpath = (closed) => {
      if (!started) return;
      anchors += drawn + (closed ? 0 : 1);
      if (closed) closedSubpaths++; else openSubpaths++;
      drawn = 0;
      subpathId++;
    };
    for (const seg of segs) {
      if (seg.type === 'M') { finishSubpath(false); started = true; continue; }
      if (seg.type === 'Z') { finishSubpath(true); started = false; continue; }
      drawn++;
      const len = segmentLength(seg);
      length += len;
      const key = edgeKey(seg, decimals);
      if (key === null) continue;
      if (len === 0) { degenerate++; continue; }
      const edge = { key, pathIndex, subpathId, len, border: borderEdge(seg), type: seg.type };
      edges.push(edge);
      const bucket = seen.get(key);
      if (bucket) bucket.push(edge); else seen.set(key, [edge]);
    }
    finishSubpath(false);
  });

  let interior = 0;
  let twinned = 0;
  let interiorLength = 0;
  let twinnedLength = 0;
  for (const edge of edges) {
    if (edge.border) continue;
    interior++;
    interiorLength += edge.len;
    const bucket = seen.get(edge.key);
    if (bucket.some((o) => o.subpathId !== edge.subpathId)) { twinned++; twinnedLength += edge.len; }
  }

  const fills = new Set(faces.map((e) => e.fill.trim().toLowerCase()));
  return {
    decimals,
    canvas: box,
    faces: faces.length,
    facePaths: facePaths.length,
    facePrimitives: primitives,
    strokeOnly: els.length - faces.length,
    fills: fills.size,
    boundaryLength: length,
    anchors,
    closedSubpaths,
    openSubpaths,
    pxPerAnchor: anchors === 0 ? 0 : length / anchors,
    interiorEdges: interior,
    twinnedEdges: twinned,
    twinPct: interior === 0 ? 0 : (twinned / interior) * 100,
    twinLengthPct: interiorLength === 0 ? 0 : (twinnedLength / interiorLength) * 100,
    unmatchedEdges: interior - twinned,
    borderEdges: edges.length - interior,
    degenerateEdges: degenerate,
  };
}
