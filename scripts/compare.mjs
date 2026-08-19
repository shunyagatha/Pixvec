#!/usr/bin/env node
/**
 * Head-to-head against other vectorizers.
 *
 * The point of this script is that it can embarrass us. Every tool is measured
 * the same way: its SVG is rendered with the *same* renderer and scored with the
 * *same* metrics, so nothing here depends on Vecline's own view of quality.
 *
 * Compared:
 *   potrace         the reference bilevel tracer, via its JavaScript port
 *   potrace/posterize  its multi-level mode, the closest thing it has to colour
 *   imagetracerjs   a widely used colour tracer
 *   vecline          this package
 *
 * potrace is bilevel by design, so it is scored on a black-and-white fixture
 * where the comparison is apples to apples, and posterize is used for colour.
 * Reporting potrace's colour score without that caveat would be a rigged fight.
 *
 *   npm run compare
 *   npm run compare -- --json
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
import { join } from 'node:path';
import sharp from 'sharp';
import potrace from 'potrace';
import imagetracer from 'imagetracerjs';
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { compareImages } from '../dist/esm/metrics/index.js';

const asJson = process.argv.includes('--json');

// vtracer (VisionCortex, Rust) is the strongest modern open-source colour tracer
// and the most relevant rival, so it belongs in this fight. It is an optional
// dev dependency — a native napi binding — so the script degrades gracefully to
// the JS-only field when it is not installed rather than hard-failing.
let vtracer = null;
try {
  const vt = await import('@neplex/vectorizer');
  // vtracer's own documented defaults for colour tracing: a fair fight is the
  // tool at its out-of-the-box settings, the same courtesy imagetracerjs gets.
  const config = {
    colorMode: vt.ColorMode.Color,
    hierarchical: vt.Hierarchical.Stacked,
    mode: vt.PathSimplifyMode.Spline,
    filterSpeckle: 4,
    colorPrecision: 6,
    layerDifference: 16,
    cornerThreshold: 60,
    lengthThreshold: 4,
    spliceThreshold: 45,
    maxIterations: 10,
    pathPrecision: 8,
  };
  vtracer = { vectorize: vt.vectorize, config };
} catch {
  // Not installed; the head-to-head runs without it. Install with:
  //   npm install --no-save @neplex/vectorizer
}

function image(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
function setPixel(img, x, y, r, g, b, a = 255) {
  const o = (y * img.width + x) * 4;
  img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Black-and-white artwork: the case potrace was designed for. */
function bilevelArt(w, h) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2);
      const ring = d < h * 0.18 || (d > h * 0.28 && d < h * 0.42);
      const bar = Math.abs(y - h / 2) < h * 0.06 && x > w * 0.1 && x < w * 0.9;
      const on = ring || bar;
      setPixel(img, x, y, on ? 0 : 255, on ? 0 : 255, on ? 0 : 255);
    }
  }
  return img;
}

function colourArt(w, h) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2);
      if (d < h * 0.2) setPixel(img, x, y, 250, 244, 232);
      else if (d < h * 0.37) setPixel(img, x, y, 214, 69, 65);
      else if (x < w / 3) setPixel(img, x, y, 32, 96, 160);
      else if (x < (2 * w) / 3) setPixel(img, x, y, 250, 244, 232);
      else setPixel(img, x, y, 40, 150, 110);
    }
  }
  return img;
}

function photoLike(w, h, seed = 11) {
  const img = image(w, h);
  const rand = mulberry32(seed);
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1), v = y / (h - 1);
      setPixel(img, x, y,
        clamp(40 + 180 * u + 40 * Math.sin(v * 9) + rand() * 8),
        clamp(30 + 150 * v + 50 * Math.cos(u * 7) + rand() * 8),
        clamp(200 - 120 * u * v + rand() * 8));
    }
  }
  return img;
}

const toPng = (img) =>
  sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toBuffer();

/**
 * A real photograph from the corpus, downscaled so the whole panel of tracers
 * finishes in seconds while keeping the continuous-tone content — skin, sky —
 * that flat-fill tracing struggles with and gradients are meant to fix.
 */
async function loadReal(name, maxWidth = 480) {
  // `corpus/` is gitignored — the fixtures are third-party photographs that are
  // not ours to redistribute — so on a fresh clone this path does not exist and
  // the script used to die on a bare ENOENT with no hint of what was wrong,
  // while the README promised "every number is reproducible with one command".
  // Say what is missing and how to get it instead.
  const path = join('corpus', 'src', name);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing.\n\n` +
      `The comparison runs against real photographs that are not redistributable, so\n` +
      `corpus/ is gitignored and absent from a fresh clone. Populate it with:\n\n` +
      `    node scripts/fetch-corpus.mjs\n\n` +
      `or drop your own images at corpus/src/ under the same names. The synthetic\n` +
      `fixtures need nothing — only the real-photograph rows depend on this.`,
    );
  }

  const { data, info } = await sharp(await readFile(path))
    .resize({ width: maxWidth, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** Score any SVG against the source, using one renderer and one metric set. */
/** Composite an RGBA image over opaque white, so alpha cannot skew a comparison. */
function flattenOnWhite(img) {
  let needed = false;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) { needed = true; break; }
  }
  if (!needed) return img;
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    out.data[i] = Math.round(img.data[i] * a + 255 * (1 - a));
    out.data[i + 1] = Math.round(img.data[i + 1] * a + 255 * (1 - a));
    out.data[i + 2] = Math.round(img.data[i + 2] * a + 255 * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

async function score(source, svg) {
  // Every tool is rendered on the same white ground. potrace emits shapes on a
  // transparent background, so scoring it against an opaque source without this
  // would report ~2 dB and be a rigged fight rather than a comparison.
  const { image: rendered } = await rasterizeSvg(svg, {
    width: source.width,
    background: { r: 255, g: 255, b: 255, a: 255 },
  });
  if (rendered.width !== source.width || rendered.height !== source.height) {
    return { error: `size mismatch ${rendered.width}x${rendered.height}` };
  }
  // Flatten the SOURCE onto the same white ground before comparing.
  //
  // The rendered side is composited over white above; the source was not, so a
  // transparent source pixel was (0,0,0,0) on one side and opaque white on the
  // other. That is white-against-black in every transparent region, and it wrecks
  // PSNR and SSIM while leaving deltaE untouched — which is exactly the
  // self-contradiction that exposed it: adding real logos to this comparison
  // produced `vecline lossless` at SSIM 0.4997 with mean deltaE 0.000, an
  // impossible pair. Every fixture here used to be opaque, so the flaw sat
  // unexercised.
  //
  // Opaque sources are unaffected: compositing an alpha-255 pixel over white
  // returns the pixel.
  const q = compareImages(flattenOnWhite(source), rendered);
  return {
    bytes: Buffer.byteLength(svg),
    psnr: q.psnr,
    ssim: q.ssim,
    deltaE: q.deltaE.mean,
    exact: q.exactRatio,
  };
}

const runPotrace = (file, options) =>
  new Promise((resolve, reject) =>
    potrace.trace(file, options, (err, svg) => (err ? reject(err) : resolve(svg))));

const runPosterize = (file, options) =>
  new Promise((resolve, reject) =>
    potrace.posterize(file, options, (err, svg) => (err ? reject(err) : resolve(svg))));

const dir = await mkdtemp(join(tmpdir(), 'vecline-compare-'));
const results = [];

async function contend(fixtureName, source, entrants) {
  const file = join(dir, `${fixtureName}.png`);
  await writeFile(file, await toPng(source));

  for (const [tool, produce] of entrants) {
    let row = { fixture: fixtureName, tool };
    try {
      const started = Date.now();
      const svg = await produce(file, source);
      row = { ...row, ...(await score(source, svg)), ms: Date.now() - started };
    } catch (err) {
      row.error = String(err.message ?? err).slice(0, 60);
    }
    results.push(row);
  }
}

const veclineTrace = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { mode: 'trace' })).svg;
};
const veclineLossless = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { mode: 'lossless' })).svg;
};
const tracerjs = async (_file, source) =>
  imagetracer.imagedataToSVG(
    { width: source.width, height: source.height, data: Array.from(source.data) },
    { numberofcolors: 16 },
  );
// `mode: 'trace'` with no preset is exactly what `vecline convert photo.png
// out.svg` runs: auto-trace scales the palette to the content, so this row is
// the honest zero-config default a user actually gets.
const veclinePhotoPreset = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { mode: 'trace', preset: 'photo', trace: { gradients: true } })).svg;
};
/**
 * `--preset logo`, which is what someone tracing a logo actually types.
 *
 * Worth its own row rather than folding into `vecline trace`, because a preset now
 * overrides the mode decision. Until v2.1 it did not: naming any tracing preset
 * produced output byte-identical to `auto`, so on a flat logo this row would have
 * silently measured an exact copy rather than a trace.
 */
const veclineLogoPreset = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, { preset: 'logo' })).svg;
};
/** The true zero-config default: whatever `vecline convert in.png out.svg` picks. */
const veclineAuto = async (_file, source) => {
  const input = await loadRaster(await toPng(source));
  return (await vectorize(input, {})).svg;
};
const vtracerRun = async (_file, source) => vtracer.vectorize(await toPng(source), vtracer.config);

/**
 * vtracer via its own released CLI binary.
 *
 * The npm route above (`@neplex/vectorizer`) is a third-party binding. When the
 * real `vtracer` executable is available it is the more authoritative entrant —
 * it is the artefact vtracer's authors actually ship, at its documented
 * defaults, so a loss to it is a loss to vtracer rather than to someone's
 * wrapper. Point `VECLINE_VTRACER` at the binary to enable this row.
 */
const vtracerBin = process.env.VECLINE_VTRACER && existsSync(process.env.VECLINE_VTRACER)
  ? process.env.VECLINE_VTRACER
  : null;

/**
 * A paid hosted vectoriser, entered from pre-generated files rather than run.
 *
 * It has no CLI and no free API, so its row cannot be produced on demand the way
 * vtracer's is. Point `VECLINE_RIVAL_SVG` at a directory of `<subject>.svg` files
 * generated from the same corpus sources and they are scored beside everything
 * else. The files are deliberately NOT committed — they are someone else's paid
 * output, and this repository is MIT.
 *
 * Measured on logo-tux, which is the case that matters most and the one where the
 * frontier is clearest:
 *
 *   entrant                bytes    gzip   curves    SSIM
 *   the paid tool          54,217  11,936     551   0.9483
 *   vecline auto          107,889  18,862      12   0.9913
 *   vecline preset logo    54,471  19,638   1,082   0.8747
 *   vecline logo +reg 6    22,370   8,872     165   0.8586
 *
 * Read honestly, that says WE DO NOT HOLD THE BETTER FRONTIER POINT ON FLAT ART.
 * At matched raw size we are 0.07 SSIM behind; going 2.4x smaller costs 0.09. Only
 * `auto` scores higher, and it does so by reproducing antialiased pixels rather
 * than describing shapes — 12 curve segments against 551, and visibly jagged when
 * rendered. A high score there is the metric rewarding faithfulness to a raster.
 *
 * Across the wider nine-subject set the split is by content: we lead SSIM on 6 of
 * 9 and they lead bytes on 6 of 9, but our curve counts are 11-24 against their
 * 551-28,403 throughout. On photographs the two are visually comparable. On flat
 * art they are not, and the reason is that we are still emitting staircases.
 *
 * The caution that goes with those SSIM wins: on `photo-jpeg-artifacts` we score
 * 0.9441 to their 0.7642 BECAUSE we reproduce the JPEG artefacts they remove. That
 * is a metric rewarding the reproduction of damage, and it should never be quoted
 * as a quality win. `logo-tux` is a clean source, which is why its numbers above
 * are the ones worth trusting.
 */
const rivalSvgDir = process.env.VECLINE_RIVAL_SVG && existsSync(process.env.VECLINE_RIVAL_SVG)
  ? process.env.VECLINE_RIVAL_SVG
  : null;

const vtracerCli = async (_file, source) => {
  const dir = await mkdtemp(join(tmpdir(), 'vecline-vtracer-'));
  try {
    const png = join(dir, 'in.png');
    const svg = join(dir, 'out.svg');
    await writeFile(png, await toPng(source));
    // Defaults, and nothing else. vtracer's default clustering is already
    // colour, so naming it adds nothing — and `--colormode` does not exist in
    // 1.0.0-alpha.3 at all, which failed every row until the harness surfaced
    // it. Passing no tuning is also the fair comparison: every other entrant is
    // scored at its own out-of-the-box behaviour.
    await execFileAsync(vtracerBin, ['--input', png, '--output', svg]);
    return await readFile(svg, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Entrants supplied from the command line, so a rival tracer can be measured
 * without editing this file.
 *
 *   npm run compare -- --tool 'mytracer=/path/to/bin --in {in} --out {out}'
 *
 * `{in}` receives a PNG and `{out}` is where the SVG is expected. Repeatable.
 *
 * This exists because the harness was tool-agnostic in its scoring and closed
 * in its entrant list: `score()` has always taken any SVG from any producer and
 * rendered it on the same white ground with the same metrics, but the list of
 * competitors was hard-coded, so "run it yourself" meant "fork it yourself".
 *
 * The provenance line is not decoration. A comparison table is a claim about
 * someone else's software, and the exact command that produced each row is the
 * difference between a result and an assertion — the same reason the absent
 * vtracer row prints a warning rather than quietly leaving vecline unopposed.
 */
const externalTools = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--tool') continue;
  const spec = process.argv[i + 1];
  const eq = spec ? spec.indexOf('=') : -1;
  if (eq <= 0) {
    console.error("--tool expects 'name=command {in} {out}'");
    process.exit(1);
  }
  const name = spec.slice(0, eq).trim();
  const template = spec.slice(eq + 1).trim();
  if (!template.includes('{in}') || !template.includes('{out}')) {
    console.error(`--tool ${name}: the command must contain both {in} and {out}`);
    process.exit(1);
  }
  // Quote-aware, because a naive whitespace split turns
  // "F:/Open Source Tool/tracer.mjs" into three arguments — and this repo's own
  // path has a space in it, so that is the normal case rather than the exotic
  // one. Single and double quotes both group; everything else splits.
  const parts = (template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((p) => (/^".*"$|^'.*'$/.test(p) ? p.slice(1, -1) : p));
  const run = async (_file, source) => {
    const dir = await mkdtemp(join(tmpdir(), 'vecline-tool-'));
    try {
      const png = join(dir, 'in.png');
      const svg = join(dir, 'out.svg');
      await writeFile(png, await toPng(source));
      const argv = parts.map((p) => p.replace('{in}', png).replace('{out}', svg));
      await execFileAsync(argv[0], argv.slice(1));
      return await readFile(svg, 'utf8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  externalTools.push([name, run, template]);
}
if (externalTools.length > 0) {
  console.log('External entrants, with the exact command used:');
  for (const [name, , template] of externalTools) console.log(`  ${name}: ${template}`);
  console.log();
}
const withExternal = (entrants) => [...entrants, ...externalTools.map(([n, r]) => [n, r])];

// vtracer only makes sense in colour, so it joins the colour and photo panels.
const withVtracer = (entrants) => {
  // Prefer the real released binary; fall back to the npm binding; otherwise
  // the row is simply absent rather than guessed at.
  if (vtracerBin) return [...entrants, ['vtracer (cli)', vtracerCli]];
  if (vtracer) return [...entrants, ['vtracer', vtracerRun]];
  return entrants;
};

// The colour/photo panel: every colour tracer, plus vecline's flat trace, its
// gradient-enabled trace, and its lossless fallback.
const colourPanel = withExternal(withVtracer([
  ['potrace posterize', (file) => runPosterize(file, { steps: 4 })],
  ['imagetracerjs', tracerjs],
  ['vecline (auto)', veclineTrace],
  ['vecline photo', veclinePhotoPreset],
  ['vecline lossless', veclineLossless],
]));

try {
  await contend('bilevel', bilevelArt(160, 120), withExternal([
    ['potrace', (file) => runPotrace(file, { threshold: 128 })],
    ['imagetracerjs', tracerjs],
    ['vecline trace', veclineTrace],
    ['vecline lossless', veclineLossless],
  ]));

  await contend('colour art', colourArt(160, 120), colourPanel);
  await contend('photo (synthetic)', photoLike(120, 90), colourPanel);

  // Real flat artwork, not only the two synthetic fixtures above.
  //
  // The flat-art claim in the README rested on `bilevel` and `colour art`, both
  // generated here, for far too long. Real logos behave differently and worse for
  // us in one direction — `--preset logo` is 15-19 dB more accurate than vtracer
  // and imagetracerjs and 1.2-1.6x larger — and a comparison table that cannot
  // show that is not doing its job. `logo` rather than `trace` because that is
  // what someone tracing a logo would actually type.
  const realArt = [
    ['logo-tux (real logo)', 'logo-tux.png'],
    ['alpha-dice (real, alpha)', 'alpha-dice.png'],
  ];
  for (const [label, file] of realArt) {
    await contend(label, await loadReal(file), withExternal(withVtracer([
      ['potrace posterize', (file) => runPotrace(file, { posterize: true })],
      ['imagetracerjs', tracerjs],
      ['vecline preset logo', veclineLogoPreset],
      ['vecline (auto)', veclineAuto],
      ['vecline lossless', veclineLossless],
    ])));
  }

  // The real test: actual photographs — skin tones and sky gradients — where
  // flat-fill tracing shows its worst and where gradients should earn their keep.
  const realPhotos = [
    ['kodak-portrait', 'photo-portrait.png'],
    ['kodak-lighthouse', 'photo-lighthouse.png'],
    ['kodak-parrots', 'photo-parrots.png'],
  ];
  for (const [label, file] of realPhotos) {
    await contend(label, await loadReal(file), colourPanel);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(results, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v, 2));
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  let current = '';

  // Say when the strongest rival is missing, rather than printing a table that
  // quietly lacks it.
  //
  // vtracer is an optional entrant, so a machine without it produced a table
  // with no vtracer row and nothing to explain the absence — which reads as
  // "vtracer was compared and lost" to anyone who does not already know it is
  // optional. The README's table has vtracer rows in it, so running the very
  // command the README says reproduces those numbers gave a visibly different
  // and more flattering result.
  if (vtracerBin) {
    console.log(`> vtracer: measured via the released binary at ${vtracerBin}.\n`);
  } else if (vtracer) {
    console.log(
      '> vtracer: measured via the `@neplex/vectorizer` napi binding, NOT vtracer\'s own\n' +
      '> binary. The binding produces substantially larger files at the same quality\n' +
      '> (1661 KB where the binary produced 987 KB), so these rows are not comparable\n' +
      '> with the README\'s. Set VECLINE_VTRACER=/path/to/vtracer to score the real tool.\n',
    );
  } else {
    console.log(
      '> vtracer is NOT in this run. It is the strongest open-source colour tracer and\n' +
      '> it beats Vecline on some fixtures, so a table without it flatters Vecline.\n' +
      '> To include it, either point VECLINE_VTRACER at vtracer\'s released binary\n' +
      '> (https://github.com/visioncortex/vtracer/releases — authoritative), or run\n' +
      '> `npm install --no-save @neplex/vectorizer` (a binding, and less comparable).\n',
    );
  }

  console.log('| Fixture | Tool | Size | PSNR | SSIM | Mean ΔE₀₀ | Time |');
  console.log('|---|---|--:|--:|--:|--:|--:|');
  for (const r of results) {
    const fixture = r.fixture === current ? '' : r.fixture;
    current = r.fixture;
    if (r.error) {
      console.log(`| ${fixture} | ${r.tool} | — | — | — | — | ${r.error} |`);
      continue;
    }
    console.log(
      `| ${fixture} | ${r.tool} | ${kb(r.bytes)} | ` +
      `${Number.isFinite(r.psnr) ? `${r.psnr.toFixed(2)} dB` : '∞'} | ` +
      `${r.ssim.toFixed(4)} | ${r.deltaE.toFixed(3)} | ${r.ms} ms |`,
    );
  }
}
