/**
 * The playground's off-thread half.
 *
 * Everything here used to run on the main thread, which meant the page did not
 * merely feel slow during a conversion — it stopped. No repaint, no scroll, no
 * way to move the slider you had just moved. A tracer is a long synchronous
 * call; the only place it can run without freezing a tab is a worker.
 *
 * It imports the same committed browser bundle the page does, so there is no
 * second build step and no chance of the two halves running different engines.
 *
 * Two things deliberately stay on the main thread and are not reimplemented
 * here: decoding a dropped file, and rendering an SVG back to pixels. Both need
 * `new Image()` and a canvas, which a worker does not have. The page renders,
 * and posts the pixels here to be scored — the same split the Studio uses, and
 * for the same reason.
 */
import {
  trace,
  vectorizeExact,
  centerlineTrace,
  compareImages,
  optimizeSvg,
} from './vecline-core.js';

/**
 * Progress belongs to one request at a time.
 *
 * Set for the duration of a conversion and cleared in a `finally`, so a stray
 * callback after the response cannot post against a request that has already
 * been answered. Reporting is inert when it is null, which is what lets the
 * options builder below attach a callback unconditionally.
 */
let progressFor = null;

function report(stage, pct) {
  if (progressFor === null) return;
  self.postMessage({ id: progressFor, ok: true, kind: 'progress', stage, pct });
}

/**
 * The tracer reports four stages of its own across 0–100. They are compressed
 * into the band that tracing owns here, because preparation happens before it
 * and minification and scoring after — the same reasoning, and the same band,
 * as the Studio's worker.
 */
const TRACE_LO = 20;
const TRACE_HI = 75;

function traceOptions(s) {
  return {
    colors: s.colors,
    tolerance: s.tolerance,
    fitError: s.tolerance,
    gradients: s.gradients,
    primitives: s.primitives,
    onProgress: (stage, pct) =>
      report(stage, TRACE_LO + (Math.max(0, Math.min(100, pct)) * (TRACE_HI - TRACE_LO)) / 100),
  };
}

function convert(image, settings) {
  const t0 = performance.now();
  let svg;
  let shapes = 0;

  if (settings.mode === 'centerline') {
    // No progress callback exists for these two, so they are bracketed from out
    // here and say nothing while they run. Inventing a crawl for them would be
    // exactly the dishonesty the measured numbers on this page exist to avoid.
    report('Finding centerlines', TRACE_LO);
    const r = centerlineTrace(image, {});
    svg = r.svg;
    shapes = r.paths;
  } else if (settings.mode === 'pixel') {
    report('Building exact geometry', TRACE_LO);
    const r = vectorizeExact(image);
    svg = r.svg;
    shapes = r.shapes;
  } else {
    const r = trace(image, traceOptions(settings));
    svg = r.svg;
    shapes = r.shapes;
  }

  // Timed before minification, deliberately: this is how long the *conversion*
  // took, and folding an optional post-process into it would make the number
  // change when a checkbox did.
  const ms = performance.now() - t0;

  if (settings.minify) {
    report('Minifying', 80);
    svg = optimizeSvg(svg);
  }

  return { svg, shapes, ms };
}

self.onmessage = (e) => {
  const req = e.data;
  let res;
  try {
    if (req.kind === 'convert') {
      progressFor = req.id;
      try {
        const out = convert(req.image, req.settings);
        res = { id: req.id, ok: true, kind: 'convert', ...out };
      } finally {
        progressFor = null;
      }
    } else if (req.kind === 'measure') {
      const q = compareImages(req.a, req.b);
      res = {
        id: req.id,
        ok: true,
        kind: 'measure',
        ssim: q.ssim,
        psnr: q.psnr,
        deltaE: q.deltaE.mean,
      };
    } else {
      throw new Error(`Unknown request: ${req.kind}`);
    }
  } catch (err) {
    res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(res);
};
