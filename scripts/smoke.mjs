#!/usr/bin/env node
/**
 * End-to-end smoke test against the built CLI.
 *
 * The unit tests exercise the library; this exercises the thing users actually
 * run — argument parsing, file IO, format inference, exit codes. It has caught
 * breakage that never touched a single algorithm.
 *
 * Exits non-zero on the first failure, so CI stops with a useful message.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'esm', 'cli.js');

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Flat artwork: few colours, long runs — the case pixel mode should claim. */
async function flatArtwork(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2);
      const c =
        d < height / 5 ? [250, 244, 232] :
        d < height / 3 ? [214, 69, 65] :
        x < width / 2 ? [32, 96, 160] : [40, 150, 110];
      const o = (y * width + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const dir = await mkdtemp(join(tmpdir(), 'graver-smoke-'));

try {
  const src = join(dir, 'art.png');
  await writeFile(src, await flatArtwork(240, 180));

  console.log('vectorize --json --verify');
  const vectorized = JSON.parse(run(['vectorize', src, '-o', join(dir, 'art.svg'), '--verify', '--json']));
  check('picked pixel mode for flat artwork', vectorized.mode === 'pixel', `got ${vectorized.mode}`);
  check('reported lossless', vectorized.lossless === true);
  check('measured infinite PSNR', vectorized.quality?.psnr === 'Infinity',
    `psnr=${JSON.stringify(vectorized.quality?.psnr)}`);
  check('emitted shapes', vectorized.shapes > 0);

  console.log('rasterize --json');
  const rasterized = JSON.parse(run(['rasterize', join(dir, 'art.svg'), '-o', join(dir, 'rt.png'), '--json']));
  check('round-trip size preserved', rasterized.width === 240 && rasterized.height === 180,
    `${rasterized.width}x${rasterized.height}`);

  console.log('verify (raster vs raster)');
  const verified = JSON.parse(run(['verify', src, join(dir, 'rt.png'), '--json']));
  check('round trip is bit-exact', verified.lossless === true, `exactRatio=${verified.exactRatio}`);

  console.log('verify (raster vs svg directly)');
  const direct = JSON.parse(run(['verify', src, join(dir, 'art.svg'), '--json']));
  check('svg compares bit-exactly', direct.lossless === true);

  console.log('scaling');
  const scaled = JSON.parse(run(['rasterize', join(dir, 'art.svg'), '-o', join(dir, 'art4x.png'), '--scale', '4', '--json']));
  check('scaled 4x', scaled.width === 960 && scaled.height === 720, `${scaled.width}x${scaled.height}`);

  console.log('lossless mode on photographic input');
  const noise = Buffer.alloc(120 * 90 * 4);
  for (let i = 0; i < 120 * 90; i++) {
    noise[i * 4] = (i * 37) % 256;
    noise[i * 4 + 1] = (i * 91) % 256;
    noise[i * 4 + 2] = (i * 13) % 256;
    noise[i * 4 + 3] = 255;
  }
  const photo = join(dir, 'photo.png');
  await writeFile(photo, await sharp(noise, { raw: { width: 120, height: 90, channels: 4 } }).png().toBuffer());

  const lossless = JSON.parse(run(['vectorize', photo, '-o', join(dir, 'photo.svg'), '--mode', 'lossless', '--verify', '--json']));
  check('lossless mode produced an exact result', lossless.lossless === true, `mode=${lossless.mode}`);

  console.log('info');
  const info = JSON.parse(run(['info', src, '--json']));
  check('info reports the raster kind', info.kind === 'raster');
  check('info counts colours', typeof info.flatness?.distinctColors === 'number');

  // Regression: `convert` and `batch` used to forward a merged options blob to
  // whichever runner applied, so the SVG-to-raster direction of both crashed on
  // a `background` value that meant something else to the other runner.
  console.log('convert, both directions');
  run(['convert', src, join(dir, 'conv.svg')]);
  run(['convert', join(dir, 'art.svg'), join(dir, 'conv.png')]);
  const converted = JSON.parse(run(['info', join(dir, 'conv.png'), '--json']));
  check('convert produced a real raster', converted.width === 240 && converted.height === 180,
    `${converted.width}x${converted.height}`);
  run(['convert', join(dir, 'art.svg'), join(dir, 'conv2.png'), '--scale', '2']);
  const convertScaled = JSON.parse(run(['info', join(dir, 'conv2.png'), '--json']));
  check('convert honours --scale', convertScaled.width === 480, `width=${convertScaled.width}`);

  console.log('batch, both directions');
  run(['batch', join(dir, '*.png'), '-o', join(dir, 'b1'), '--to', 'svg']);
  run(['batch', join(dir, 'art.svg'), '-o', join(dir, 'b2'), '--to', 'png']);
  check('batch produced svg output', existsSync(join(dir, 'b1', 'art.svg')));
  check('batch produced png output', existsSync(join(dir, 'b2', 'art.png')));

  console.log('extract');
  run(['vectorize', src, '-o', join(dir, 'keep.svg'), '--mode', 'embed', '--embed-strategy', 'preserve']);
  const extracted = JSON.parse(run(['extract', join(dir, 'keep.svg'), '-o', join(dir, 'back.png'), '--against', src, '--json']));
  check('extract recovers the original file', extracted.matchesSource === true);
  check('extract verifies the recorded digest', extracted.digestVerified === true);

  console.log('exit codes');
  let threw = false;
  try {
    run(['vectorize', join(dir, 'art.svg'), '-o', join(dir, 'nope.svg')]);
  } catch {
    threw = true;
  }
  check('rejects an SVG passed to vectorize', threw);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
