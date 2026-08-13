/**
 * Structured trace geometry — the shared substrate the non-SVG exporters build
 * on. `trace()` serialises straight to an SVG string; the CAD/print writers
 * (DXF, EPS, PDF) need the fitted paths as data, so this runs the same
 * quantise → segment → contour → fit pipeline and hands back per-colour Béziers
 * without ever touching SVG. Pure TypeScript, so it stays in the portable core.
 */

import { quantize, NearestColor } from '../../vectorize/quantize.js';
import { connectedComponents, despeckle } from '../../vectorize/components.js';
import { traceComponents } from '../../vectorize/contour.js';
import { fitLoop, type FittedPath, type FitOptions } from '../../vectorize/fit.js';
import { detectPrimitive, type Primitive } from '../../vectorize/primitives.js';
import { autoMinArea, TRACE_DEFAULTS, type TraceOptions } from '../../vectorize/trace.js';
import type { RasterImage, Rgba } from '../../types.js';

/** One colour's geometry: a fill colour and its closed contours. */
export interface GeometryPath {
  color: Rgba;
  /** Closed sub-paths (outer boundaries and holes) sharing the colour. */
  subpaths: FittedPath[];
  /**
   * Recognised primitive per sub-path, aligned by index with {@link subpaths}
   * (`null` where the contour is not a clean circle/ellipse/rectangle). Lets an
   * exporter emit a true `CIRCLE`/`ELLIPSE` — a real arc a laser or router cuts
   * in one move — instead of a faceted polyline. Present unless detection was
   * disabled with `primitives: false`.
   */
  primitives?: (Primitive | null)[];
}

export interface TraceGeometry {
  width: number;
  height: number;
  /** Largest-area colour first, so a renderer draws detail over broad fields. */
  paths: GeometryPath[];
}

/**
 * Trace an image to structured per-colour Bézier geometry (no SVG). Honours the
 * palette, fit and turn-policy options of {@link TraceOptions}; gradient and
 * SVG-only options are ignored, since the exporters emit flat fills.
 */
export function traceGeometry(source: RasterImage, opts: TraceOptions = {}): TraceGeometry {
  const o = { ...TRACE_DEFAULTS, minArea: autoMinArea(source.width * source.height), ...stripUndef(opts) };
  const { width, height, data } = source;
  const n = width * height;

  const palette = quantize(source, o.colors, {
    refineIterations: o.refineIterations,
    fillStrategy: o.fillStrategy,
    fixedPalette: o.fixedPalette,
  });
  const nearest = new NearestColor(palette, n);

  const classes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    if (data[off + 3] < 8) { classes[i] = -1; continue; }
    classes[i] = nearest.index(data[off], data[off + 1], data[off + 2]);
  }

  let comps = connectedComponents(classes, width, height, -1);
  if (o.minArea > 1) {
    for (let pass = 0; pass < 2; pass++) {
      const merged = despeckle(classes, comps, width, height, o.minArea, -1);
      if (merged === 0) break;
      comps = connectedComponents(classes, width, height, -1);
    }
  }

  const loops = traceComponents(comps.labels, width, height, comps.count, o.turnPolicy);

  // Group components by colour class and sort by total area, biggest first.
  const byClass = new Map<number, number[]>();
  const area = new Map<number, number>();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    (byClass.get(cls) ?? byClass.set(cls, []).get(cls)!).push(c);
    area.set(cls, (area.get(cls) ?? 0) + comps.areas[c]);
  }
  const ordered = [...byClass.keys()].sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0) || a - b);

  const fitOpts: FitOptions = {
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    polygonOnly: o.polygonOnly,
    optimize: o.optimize,
    optimizeError: o.optimizeError,
    rightAngleEnhance: o.rightAngleEnhance,
    rightAngleThreshold: o.rightAngleThreshold,
  };

  // Recognise primitives by default for the exporters: a DXF CIRCLE beats a
  // 12-gon for anything that will be cut. Opt out with `primitives: false`.
  const wantPrimitives = opts.primitives !== false;

  const paths: GeometryPath[] = [];
  for (const cls of ordered) {
    const subpaths: FittedPath[] = [];
    const primitives: (Primitive | null)[] = [];
    for (const c of byClass.get(cls)!) {
      for (const loop of loops[c]) {
        const fitted = fitLoop(loop.pts, fitOpts);
        if (!fitted) continue;
        subpaths.push(fitted);
        // Detect per sub-path (holes included), so a ring becomes two circles —
        // exactly what a cutter wants. Aligned by index with `subpaths`.
        primitives.push(wantPrimitives ? detectPrimitive(loop.pts, { maxError: o.primitiveError }) : null);
      }
    }
    if (subpaths.length === 0) continue;
    paths.push({
      color: { r: palette.rgb[cls * 3], g: palette.rgb[cls * 3 + 1], b: palette.rgb[cls * 3 + 2], a: 255 },
      subpaths,
      ...(wantPrimitives ? { primitives } : {}),
    });
  }

  return { width, height, paths };
}

function stripUndef<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
