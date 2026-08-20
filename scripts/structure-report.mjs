#!/usr/bin/env node
/**
 * What SHAPE is the output — and did that shape change?
 *
 * WHY THIS EXISTS. `--preset clean` is the one preset that is not trying to be
 * faithful. It redraws flat artwork as smooth filled faces, and fidelity metrics
 * punish it for exactly the thing it is for: on logo-tux it scores SSIM 0.9168
 * where plain `auto` scores 0.9913, because `auto` reproduces the input's
 * staircase and `clean` does not. So every gate this project owns is either
 * silent about `clean` or actively pointed the wrong way, and the defect that
 * shipped in v2.1.0 proves what that costs: `clean` emitted ZERO curve commands
 * for an entire release. Nothing failed. Nothing looked.
 *
 * The properties that were wrong then are structural, not photometric:
 *
 *   curve fraction     how much of the outline is drawn as curves rather than
 *                      lattice steps. The zero-curve defect was a curve fraction
 *                      of 0.00% sitting in a released preset.
 *   px per anchor      how much boundary each anchor buys. Falling means the
 *                      output is being spelled out point by point again.
 *   twinned edges      whether two faces that meet agree, to the digit, about
 *                      the boundary between them. This is the mosaic property
 *                      arcs.ts exists to provide, and it is what separates a
 *                      redrawn illustration from a pile of independently fitted
 *                      outlines that leave seams.
 *   segments/subpaths/fills/bytes  the cost side, so none of the above can be
 *                      bought by emitting more.
 *   SSIM               a floor under all of it. Without one, every structural
 *                      axis above is won outright by emitting a single ellipse.
 *
 * MEASURED FROM THE FILE, NOT FROM OUR INTERNALS. Everything comes out of the
 * emitted `d` attributes (scripts/lib/svg-structure.mjs), so a paid third-party
 * SVG can be dropped in and scored on identical terms — and so a serialisation
 * bug that throws the property away on the way out cannot keep the gate green.
 *
 *   npm run structure                 # markdown table, built-in subjects
 *   npm run structure -- --json       # machine-readable
 *   npm run structure:check           # compare against the committed baseline
 *   npm run structure -- --update     # rewrite the baseline after a deliberate change
 *   npm run structure -- corpus/src   # add real subjects, and the rival's files
 *                                     #   from corpus/src/Vectorizer.AI/ where present
 *
 * SUBJECTS ARE SYNTHESISED, for the same reason bench.mjs synthesises its own:
 * corpus/ is gitignored and holds paid third-party output, so a gate that needed
 * it could never run in CI. The four built-ins are chosen to pull in different
 * directions rather than to flatter:
 *
 *   flat-disc  curves and straight dividers over a full-bleed background
 *   petals     overlapping lobes — many three-face junctions, the case arcs.ts
 *              splits boundaries for
 *   keycap     rectangles only. `clean` correctly emits 0% curves here, so this
 *              subject is the guard in the OTHER direction: a change that starts
 *              rounding off straight artwork to raise its curve fraction
 *              elsewhere moves this row and trips the gate.
 *   glyph      a curved mark on transparent background, the logo-tux situation:
 *              the silhouette faces nothing, so the twin ceiling is below 100%
 *
 * A NOTE ON THE GATE'S DIRECTION. It fails on movement either way, not only on
 * movement that looks bad. Two reasons. The obvious one is that "better" is not
 * a property of a number — a rising curve fraction is the goal on `petals` and a
 * defect on `keycap`. The less obvious one is the ratchet: a one-sided gate whose
 * baseline is never refreshed slowly stops being able to fail, because the real
 * output drifts far above a floor nobody updated. The committed baseline is data
 * that a change is expected to update deliberately, the same contract the
 * playground-bundle job already uses.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadRaster, vectorize } from '../dist/esm/api.js';
import { encodeRaster } from '../dist/esm/io/encode.js';
import { pathStats } from './lib/path-stats.mjs';
import { structure } from './lib/svg-structure.mjs';
import { diff } from './lib/structure-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- configuration

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
// Only a *present* flag consumes the token after it. bench-scale.mjs learned
// this the hard way: deriving the set from `indexOf` unconditionally reads
// argv[0] for every absent flag and swallows the positional argument.
const FLAG_VALUES = new Set(
  ['baseline', 'preset']
    .map((n) => argv.indexOf(`--${n}`))
    .filter((i) => i !== -1)
    .map((i) => argv[i + 1]),
);
const corpusDir = argv.find((a) => !a.startsWith('--') && !FLAG_VALUES.has(a));
const asJson = has('json');
const checking = has('check');
const updating = has('update');
const PRESET = flag('preset', 'clean');
const BASELINE = path.resolve(root, flag('baseline', 'baselines/structure.json'));

// The allowances, the direction notes and the comparison itself live in
// scripts/lib/structure-gate.mjs, which has no entrypoint and so can be tested
// without running the tracer. See the note at the top of that file.

// -------------------------------------------------------------------- subjects

const image = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
const put = (img, x, y, c) => {
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
  img.data[o + 3] = c.length > 3 ? c[3] : 255;
};

/** Curves and straight dividers over a full-bleed field. bench.mjs's fixture. */
function flatDisc(W, H) {
  const img = image(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - W / 2, y - H / 2);
      if (d < H / 5) put(img, x, y, [250, 244, 232]);
      else if (d < H / 2.7) put(img, x, y, [214, 69, 65]);
      else if (x < W / 3) put(img, x, y, [32, 96, 160]);
      else if (x < (2 * W) / 3) put(img, x, y, [250, 244, 232]);
      else put(img, x, y, [40, 150, 110]);
    }
  }
  return img;
}

/** Six overlapping lobes: many places where three faces meet at a point. */
function petals(N) {
  const img = image(N, N);
  const cx = N / 2, cy = N / 2, R = N * 0.42;
  const lobe = [
    [236, 84, 80], [247, 168, 54], [112, 183, 86],
    [64, 140, 206], [142, 102, 190], [233, 110, 160],
  ];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = [26, 29, 38];
      for (let i = lobe.length - 1; i >= 0; i--) {
        const a = (i / lobe.length) * 2 * Math.PI;
        if (Math.hypot(x - (cx + Math.cos(a) * R * 0.52), y - (cy + Math.sin(a) * R * 0.52)) < R * 0.46) c = lobe[i];
      }
      if (Math.hypot(x - cx, y - cy) < R * 0.22) c = [250, 247, 238];
      put(img, x, y, c);
    }
  }
  return img;
}

/** Rectangles and a staircase. Nothing here should ever become a curve. */
function keycap(W, H) {
  const img = image(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = [240, 238, 232];
      if (x >= W * 0.08 && x < W * 0.92 && y >= H * 0.10 && y < H * 0.90) c = [52, 58, 72];
      if (x >= W * 0.14 && x < W * 0.86 && y >= H * 0.18 && y < H * 0.60) c = [96, 196, 182];
      const step = Math.floor((x - W * 0.14) / (W * 0.10));
      if (x >= W * 0.14 && x < W * 0.86 && y >= H * 0.62 && y < H * 0.62 + step * 6 + 4) c = [245, 196, 72];
      if (y >= H * 0.30 && y < H * 0.42 && x >= W * 0.22 && x < W * 0.50) c = [52, 58, 72];
      put(img, x, y, c);
    }
  }
  return img;
}

/**
 * A curved mark on transparent background — logo-tux's situation in miniature.
 *
 * The silhouette here borders nothing, so those edges can never be twinned. The
 * subject is in the set precisely so the baseline records a twin ceiling that is
 * NOT 100%, and nobody later reads a number in the low nineties as a failure.
 */
function glyph(N) {
  const img = image(N, N);
  const cx = N / 2, cy = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.atan2(y - cy, x - cx);
      const outer = N * 0.44 * (1 + 0.10 * Math.cos(a * 3));
      if (d > outer) continue;                              // transparent
      if (d > N * 0.30) put(img, x, y, [46, 62, 118]);
      else if (d > N * 0.16) put(img, x, y, [236, 240, 250]);
      else put(img, x, y, [214, 84, 66]);
      // A notch, so the mark is not radially symmetric and the fitter has a
      // corner to find.
      if (x > cx && Math.abs(y - cy) < N * 0.055 && d > N * 0.16) put(img, x, y, [46, 62, 118]);
    }
  }
  return img;
}

const BUILT_IN = [
  { name: 'flat-disc', img: () => flatDisc(400, 300) },
  { name: 'petals', img: () => petals(256) },
  { name: 'keycap', img: () => keycap(240, 180) },
  { name: 'glyph', img: () => glyph(200) },
];

// ------------------------------------------------------------------ measuring

/** Every structural figure for one finished SVG, plus its size on the wire. */
function measure(svg) {
  const stats = pathStats(svg);
  const st = structure(svg);
  const bytes = Buffer.byteLength(svg);
  return {
    curvePct: stats.curvePct,
    curves: stats.curves,
    lines: stats.lines,
    segments: stats.segments,
    subpaths: stats.subpaths,
    primitives: stats.primitives + st.facePrimitives,
    fills: st.fills,
    faces: st.faces,
    boundaryPx: st.boundaryLength,
    anchors: st.anchors,
    pxPerAnchor: st.pxPerAnchor,
    interiorEdges: st.interiorEdges,
    twinnedEdges: st.twinnedEdges,
    unmatchedEdges: st.unmatchedEdges,
    borderEdges: st.borderEdges,
    twinPct: st.twinPct,
    twinLengthPct: st.twinLengthPct,
    bytes,
    gzip: gzipSync(Buffer.from(svg, 'utf8'), { level: 9 }).length,
  };
}

/**
 * Run one subject through the tracer and measure the result.
 *
 * `noGenerator` is not cosmetic. The generator comment carries the package
 * version, so leaving it in would make every byte figure move on release and
 * turn a version bump into a structural regression.
 */
async function runOurs(source, preset) {
  const result = await vectorize(source, { preset, verify: true, noGenerator: true });
  return {
    producer: `vecline ${preset}`,
    mode: result.mode,
    ssim: result.quality?.ssim ?? null,
    svg: result.svg,
    ...measure(result.svg),
  };
}

/**
 * Score a rival's SVG on the same terms, including SSIM against the same input.
 *
 * Rendering is best-effort: it needs the optional resvg dependency, and a row
 * that reports every structural figure with SSIM blank is far more useful than
 * no row at all.
 */
async function runRival(svg, name, image, subject) {
  let ssim = null;
  try {
    const { rasterizeSvg } = await import('../dist/esm/io/rasterize.js');
    const { compareImages } = await import('../dist/esm/metrics/index.js');
    const rendered = await rasterizeSvg(svg, { width: image.width, height: image.height });
    let candidate = rendered.image ?? rendered;
    // resvg fits ONE axis (width) and lets the other float from the SVG's own
    // aspect ratio (resolveFit in src/io/rasterize.ts, by design). A rival
    // document whose viewBox aspect is not bit-identical to the source
    // raster's — sumansarkar-grand-opening-7142417 is 1.32296 against the PNG's
    // 1.32321 — rounds to an off-by-one-pixel height. That is a measurement
    // artifact, not a reason to drop the row, so resize onto the reference's
    // exact grid before scoring.
    if (candidate.width !== image.width || candidate.height !== image.height) {
      const { default: sharp } = await import('sharp');
      const { data } = await sharp(Buffer.from(candidate.data), {
        raw: { width: candidate.width, height: candidate.height, channels: 4 },
      }).resize(image.width, image.height).raw().toBuffer({ resolveWithObject: true });
      candidate = { width: image.width, height: image.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
    }
    ssim = compareImages(image, candidate).ssim;
  } catch (err) {
    // A real renderer gap (no renderer available, or a construct resvg cannot
    // draw) still degrades gracefully to a blank SSIM cell — but says why,
    // instead of the bare `catch {}` this used to be. That swallowed a real
    // bug the same way it would a genuine gap: a 1px rounding mismatch above
    // threw here and came out looking identical to "could not render".
    console.error(`  ! ${subject ?? '(unknown subject)'} / ${name}: rival SSIM unavailable — ${err.message}`);
  }
  return { producer: name, mode: 'external', ssim, svg, ...measure(svg) };
}

/** Encode a synthesised image the way a user would hand one to the CLI. */
async function sourceFromImage(img) {
  return loadRaster(await encodeRaster(img, { format: 'png' }));
}

// ----------------------------------------------------------------------- main

async function main() {
  const rows = [];
  let determinism = null;

  for (const subject of BUILT_IN) {
    const img = subject.img();
    const source = await sourceFromImage(img);
    const ours = await runOurs(source, PRESET);
    rows.push({ subject: subject.name, gated: true, ...ours });

    // The tolerances in structure-gate.mjs claim this pipeline is
    // deterministic. Check the
    // claim rather than resting on it — a gate calibrated for noise that is not
    // there would be far too loose, and one calibrated against noise that
    // appeared later would flake without saying why.
    if (determinism === null) {
      const again = await runOurs(source, PRESET);
      determinism = again.svg === ours.svg;
    }
  }

  if (corpusDir) {
    const dir = path.resolve(corpusDir);
    const rivalDir = path.join(dir, 'Vectorizer.AI');
    const files = existsSync(dir) ? await readdir(dir) : [];
    for (const file of files.sort()) {
      if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) continue;
      const name = file.replace(/\.[^.]+$/, '');
      const source = await loadRaster(path.join(dir, file));
      // Corpus subjects are reported, never gated: their inputs are gitignored,
      // so CI cannot reproduce a baseline built from them.
      rows.push({ subject: name, gated: false, ...(await runOurs(source, PRESET)) });
      const rival = path.join(rivalDir, `${name}.svg`);
      if (existsSync(rival)) {
        const svg = await readFile(rival, 'utf8');
        rows.push({ subject: name, gated: false, ...(await runRival(svg, 'Vectorizer.AI', source.image, name)) });
      }
    }
  }

  const report = {
    preset: PRESET,
    determinism,
    generatedBy: 'scripts/structure-report.mjs',
    rows: rows.map(({ svg, ...rest }) => rest),
  };

  if (updating) {
    const gated = report.rows.filter((r) => r.gated);
    await writeFile(BASELINE, `${JSON.stringify({ ...report, rows: gated }, null, 2)}\n`);
    console.log(`Wrote ${gated.length} baseline rows to ${path.relative(root, BASELINE)}`);
    return 0;
  }

  if (checking) {
    if (!existsSync(BASELINE)) {
      console.error(`No baseline at ${path.relative(root, BASELINE)}. Create one with:  npm run structure -- --update`);
      return 1;
    }
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
    if (baseline.preset !== PRESET) {
      console.error(`Baseline was measured with preset "${baseline.preset}", this run used "${PRESET}".`);
      return 1;
    }
    // A gate with nothing to compare passes every time. Say so out loud rather
    // than printing a green line about zero rows.
    const gatedRows = report.rows.filter((r) => r.gated).length;
    if (gatedRows === 0 || !Array.isArray(baseline.rows) || baseline.rows.length === 0) {
      console.error(`Nothing to compare: ${gatedRows} measured rows against ${baseline.rows?.length ?? 0} baseline rows.`);
      return 1;
    }
    const problems = diff(report.rows, baseline);
    if (determinism === false) {
      console.error('The tracer did not return identical SVG for identical input. Fix that before trusting anything below.');
    }
    if (problems.length === 0) {
      console.log(`Structure matches the baseline on all ${report.rows.filter((r) => r.gated).length} gated rows (preset "${PRESET}").`);
      return determinism === false ? 1 : 0;
    }
    console.error(`\nStructure moved on ${new Set(problems.map((p) => p.key)).size} row(s):\n`);
    for (const p of problems) console.error(`  ${p.message}`);
    console.error(
      '\nThe output no longer has the shape the committed baseline records.'
      + '\nIf the change is intended, look at the rendered result, then run:'
      + '\n    npm run structure -- --update'
      + '\nand commit baselines/structure.json as part of the same change.\n',
    );
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`Preset: ${PRESET}   deterministic: ${determinism ? 'yes' : 'NO'}\n`);
  console.log('| Subject | Producer | Curves | Segs | Subs | Fills | px/anchor | Twin edges | SSIM | Bytes | Gzip |');
  console.log('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of report.rows) {
    console.log(
      `| ${r.subject} | ${r.producer} | ${r.curvePct.toFixed(1)}% | ${r.segments} | ${r.subpaths} | ${r.fills} | `
      + `${r.pxPerAnchor.toFixed(2)} | ${r.twinPct.toFixed(1)}% (${r.twinnedEdges}/${r.interiorEdges}) | `
      + `${r.ssim == null ? '—' : r.ssim.toFixed(4)} | ${(r.bytes / 1024).toFixed(1)} KB | ${(r.gzip / 1024).toFixed(1)} KB |`,
    );
  }
  console.log('\nCurves = curve commands / (curves + lines), counted inside d="..." with implicit repeats expanded.');
  console.log('Twin edges = interior edges whose exact reverse is drawn by another subpath. Edges along the');
  console.log('canvas border are excluded; edges facing transparent background or a full-bleed backdrop cannot');
  console.log('be twinned at all, which is why the ceiling is per-subject and below 100%.');
  return 0;
}

process.exitCode = await main();
