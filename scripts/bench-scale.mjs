#!/usr/bin/env node
// bench-scale.mjs — scale-fidelity benchmark for vectorizers.
//
// The premise: a vectorizer's job is not to reproduce the input bitmap. It is to
// recover the resolution-independent shape the bitmap was a sample of. So score
// it where that difference shows up — at a magnification the input never
// contained.
//
//   ground-truth SVG --render 1x--> input PNG --vectorize--> candidate SVG
//                    --render 4x--> truth PNG <--render 4x-- candidate SVG
//                                      \____ compare, weighted to edges ____/
//
// Reproducing the input exactly ("lossless") scores like nearest-neighbour here,
// which is the correct verdict and the one whole-image SSIM at 1x cannot deliver.
//
// WHY THIS EXISTS ALONGSIDE `npm run compare`. That harness scores a tracer
// against its own input, at the input's own resolution, with whole-frame SSIM.
// On flat artwork the boundary is ~4.5% of the pixels and the other 95.5% is
// interior every method gets right, so the number saturates at 1.0000 — and it
// reported exactly that for output which is a bitmap in an SVG container. It is
// the right instrument for "did the conversion lose anything" and the wrong one
// for "is this a vector".
//
// Usage:
//   node scripts/bench-scale.mjs [corpusDir] [--base 256] [--scale 4] [--out report.json]
//
// corpusDir: a directory of ground-truth .svg files. Omit it for the built-in
// synthetic set. Real corpora worth pointing this at: simple-icons, Material
// Symbols, Twemoji — permissively licensed, genuine vector originals.
//
// Rivals: set VECLINE_VTRACER to vtracer's own binary to add its row. potrace is
// a dev dependency and is included automatically when present.

import { mkdir, readFile, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Everything below renders through the project's own renderer and its own resize,
// so the numbers come from the code Vecline actually ships. The original draft of
// this harness used Playwright/Chromium; that made the scores depend on a browser
// build nobody else would have, and added a 300 MB dev dependency to measure a
// library that already contains a renderer.
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { encodeRaster } from '../dist/esm/io/encode.js';
import { editImage } from '../dist/esm/ops.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- configuration

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
// Only a *present* flag consumes the token after it. Deriving this from
// `indexOf` unconditionally reads argv[-1 + 1] = argv[0] for every absent flag,
// which silently swallowed the positional corpus directory and fell back to the
// synthetic set — reporting a full run against a corpus it never opened.
const FLAG_VALUES = new Set(
  ['base', 'scale', 'scales', 'out']
    .map((n) => argv.indexOf(`--${n}`))
    .filter((i) => i !== -1)
    .map((i) => argv[i + 1]),
);
const corpusDir = argv.find((a) => !a.startsWith('--') && !FLAG_VALUES.has(a));
const BASE = Number(flag('base', 256));   // size the vectorizer sees
const OUT = flag('out', 'bench-scale.json');
const WORK = '.bench-scale';

/**
 * Score at two magnifications, one of them NOT a whole number.
 *
 * An integer scale is the one case where this harness is blind. Traced output at
 * the shipped tolerance sits entirely on the pixel lattice — 100% of its
 * coordinates are integers — so rendering it at exactly 4x lands every edge on a
 * pixel boundary and produces no antialiased pixels at all. Every seam, every
 * sub-pixel placement error and every compositing artefact vanishes from the
 * score.
 *
 * That is not hypothetical. At 4.000x this harness reported `trace-default` and
 * `trace + extendUnder` as *byte-identical in rendered output* — 0 differing
 * subpixel channels out of 4,194,304. At 3.902x the same two differ by 0.96 dB.
 * A benchmark that cannot separate two configurations a whole decibel apart is
 * not measuring the thing it claims to.
 *
 * 3.902 rather than 3.9 because a scale with a short decimal expansion still
 * lands suspiciously many edges on pixel boundaries; this one is deliberately
 * awkward. Both scales are reported, because 4x is the reproducible headline and
 * the non-integer one is where the truth about edges lives.
 */
const SCALES = (flag('scales', '4,3.902')).split(',').map(Number).filter((n) => n > 0);
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

// Candidate configurations. The harness is indifferent to what produced an SVG,
// so rivals go in the same table through `external`.
const CANDIDATES = [
  { id: 'auto', opts: {} },
  { id: 'trace-default', opts: { mode: 'trace' } },
  { id: 'trace-tol1.2', opts: { mode: 'trace', trace: { tolerance: 1.2 } } },
  { id: 'trace-tol2', opts: { mode: 'trace', trace: { tolerance: 2 } } },
  // Sub-pixel refinement, at the shipped tolerance and at values where the
  // fitter can actually engage once its input is no longer a staircase.
  { id: 'sub-default', opts: { mode: 'trace', trace: { subpixel: true } } },
  { id: 'sub-tol1.2', opts: { mode: 'trace', trace: { subpixel: true, tolerance: 1.2 } } },
  { id: 'sub-tol2', opts: { mode: 'trace', trace: { subpixel: true, tolerance: 2 } } },
  // The PRESETS, which are what a user actually types and what Phases 2-5 were
  // tuned on -- and which this harness could not see until now. That blindness
  // mattered: `logo` couples tolerance 0.6 with subpixel refinement, a
  // combination none of the rows above reproduce, and it is the only
  // configuration that emits curves on a real logo at all.
  //
  // Judged at 1x a preset can look worse while being better, which is the whole
  // reason this harness scores at magnification. Measured on vector-tiger before
  // these rows existed: default 0.8458 SSIM at 1x against logo's 0.7757, and at
  // 3.902x that reverses to 0.7615 against 0.7833. A gate that cannot see the
  // presets cannot see that reversal.
  //
  // AND THEN THE CORPUS REVERSED IT AGAIN, which is worth recording here because
  // the first run of these rows produced a confident wrong answer. On the
  // built-in synthetic set at 3.902x, preset-lineart reads 19.05 dB on 259
  // anchors against auto's 18.38 dB on 3,939 -- strict domination on every axis.
  // Point the same harness at corpus/src, four REAL vector originals, and it
  // inverts: auto 17.17 dB on 2,897 anchors, preset-lineart 15.34 dB on 2,126.
  // auto goes from dominated to the best point on the frontier.
  //
  // The cause is in the fixtures below: they were built to have the features
  // vectorizers get wrong -- long straight diagonals, tight corners -- and those
  // reward a preset that simplifies hard (tolerance 0.6 + subpixel). Real artwork
  // is mostly texture and small regions, where the same simplification loses.
  // Run `npm run bench:scale -- corpus/src` before believing any ranking these
  // built-in shapes produce.
  //
  // AND THEN IT REVERSED A THIRD TIME. Four shapes is not a sample either. On
  // 300 real logos (simple-icons, CC0, each framed as a dark mark on an opaque
  // ground) at 3.902x, auto falls from "the best point on the frontier" to
  // 14.94 dB on 6,336 anchors -- below trace-default's 15.29 dB on 5,923, so it
  // is beaten on both axes at once by the thing it is choosing between. At 4x
  // the two are tied at 15.40, which is the tell: the gap exists only off the
  // pixel lattice, the signature of a decision routing artwork to pixel mode.
  //
  // Read that as a property of corpus size, not of any one corpus. The same
  // question -- is auto dominated? -- answered no, then yes, then no again as
  // the sample went 8 synthetic -> 4 real -> 300 real. Nothing below is a
  // ranking until it has been re-run on a corpus large enough to have a middle.
  //
  // The finding that survived all three: on 300 real logos, `trace-default` and
  // `auto` emit ZERO curve commands. Verified exactly rather than from these
  // rounded per-shape averages -- 0 curve commands across 40 of 40 logos, while
  // preset-logo emits 5,350 in the same 40 using 13.8x fewer anchors (17,047
  // against 234,766). The plan these phases came from opens by saying the
  // default path emits no curves on a normal logo. It still does not.
  //
  // Note what this corpus CANNOT see: simple-icons are two-colour, so shared
  // boundaries, seams, extendUnder, palette selection and gradients are all
  // untested by it, and it is potrace's ideal case -- which is why potrace leads
  // the frontier here at 61.6 dB per thousand anchors against sub-default's 3.1.
  // No row enables `primitives`, so these numbers say nothing about Phase 5.
  { id: 'preset-logo', opts: { mode: 'trace', preset: 'logo' } },
  { id: 'preset-lineart', opts: { mode: 'trace', preset: 'lineart' } },
  { id: 'preset-poster', opts: { mode: 'trace', preset: 'poster' } },
  { id: 'preset-detailed', opts: { mode: 'trace', preset: 'detailed' } },
];

// ------------------------------------------------------------------- rendering

/** Render an SVG at an exact pixel width, over white. Returns a RasterImage. */
async function render(svg, size) {
  // resvg fits one axis and keeps the aspect ratio. Every fixture here is square
  // and a candidate inherits the input's dimensions, so truth and candidate come
  // out the same size — which the comparison asserts rather than assumes.
  // Rounded, because a non-integer scale gives a fractional target: 256 * 3.902
  // is 998.912, and resvg wants whole pixels.
  const { image } = await rasterizeSvg(svg, { width: Math.round(size), background: WHITE });
  return image;
}

/** The vectorizer's input: the ground truth, rasterised small. */
async function renderToPng(svg, size) {
  const image = await render(svg, size);
  return encodeRaster(image, { format: 'png' });
}

/**
 * Smooth upscale of the input bitmap — the accuracy ceiling.
 *
 * Not a competitor: it spends no anchors, so it is disqualified by construction
 * and serves as the number to approach. `fit: 'fill'` because the target is a
 * known exact size, and lanczos3 is what `vecline edit --resize` uses, so the
 * ceiling is measured with the project's own resampler.
 */
async function upscale(image, width, height) {
  // Sized from the truth render rather than from BASE * SCALE. resvg fits one
  // axis and keeps the aspect ratio, so a non-square original renders 1024x655
  // while a forced square upscale produced 1024x1024 — the comparison then
  // failed its own size assertion instead of quietly scoring misaligned pixels.
  return editImage(image, {
    resize: { width, height, fit: 'fill', kernel: 'lanczos3' },
  });
}

// --------------------------------------------------------------------- metrics

/** Sobel magnitude of luma, used to find where the shape boundaries are. */
function edgeMask(img, threshold = 40, dilate = 6) {
  const { data, width: w, height: h } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (data[p] + data[p + 1] + data[p + 2]) / 3;
  }
  const mask = new Uint8Array(w * h);
  const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      if (Math.hypot(gx, gy) > threshold) mask[y * w + x] = 1;
    }
  }
  return dilateMask(mask, w, h, dilate);
}

function dilateMask(mask, w, h, iterations) {
  let cur = mask;
  for (let n = 0; n < iterations; n++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (
          cur[y * w + x] ||
          (x > 0 && cur[y * w + x - 1]) ||
          (x < w - 1 && cur[y * w + x + 1]) ||
          (y > 0 && cur[(y - 1) * w + x]) ||
          (y < h - 1 && cur[(y + 1) * w + x])
        ) next[y * w + x] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Anchor count — the axis that actually separates vectorizers.
 *
 * Accuracy alone cannot score one: a smooth upscale of the input beats every
 * tracer on any raster-fidelity metric, at every magnification, because
 * reconstructing a smooth edge from a well-anti-aliased sample is easy and
 * carries no obligation to be compact or editable. So score the pair — accuracy,
 * and the anchors spent reaching it — and rank on the frontier, not either axis
 * alone.
 */
function countAnchors(svg) {
  const d = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).join(' ');
  return {
    anchors: (d.match(/[MmLlHhVvCcSsQqTtAa]/g) ?? []).length,
    elements: (svg.match(/<(path|rect|circle|ellipse|polygon|line)\b/g) ?? []).length,
    primitives: (svg.match(/<(rect|circle|ellipse|line|polygon)\b/g) ?? []).length,
    curveOps: (d.match(/[CcSsQqTtAa]/g) ?? []).length,
  };
}

/**
 * Fidelity of `cand` against `truth`, over the whole frame and the edge band.
 *
 * The split matters. On typical artwork the boundary is ~5% of pixels and the
 * flat interior is the rest, so a whole-frame number is ~95% consensus about
 * regions every method gets right. It saturates near 1.0 and hides the only part
 * of the image the vectorizer actually decided anything about.
 */
/**
 * Bring `img` to exactly `w` x `h`, tolerating only a rounding-scale difference.
 *
 * A non-square original cannot round-trip its aspect ratio exactly: a 1024x655
 * truth is rasterised to 256x164 for the vectorizer (655/4 = 163.75, rounded up),
 * and the candidate inherits those dimensions, so 4x gives 656 rows against the
 * truth's 655.
 *
 * This used to *crop* the extra row while the ceiling reference was *resampled*
 * onto the truth's exact dimensions — so on non-square input the two were not
 * being treated alike, and a candidate was compared against a truth it had been
 * shifted relative to. Both are resampled now, with the project's own resampler,
 * which is the only way the comparison is like-for-like.
 *
 * A discrepancy larger than aspect rounding could produce is still an error
 * rather than a silent squash of real content.
 */
async function conform(img, w, h, scale) {
  if (img.width === w && img.height === h) return img;
  const slack = Math.ceil(scale);
  if (Math.abs(img.width - w) > slack || Math.abs(img.height - h) > slack) {
    throw new Error(
      `size mismatch beyond rounding: got ${img.width}x${img.height}, expected ` +
        `${w}x${h}. A difference this large means the aspect ratios genuinely ` +
        `differ, and comparing them would score misaligned pixels.`,
    );
  }
  return upscale(img, w, h);
}

/**
 * Fraction of the truth's detailed regions where the candidate still has detail.
 *
 * Every other number here can be improved by deleting the subject. Edge-PSNR is
 * averaged over the edge band, so removing a feature removes the pixels that
 * were scoring badly; anchors and bytes fall outright. Measured on a real image,
 * `--preset logo` won on all three at once by dropping `minArea: 8` over a
 * 100x100 sticker — which erased the dog's face. Nothing in this harness
 * objected, because there was less picture left to be wrong about.
 *
 * So this asks a different question: where the original has structure, is there
 * still structure? Grid the frame, mark the cells where the truth carries edges,
 * and check the candidate carries some there too. A config that simplifies
 * honestly keeps the cells and moves the edges slightly; a config that deletes
 * features empties them.
 *
 * Deliberately generous — a cell survives on a quarter of the truth's edge
 * energy. This is a tripwire for destruction, not a quality score, and it must
 * not fire on legitimate simplification.
 */
function detailKept(truth, cand, cell = 16) {
  const w = truth.width, h = truth.height;
  // Undilated: dilation smears energy across cell borders and would let a
  // neighbouring cell's edges stand in for a deleted feature.
  const tm = edgeMask(truth, 40, 0);
  const cm = edgeMask(cand, 40, 0);
  let detailed = 0, survived = 0;
  for (let cy = 0; cy < h; cy += cell) {
    for (let cx = 0; cx < w; cx += cell) {
      let t = 0, c = 0;
      for (let y = cy; y < Math.min(cy + cell, h); y++) {
        for (let x = cx; x < Math.min(cx + cell, w); x++) {
          if (tm[y * w + x]) t++;
          if (cm[y * w + x]) c++;
        }
      }
      // Ignore near-empty cells: a couple of stray pixels is not "detail", and
      // counting them would make the ratio noise.
      if (t < 4) continue;
      detailed++;
      if (c >= t * 0.25) survived++;
    }
  }
  return detailed === 0 ? 1 : survived / detailed;
}

function compare(truth, cand, mask) {
  if (truth.width !== cand.width || truth.height !== cand.height) {
    throw new Error(
      `size mismatch: truth ${truth.width}x${truth.height} vs candidate ` +
        `${cand.width}x${cand.height}. Both must render at the same size or the ` +
        `comparison is meaningless.`,
    );
  }
  let seFull = 0, seEdge = 0, aeEdge = 0, nEdge = 0;
  const n = truth.width * truth.height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let se = 0, ae = 0;
    for (let c = 0; c < 3; c++) {
      const d = truth.data[p + c] - cand.data[p + c];
      se += d * d; ae += Math.abs(d);
    }
    se /= 3; ae /= 3;
    seFull += se;
    if (mask[i]) { seEdge += se; aeEdge += ae; nEdge++; }
  }
  const psnr = (mse) => 10 * Math.log10((255 * 255) / Math.max(mse, 1e-9));
  return {
    fullPsnr: psnr(seFull / n),
    edgePsnr: psnr(seEdge / Math.max(nEdge, 1)),
    edgeMae: aeEdge / Math.max(nEdge, 1),
    edgeFraction: nEdge / n,
    detailKept: detailKept(truth, cand),
  };
}

// ----------------------------------------------------------------- competitors

/**
 * vtracer's own released binary, when pointed at.
 *
 * Deliberately not the `@neplex/vectorizer` napi binding: it produces
 * substantially larger files at the same quality, so measuring through it
 * understates vtracer and flatters us. Defaults and nothing else — every entrant
 * is scored at its out-of-the-box behaviour.
 */
const vtracerBin = process.env.VECLINE_VTRACER && existsSync(process.env.VECLINE_VTRACER)
  ? process.env.VECLINE_VTRACER
  : null;

async function runVtracer(pngPath) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-vtracer-'));
  try {
    const out = path.join(dir, 'out.svg');
    await execFileAsync(vtracerBin, ['--input', pngPath, '--output', out]);
    return await readFile(out, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** potrace, posterised so it can answer a colour fixture at all. */
let potrace = null;
try {
  potrace = (await import('potrace')).default;
} catch {
  // Dev dependency; the row is simply absent rather than guessed at.
}

function runPotrace(pngBuffer) {
  return new Promise((resolve, reject) => {
    // potrace is bilevel by design. `posterize` is a bolt-on, and reporting it
    // without saying so would be a rigged fight — the row is labelled.
    potrace.posterize(pngBuffer, { steps: 4 }, (err, svg) => (err ? reject(err) : resolve(svg)));
  });
}

const EXTERNALS = [
  ...(vtracerBin ? [{ id: 'vtracer (defaults)', run: (png, buf) => runVtracer(png) }] : []),
  ...(potrace ? [{ id: 'potrace posterize', run: (png, buf) => runPotrace(buf) }] : []),
];

// ----------------------------------------------------------------- test corpus

/** Shapes with exactly the features vectorizers get wrong: a long straight
 *  diagonal, a large smooth arc, a tight concave corner, a thin stroke. */
const SYNTHETIC = {
  'diagonal-wedge': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><circle cx="128" cy="128" r="96" fill="#1e5ac8"/><path d="M60 200 128 80 196 200Z" fill="#dc3246"/><rect x="110" y="110" width="36" height="86" fill="#ffd228"/></svg>`,
  'smooth-arc': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><path d="M32 208a96 96 0 0 1 192 0Z" fill="#0f766e"/><circle cx="128" cy="120" r="34" fill="#fbbf24"/></svg>`,
  'thin-stroke': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><path d="M40 128q44-72 88 0t88 0" fill="none" stroke="#111827" stroke-width="3"/><path d="M40 176q44-72 88 0t88 0" fill="none" stroke="#b91c1c" stroke-width="6"/></svg>`,
  'concave-corner': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><path d="M128 24 158 98l80 6-61 52 19 78-68-42-68 42 19-78-61-52 80-6Z" fill="#4338ca"/></svg>`,
};

async function loadCorpus() {
  if (corpusDir && existsSync(corpusDir)) {
    const files = (await readdir(corpusDir)).filter((f) => f.endsWith('.svg'));
    return Object.fromEntries(
      await Promise.all(files.map(async (f) => [
        path.basename(f, '.svg'),
        await readFile(path.join(corpusDir, f), 'utf8'),
      ])),
    );
  }
  return SYNTHETIC;
}

// ------------------------------------------------------------------------ main

async function main() {
  await mkdir(WORK, { recursive: true });
  const corpus = await loadCorpus();
  const names = Object.keys(corpus);
  console.log(
    `corpus: ${names.length} shape(s) | input ${BASE}px | scored at ` +
    SCALES.map((k) => `${Math.round(BASE * k)}px (${k}x)`).join(' and ') +
    `\nrivals: ${EXTERNALS.length ? EXTERNALS.map((e) => e.id).join(', ') : 'none available'}\n`,
  );

  // One accumulator per scale. Averaging across magnifications would hide exactly
  // the difference this is here to expose.
  const totals = new Map(SCALES.map((k) => [k, new Map()]));
  const report = [];

  function record(scale, shape, id, m, bytes, mode) {
    report.push({ scale, shape, id, mode, bytes, ...m });
    const per = totals.get(scale);
    const t = per.get(id) ?? { edge: 0, full: 0, detail: 0, anchors: 0, elements: 0, primitives: 0, curveOps: 0, bytes: 0, n: 0 };
    t.edge += m.edgePsnr; t.full += m.fullPsnr; t.detail += m.detailKept ?? 1;
    t.anchors += m.anchors ?? 0; t.elements += m.elements ?? 0;
    t.primitives += m.primitives ?? 0; t.curveOps += m.curveOps ?? 0;
    t.bytes += bytes; t.n++;
    per.set(id, t);
  }

  for (const name of names) {
    const source = corpus[name];

    // Vectorise once. What the tracer sees does not depend on the magnification
    // its result is scored at, and producing it per scale would only invite the
    // two runs to disagree about what was measured.
    const smallPng = await renderToPng(source, BASE);
    const inputPath = path.join(WORK, `${name}.${BASE}.png`);
    await writeFile(inputPath, smallPng);
    const small = await render(source, BASE);
    const loaded = await loadRaster(inputPath);

    const produced = [];
    for (const cand of CANDIDATES) {
      try {
        const out = await vectorize(loaded, cand.opts);
        produced.push({ id: cand.id, svg: out.svg, mode: out.mode });
        await writeFile(path.join(WORK, `${name}.${cand.id}.svg`), out.svg);
      } catch (e) { console.log(`  ${name}/${cand.id}: ERROR ${e.message}`); }
    }
    for (const ext of EXTERNALS) {
      try {
        const svg = await ext.run(inputPath, smallPng);
        produced.push({ id: ext.id, svg });
        await writeFile(path.join(WORK, `${name}.${ext.id.replace(/[^\w.-]+/g, '_')}.svg`), svg);
      } catch (e) { console.log(`  ${name}/${ext.id}: ERROR ${e.message}`); }
    }

    for (const scale of SCALES) {
      const big = Math.round(BASE * scale);
      const truth = await render(source, big);
      const mask = edgeMask(truth);

      record(scale, name, 'ceiling:smooth-upscale',
        compare(truth, await upscale(small, truth.width, truth.height), mask), smallPng.length);

      for (const item of produced) {
        const rendered = await conform(await render(item.svg, big), truth.width, truth.height, scale);
        record(scale, name, item.id, { ...compare(truth, rendered, mask), ...countAnchors(item.svg) },
          Buffer.byteLength(item.svg), item.mode);
      }
    }
  }

  const h = (str, w) => String(str).padStart(w);
  const allRows = {};
  for (const scale of SCALES) {
    const rows = [...totals.get(scale).entries()]
      .map(([id, t]) => ({
        id,
        edge: t.edge / t.n,
        detail: t.detail / t.n,
        full: t.full / t.n,
        anchors: Math.round(t.anchors / t.n),
        elements: Math.round(t.elements / t.n),
        primitives: Math.round(t.primitives / t.n),
        curveOps: Math.round(t.curveOps / t.n),
        bytes: Math.round(t.bytes / t.n),
      }))
      // Frontier rank: accuracy earned per anchor spent. The ceiling has no
      // anchors, so it sorts last here by construction — that is intended.
      .sort((a, b) => (b.edge / Math.max(b.anchors, 1)) - (a.edge / Math.max(a.anchors, 1)));
    allRows[scale] = rows;

    const note = Number.isInteger(scale)
      ? '  <- integer: blind to edges, see the note below'
      : '  <- non-integer: this is where edges are actually tested';
    console.log(`\n=== scored at ${Math.round(BASE * scale)}px (${scale}x)${note} ===`);
    console.log(
      'candidate'.padEnd(24) + h('edgePSNR', 10) + h('fullPSNR', 10) +
      h('detail', 8) + h('anchors', 9) + h('curves', 8) + h('elems', 7) + h('prims', 7) + h('bytes', 9),
    );
    for (const r of rows) {
      console.log(
        r.id.padEnd(24) + h(r.edge.toFixed(2), 10) + h(r.full.toFixed(2), 10) +
        // Flagged, not just printed. A row that kept under 90% of the truth's
        // detailed cells improved its other numbers by deleting the subject, and
        // that must not read as a win in a table skimmed for the best figures.
        h(`${(r.detail * 100).toFixed(0)}%${r.detail < 0.9 ? '!' : ''}`, 8) +
        h(r.anchors || '-', 9) + h(r.curveOps || '-', 8) +
        h(r.elements || '-', 7) + h(r.primitives || '-', 7) + h(r.bytes, 9),
      );
    }
  }

  // Named, after the table, so it cannot be skimmed past.
  const wrecked = [...new Set(
    [...totals.values()]
      .flatMap((per) => [...per.entries()])
      .filter(([, t]) => t.n > 0 && t.detail / t.n < 0.9)
      .map(([id, t]) => `${id} (${((t.detail / t.n) * 100).toFixed(0)}%)`),
  )];
  if (wrecked.length > 0) {
    console.log(
      `\n!! DETAIL LOST: ${wrecked.join(', ')}` +
      `\n   These kept under 90% of the cells where the original has structure.` +
      `\n   Every other column here can be improved by deleting the subject: edge` +
      `\n   PSNR averages over the edge band, so removing a feature removes the` +
      `\n   pixels that were scoring badly, and anchors and bytes fall outright.` +
      `\n   Measured: --preset logo won on all three at once by erasing a dog's` +
      `\n   face, minArea 8 over a 100x100 sticker. Read a good score with a low` +
      `\n   detail figure as a destroyed image until you have looked at it.`,
    );
  }

  console.log(
    `\nRead this as a frontier, not a ranking. ceiling:smooth-upscale is the accuracy` +
    `\nceiling and spends no anchors — it is not a competitor, it is the number to` +
    `\napproach. A vectorizer wins by getting close to it on edgePSNR while spending` +
    `\nanchors in the order of magnitude the shape actually needs.` +
    `\n\nfullPSNR is printed only to show how little it separates anything: that is the` +
    `\nnumber a 1x whole-frame metric reports, and why this harness exists.` +
    `\n\nTrust the non-integer scale for anything about edges. At a whole-number` +
    `\nmagnification every lattice coordinate lands on a pixel boundary, so traced` +
    `\noutput has no antialiased pixels at all and seams, sub-pixel placement and` +
    `\ncompositing vanish from the score. Measured consequence: this harness once` +
    `\nreported trace-default and trace+extendUnder as render-identical — 0 differing` +
    `\nsubpixel channels of 4,194,304 — when at 3.902x they are 0.96 dB apart.`,
  );

  await writeFile(OUT, JSON.stringify({ base: BASE, scales: SCALES, rows: allRows, detail: report }, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
