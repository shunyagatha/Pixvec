#!/usr/bin/env node
/**
 * Format regression sweep — does every advertised input format survive the CLI?
 *
 * This exists because of how the last format audit failed. Nine formats lost
 * data, and **every one of them exited 0 with a cheerful message**: `gif -> gif`
 * kept 1 of 36 frames, TGA colormap8-RLE wrote an *empty* SVG labelled "bit-exact
 * by construction", TGA rgb32-RLE-topright invented transparency on all but 1 of
 * 39,601 pixels, a multi-size ICO came back fully opaque. A suite that checks
 * exit codes would have caught none of them. So each case here asserts what the
 * output actually *contains*, and what it looks like when rendered.
 *
 * The inputs are written by **ffmpeg**, deliberately. Round-tripping our own
 * encoders through our own decoders hides any bug the two share — which is the
 * failure mode that let a TGA writer and a TGA reader agree with each other and
 * both be wrong. ffmpeg has no code in common with libvips or with `io/formats`.
 *
 *   node scripts/format-sweep.mjs [--keep] [--filter <substring>]
 *
 * Nothing is committed: the matrix is generated into `corpus/formats/`, which is
 * gitignored, and removed afterwards unless `--keep` is passed.
 */
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
const OUT = 'corpus/formats';
const CLI = 'dist/esm/cli.js';
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const FILTER = argv[argv.indexOf('--filter') + 1] ?? null;

/** ffmpeg is not on PATH in most setups; look where winget puts it too. */
function findFfmpeg() {
  if (process.env.VECLINE_FFMPEG) return process.env.VECLINE_FFMPEG;
  const home = process.env.LOCALAPPDATA ?? process.env.HOME ?? '';
  const guesses = [
    'ffmpeg',
    path.join(home, 'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe'),
  ];
  for (const g of guesses) {
    if (g === 'ffmpeg' || existsSync(g)) return g;
  }
  return null;
}

const FFMPEG = findFfmpeg();

async function ffmpeg(args) {
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
}

// ---------------------------------------------------------------- the sources

/**
 * A flat still, sized 64x48 rather than square: a transposed width and height
 * still produces a plausible-looking image on a square canvas, so a square
 * fixture cannot see that class of bug at all.
 */
function stillPng() {
  const W = 64, H = 48;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      let r = 240, g = 240, b = 240;                       // ground
      if (x >= 8 && x < 30 && y >= 8 && y < 26) { r = 20; g = 40; b = 160; }   // block
      if (x >= 36 && x < 56 && y >= 20 && y < 40) { r = 200; g = 30; b = 60; } // block
      if (x === y + 4) { r = 10; g = 10; b = 10; }         // 1px diagonal
      px[o] = r; px[o + 1] = g; px[o + 2] = b;
    }
  }
  return { W, H, px };
}

/** Six frames, so "kept 1 of N" is unmistakable in the count. */
const FRAMES = 6;

async function writeSources(dir) {
  const { W, H, px } = stillPng();
  await writeFile(path.join(dir, 'still.rgb'), px);
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`,
    '-i', path.join(dir, 'still.rgb'), path.join(dir, '_still.png')]);

  // Animation: a square that moves, so frames are distinguishable by content
  // and not only by count.
  const AW = 32, AH = 32;
  const frames = Buffer.alloc(AW * AH * 3 * FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const o = (f * AW * AH + y * AW + x) * 3;
        const inSquare = x >= f * 4 && x < f * 4 + 8 && y >= 12 && y < 20;
        frames[o] = inSquare ? 230 : 25;
        frames[o + 1] = inSquare ? 60 : 25;
        frames[o + 2] = inSquare ? 90 : 25;
      }
    }
  }
  await writeFile(path.join(dir, 'anim.rgb'), frames);
  return { W, H, AW, AH };
}

// ---------------------------------------------------------------- the matrix

/**
 * `still` cases assert a single image survives; `anim` cases assert every frame
 * does. `expectFrames` is what the *input* genuinely contains.
 */
function matrix(dir, { W, H, AW, AH }) {
  const s = path.join(dir, '_still.png');
  const rawStill = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', path.join(dir, 'still.rgb')];
  const rawAnim = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${AW}x${AH}`, '-r', '10', '-i', path.join(dir, 'anim.rgb')];

  const cases = [
    // --- stills, one per container the README advertises
    { name: 'still.bmp', args: [...rawStill, '-c:v', 'bmp'] },
    { name: 'still.tga', args: [...rawStill, '-c:v', 'targa'] },
    { name: 'still-rle.tga', args: [...rawStill, '-c:v', 'targa', '-compression_algo', 'rle'] },
    { name: 'still.ppm', args: [...rawStill, '-c:v', 'ppm'] },
    { name: 'still.pgm', args: [...rawStill, '-pix_fmt', 'gray', '-c:v', 'pgm'] },
    { name: 'still.pbm', args: [...rawStill, '-pix_fmt', 'monob', '-c:v', 'pbm'] },
    // Not claimed: the README lists PNM as P1-P6, and PAM is P7. It stays in the
    // matrix so the *refusal* is under test — an unsupported format still has to
    // fail in a sentence rather than in a libvips string.
    { name: 'still.pam', args: [...rawStill, '-c:v', 'pam'], unsupported: true },
    { name: 'still.tiff', args: [...rawStill, '-c:v', 'tiff'] },
    { name: 'still-lzw.tiff', args: [...rawStill, '-c:v', 'tiff', '-compression_algo', 'lzw'] },
    { name: 'still.png', args: [...rawStill, '-c:v', 'png'] },
    { name: 'still.gif', args: ['-i', s, '-c:v', 'gif'] },
    { name: 'still.webp', args: ['-i', s, '-c:v', 'libwebp', '-lossless', '1'] },
    { name: 'still.jpg', args: ['-i', s, '-q:v', '2'] },

    // --- multi-frame: the family where every single case lost data
    { name: 'anim.gif', args: [...rawAnim, '-c:v', 'gif'], frames: FRAMES },
    { name: 'anim.apng', args: [...rawAnim, '-c:v', 'apng', '-plays', '0'], frames: FRAMES },
    { name: 'anim.webp', args: [...rawAnim, '-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0'], frames: FRAMES },
  ];
  return FILTER ? cases.filter((c) => c.name.includes(FILTER)) : cases;
}

/**
 * PBM **P1** is ASCII bitmap. It is advertised under "PNM" and was rejected
 * outright, so it is written by hand — ffmpeg only emits the binary P4 form and
 * would never produce the case that failed.
 */
async function writeAsciiPbm(file) {
  const W = 64, H = 48;
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) row.push(x >= 8 && x < 30 && y >= 8 && y < 26 ? 1 : 0);
    rows.push(row.join(' '));
  }
  await writeFile(file, `P1\n# written by format-sweep.mjs\n${W} ${H}\n${rows.join('\n')}\n`);
}

// ------------------------------------------------------------- the assertions

const DRAWABLE = /<(path|rect|circle|ellipse|polygon|polyline|image|use)\b/;

/**
 * Everything an output has to satisfy to count as "converted". Exit code is the
 * first of six, not the only one, because exit code is what all nine known
 * defects already satisfied.
 */
async function checkSvg(file) {
  const problems = [];
  let svg;
  try {
    svg = await readFile(file, 'utf8');
  } catch {
    return ['no output file'];
  }
  if (svg.length === 0) problems.push('output is empty');
  if (!/<svg[\s>]/.test(svg)) problems.push('no <svg> root');
  if (!/viewBox=|width=/.test(svg)) problems.push('no dimensions');
  // The defect that wrote a well-formed SVG containing nothing at all, and
  // called it bit-exact.
  if (!DRAWABLE.test(svg)) problems.push('no drawable element');
  return problems;
}

/** Render the SVG and confirm it is neither blank nor accidentally transparent. */
async function checkRender(svgFile, sharp) {
  const problems = [];
  // pathToFileURL, not a bare path: on Windows `F:\...` is not a legal ESM URL.
  const { loadResvg } = await import(pathToFileURL(path.resolve('dist/esm/io/native.js')).href);
  const { Resvg } = await loadResvg();
  const png = new Resvg(await readFile(svgFile), { fitTo: { mode: 'width', value: 128 } }).render().asPng();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0, sum = 0, min = 255, max = 0;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] > 250) opaque++;
    const L = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    sum += L; if (L < min) min = L; if (L > max) max = L;
  }
  const n = info.width * info.height;
  // "Invented transparency": 1 opaque pixel in 39,601 passed every other check.
  if (opaque / n < 0.5) problems.push(`mostly transparent (${(100 * opaque / n).toFixed(1)}% opaque)`);
  // A single flat colour means the regions were lost, whatever the exit code.
  if (max - min < 8) problems.push(`renders flat (luma range ${Math.round(max - min)})`);
  return problems;
}

/**
 * For animations, every frame must survive — asserted on `animate`, which is the
 * command that claims to keep them. `convert` deliberately keeps one and says so,
 * so asserting frame counts on `convert` would only re-test a documented choice.
 *
 * `sourceFrames` is what the decoder saw and `frames` is what was written; the
 * defect that kept 1 of 36 would show as those two disagreeing, and a decoder
 * that never saw the frames at all shows as `sourceFrames` being wrong.
 */
async function checkFrames(input, out, expected) {
  try {
    const { stdout } = await run(process.execPath, [CLI, 'animate', input, '-o', out, '--json'], { maxBuffer: 1 << 24 });
    const r = JSON.parse(stdout);
    const problems = [];
    if (r.sourceFrames !== expected) problems.push(`decoder saw ${r.sourceFrames} frames, input has ${expected}`);
    if (r.frames !== expected) problems.push(`wrote ${r.frames} frames of ${expected}`);
    return problems;
  } catch (err) {
    return [`animate failed: ${String(err.stderr ?? err.message ?? err).split('\n')[0].slice(0, 90)}`];
  }
}

/**
 * A format we do **not** claim must still fail well. The README lists PNM as
 * P1-P6, so PAM (P7) is out of scope — but #78 was about formats that failed by
 * leaking `tiff2vips:` and libheif plugin errors at the user, so "unsupported"
 * has to mean a sentence naming what *is* supported, not an internal string.
 */
function checkRefusal(code, message) {
  const problems = [];
  if (code === 0) problems.push('documented as unsupported, but it succeeded');
  if (/\bat .*\(.*:\d+:\d+\)/.test(message)) problems.push('leaked a stack trace');
  if (/vips|heif:|tiffload|Error while loading plugin/i.test(message)) problems.push('leaked a codec internal');
  if (!/Supported inputs:/i.test(message)) problems.push('did not say what is supported');
  return problems;
}

// --------------------------------------------------------------------- driver

async function main() {
  if (!FFMPEG) {
    console.error(
      'ffmpeg not found. It writes the test matrix, and using our own encoders\n' +
      'instead would let a writer and a reader share a bug and agree.\n' +
      'Set VECLINE_FFMPEG=/path/to/ffmpeg, or install it, then re-run.',
    );
    process.exit(2);
  }
  if (!existsSync(CLI)) {
    console.error(`${CLI} is missing — run \`npm run build\` first.`);
    process.exit(2);
  }
  const sharp = (await import('sharp')).default;

  await mkdir(OUT, { recursive: true });
  const dims = await writeSources(OUT);
  const cases = matrix(OUT, dims);

  // Hand-written cases ffmpeg cannot produce.
  if (!FILTER || 'still-ascii.pbm'.includes(FILTER)) {
    await writeAsciiPbm(path.join(OUT, 'still-ascii.pbm'));
    cases.push({ name: 'still-ascii.pbm', prebuilt: true });
  }

  const results = [];
  for (const c of cases) {
    const input = path.join(OUT, c.name);
    if (!c.prebuilt) {
      try {
        await ffmpeg([...c.args, input]);
      } catch (err) {
        // A format ffmpeg itself will not write is not a vecline failure. Say so
        // rather than counting it as a pass.
        results.push({ name: c.name, status: 'SKIP', why: [`ffmpeg could not write it: ${String(err.message ?? err).split('\n')[0].slice(0, 80)}`] });
        continue;
      }
    }
    if (!existsSync(input)) {
      results.push({ name: c.name, status: 'SKIP', why: ['input was not produced'] });
      continue;
    }

    const out = path.join(OUT, `${c.name}.svg`);
    const problems = [];
    let code = 0;
    let message = '';
    try {
      await run(process.execPath, [CLI, 'convert', input, out], { maxBuffer: 1 << 24 });
    } catch (err) {
      code = err.code ?? 1;
      message = String(err.stderr ?? err.message ?? '');
    }
    if (c.unsupported) {
      problems.push(...checkRefusal(code, message));
    } else if (code !== 0) {
      problems.push(`convert exited ${code}: ${message.split('\n')[0].slice(0, 90)}`);
    } else {
      problems.push(...await checkSvg(out));
      if (problems.length === 0) problems.push(...await checkRender(out, sharp));
      if (c.frames) problems.push(...await checkFrames(input, path.join(OUT, `${c.name}.anim.svg`), c.frames));
    }
    const ok = c.unsupported ? 'refuse' : 'pass';
    results.push({ name: c.name, status: problems.length ? 'FAIL' : ok, why: problems, bytes: existsSync(out) ? (await stat(out)).size : 0 });
  }

  const pad = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log(`\nformat sweep — ${results.length} case(s), inputs written by ffmpeg\n`);
  for (const r of results) {
    console.log(`  ${r.status.padEnd(5)} ${r.name.padEnd(pad)}${r.bytes ? String(r.bytes).padStart(8) + ' B' : ''}`);
    for (const w of r.why) console.log(`        ${w}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const refused = results.filter((r) => r.status === 'refuse');
  console.log(
    `\n${results.length - failed.length - skipped.length - refused.length} passed, ` +
    `${refused.length} refused as documented, ${failed.length} failed, ${skipped.length} skipped`,
  );
  if (skipped.length) console.log('Skipped cases are NOT passes — they were never exercised.');

  if (!KEEP) await rm(OUT, { recursive: true, force: true });
  else console.log(`\nkept the matrix in ${OUT}/`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
