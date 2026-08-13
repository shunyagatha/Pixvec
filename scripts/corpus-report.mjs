#!/usr/bin/env node
/**
 * Run every corpus image through every mode and report what actually happens.
 *
 * This exists to find the things synthetic fixtures cannot: camera noise, JPEG
 * ringing, alpha from a real design tool, an SVG someone else wrote. A failure
 * here is worth more than a pass in the unit suite.
 *
 *   npm run corpus:report
 *   npm run corpus:report -- --json
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { encodeRaster } from '../dist/esm/io/encode.js';
import { decodeRaster, looksLikeSvg } from '../dist/esm/io/decode.js';
import { compareImages } from '../dist/esm/metrics/index.js';

const asJson = process.argv.includes('--json');
const SRC = 'corpus/src';
const OUT = 'corpus/out';

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const psnr = (v) => (Number.isFinite(v) ? v.toFixed(2) : '∞');

await mkdir(OUT, { recursive: true });
const files = (await readdir(SRC)).sort();
const rows = [];
const problems = [];

for (const file of files) {
  const path = join(SRC, file);
  const bytes = await readFile(path);
  const stem = basename(file, extname(file));

  // --- SVG inputs exercise the rasterize direction. ---
  if (looksLikeSvg(bytes)) {
    for (const width of [256, 1024]) {
      try {
        const started = Date.now();
        const { image, intrinsic } = await rasterizeSvg(bytes, { width });
        const png = await encodeRaster(image, { format: 'png' });
        await writeFile(join(OUT, `${stem}@${width}.png`), png);

        // A render that comes back blank is the failure mode that matters:
        // it looks like success everywhere except on screen.
        let opaque = 0;
        for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) opaque++;
        const coverage = opaque / (image.width * image.height);
        if (coverage < 0.01) problems.push(`${file} @${width}: rendered ${(coverage * 100).toFixed(2)}% covered — effectively blank`);

        rows.push({
          file, kind: 'svg->raster', mode: `@${width}`,
          out: `${image.width}x${image.height}`,
          bytes: png.length, coverage, ms: Date.now() - started,
          intrinsic: `${intrinsic.width}x${intrinsic.height}`,
        });
      } catch (err) {
        problems.push(`${file} @${width}: ${err.message}`);
        rows.push({ file, kind: 'svg->raster', mode: `@${width}`, error: err.message });
      }
    }
    continue;
  }

  // --- Raster inputs go through each vectorising mode. ---
  const source = await loadRaster(bytes);
  const px = source.image.width * source.image.height;

  for (const [mode, opts] of [
    ['auto', {}],
    ['lossless', { mode: 'lossless' }],
    ['trace', { mode: 'trace' }],
  ]) {
    try {
      const started = Date.now();
      const result = await vectorize(source, { ...opts, verify: true });
      const elapsed = Date.now() - started;
      await writeFile(join(OUT, `${stem}.${mode}.svg`), result.svg);

      const q = result.quality;
      rows.push({
        file, kind: 'raster->svg', mode,
        resolved: result.mode,
        size: `${source.image.width}x${source.image.height}`,
        inBytes: bytes.length, outBytes: Buffer.byteLength(result.svg),
        lossless: result.lossless,
        psnr: q?.psnr, ssim: q?.ssim, deltaE: q?.deltaE.mean,
        shapes: result.shapes, ms: elapsed,
      });

      // The guarantee is absolute: if lossless mode returns anything that is
      // not bit-exact, that is a bug and not a tuning question.
      if (mode === 'lossless' && !result.lossless) {
        problems.push(`${file}: lossless mode returned a non-exact result (psnr ${psnr(q?.psnr)})`);
      }
      if (mode === 'trace' && q && q.ssim < 0.5) {
        problems.push(`${file}: trace SSIM ${q.ssim.toFixed(4)} — visibly wrong, not merely approximate`);
      }
    } catch (err) {
      problems.push(`${file} [${mode}]: ${err.message}`);
      rows.push({ file, kind: 'raster->svg', mode, error: err.message });
    }
  }

  // --- Round-trip through every raster format at this image's real size. ---
  for (const format of ['png', 'webp', 'bmp', 'tga', 'pnm', 'ico', 'tiff']) {
    // ICO tops out at 256px per side; skip rather than report a bogus failure.
    if (format === 'ico' && (source.image.width > 256 || source.image.height > 256)) continue;
    try {
      const encoded = await encodeRaster(source.image, { format, lossless: true });
      const back = await decodeRaster(encoded);
      const q = compareImages(source.image, back.image);
      rows.push({
        file, kind: 'format round-trip', mode: format,
        outBytes: encoded.length, lossless: q.lossless, psnr: q.psnr,
      });
      // Every format in this list is lossless by definition.
      if (!q.lossless && format !== 'pnm') {
        problems.push(`${file} -> ${format}: round-trip not exact (psnr ${psnr(q.psnr)}, max ${q.maxChannelDiff})`);
      }
    } catch (err) {
      problems.push(`${file} -> ${format}: ${err.message}`);
    }
  }
  void px;
}

if (asJson) {
  console.log(JSON.stringify({ rows, problems }, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v, 2));
} else {
  console.log('\n=== raster -> SVG ===');
  console.log('file                        mode      resolved  size       in      out      PSNR    SSIM    exact  ms');
  for (const r of rows.filter((r) => r.kind === 'raster->svg')) {
    if (r.error) { console.log(`${r.file.padEnd(27)} ${r.mode.padEnd(9)} ERROR: ${r.error.slice(0, 50)}`); continue; }
    console.log(
      `${r.file.padEnd(27)} ${r.mode.padEnd(9)} ${(r.resolved ?? '').padEnd(9)} ${r.size.padEnd(10)} ` +
      `${kb(r.inBytes).padStart(7)} ${kb(r.outBytes).padStart(8)} ${psnr(r.psnr).padStart(7)} ` +
      `${(r.ssim ?? 0).toFixed(4)}  ${String(r.lossless).padEnd(6)} ${r.ms}`,
    );
  }

  console.log('\n=== SVG -> raster ===');
  for (const r of rows.filter((r) => r.kind === 'svg->raster')) {
    if (r.error) { console.log(`${r.file.padEnd(27)} ${r.mode.padEnd(8)} ERROR: ${r.error.slice(0, 50)}`); continue; }
    console.log(
      `${r.file.padEnd(27)} ${r.mode.padEnd(8)} intrinsic ${r.intrinsic.padEnd(11)} -> ${r.out.padEnd(11)} ` +
      `${kb(r.bytes).padStart(8)}  coverage ${(r.coverage * 100).toFixed(1)}%  ${r.ms}ms`,
    );
  }

  console.log('\n=== format round-trips (all must be exact) ===');
  const byFile = new Map();
  for (const r of rows.filter((r) => r.kind === 'format round-trip')) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(`${r.mode}${r.lossless ? '' : '(LOSSY!)'}`);
  }
  for (const [file, list] of byFile) console.log(`${file.padEnd(27)} ${list.join(' ')}`);

  console.log(`\n=== problems: ${problems.length} ===`);
  for (const p of problems) console.log(`  ! ${p}`);
}

await writeFile(join('corpus', 'report.json'), `${JSON.stringify({ rows, problems }, (_k, v) =>
  typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v, 2)}\n`);

if (problems.length > 0) process.exitCode = 1;
