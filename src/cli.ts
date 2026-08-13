#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { glob } from 'tinyglobby';
import {
  PRESETS, VERSION, loadAnyAsRaster, loadRaster, measureFlatness, rasterize, suggestTitle, vectorize,
} from './api.js';
import { parseCssColor } from './color.js';
import { decodeRaster, looksLikeSvg } from './io/decode.js';
import { formatFromExtension } from './io/encode.js';
import { baseDirFor, rasterizeSvg } from './io/rasterize.js';
import { compareImages } from './metrics/index.js';
import { extractEmbedded } from './vectorize/embed.js';
import type { AlphaMode, QualityReport, RasterFormat, Rgba } from './types.js';

// ---------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) =>
  useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');

function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`${red('error')} ${msg}\n`);
  process.exit(1);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatPsnr(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} dB` : '∞';
}

/**
 * Serialise for `--json`, keeping infinities readable.
 *
 * `JSON.stringify(Infinity)` is `null`, which would make a perfect score
 * indistinguishable from a missing field — the exact opposite of what a
 * lossless result should communicate. Emitting the string `"Infinity"` keeps it
 * unambiguous and still parses everywhere.
 */
function emitJson(payload: unknown): void {
  const json = JSON.stringify(
    payload,
    (_key, value) =>
      typeof value === 'number' && !Number.isFinite(value)
        ? (Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity')
        : value,
    2,
  );
  process.stdout.write(`${json}\n`);
}

/** Render a quality report as a short, scannable block. */
function printQuality(q: QualityReport, label = 'Accuracy'): void {
  const verdict = q.lossless
    ? green('bit-exact (lossless)')
    : q.exactRatio > 0.999
      ? green(`${(q.exactRatio * 100).toFixed(3)}% pixels exact`)
      : `${(q.exactRatio * 100).toFixed(2)}% pixels exact`;

  info(`\n${bold(label)}  ${verdict}`);
  info(`  ${dim('PSNR')}        ${formatPsnr(q.psnr)}`);
  info(`  ${dim('SSIM')}        ${q.ssim.toFixed(6)} ${dim(`(luma ${q.ssimLuma.toFixed(6)})`)}`);
  info(`  ${dim('RMSE')}        ${q.rmse.toFixed(4)}`);
  if (!q.lossless) {
    info(
      `  ${dim('CIEDE2000')}   mean ${q.deltaE.mean.toFixed(3)}  ` +
        `p95 ${q.deltaE.p95.toFixed(3)}  max ${q.deltaE.max.toFixed(3)}`,
    );
    info(`  ${dim('Max channel')} ${q.maxChannelDiff}/255`);
  }
}

// ---------------------------------------------------------------------------
// Option parsers
// ---------------------------------------------------------------------------

function intArg(name: string, min: number, max: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${name} must be an integer between ${min} and ${max}.`);
    }
    return n;
  };
}

function floatArg(name: string, min: number, max: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${name} must be a number between ${min} and ${max}.`);
    }
    return n;
  };
}

function colorArg(value: string): Rgba {
  const c = parseCssColor(value);
  if (!c) throw new InvalidArgumentError(`Unrecognised colour: ${value}`);
  return c;
}

async function readInput(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    return fail(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

async function writeOutput(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
}

function defaultOutput(input: string, ext: string): string {
  const dir = dirname(input);
  const stem = basename(input, extname(input));
  return join(dir, `${stem}${ext}`);
}

// ---------------------------------------------------------------------------
// vectorize
// ---------------------------------------------------------------------------

interface VectorizeCliOptions {
  output?: string;
  mode: string;
  preset: string;
  colors?: number;
  alphaLevels?: number;
  minArea?: number;
  tolerance?: number;
  fitError?: number;
  cornerAngle?: number;
  polygon?: boolean;
  precision?: number;
  background: boolean;
  targetSsim?: number;
  targetPsnr?: number;
  maxColors?: number;
  maxSteps?: number;
  lossless?: boolean;
  prefer?: string;
  maxGeometryRatio?: number;
  verify?: boolean;
  embedStrategy: string;
  xlink?: boolean;
  imageRendering?: string;
  generator: boolean;
  title?: string;
  json?: boolean;
}

async function runVectorize(input: string, o: VectorizeCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (looksLikeSvg(bytes)) {
    fail(`${input} is already an SVG. Did you mean \`pixvec rasterize\`?`);
  }

  const source = await loadRaster(bytes);
  const outPath = o.output ?? defaultOutput(input, '.svg');

  const result = await vectorize(source, {
    mode: (o.lossless ? 'lossless' : o.mode) as never,
    preset: o.preset as never,
    losslessPrefer: o.prefer as never,
    maxGeometryRatio: o.maxGeometryRatio,
    verify: o.verify,
    targetSsim: o.targetSsim,
    targetPsnr: o.targetPsnr,
    maxColors: o.maxColors,
    maxRefineSteps: o.maxSteps,
    title: o.title ?? suggestTitle(input),
    noGenerator: !o.generator,
    trace: {
      colors: o.colors,
      alphaLevels: o.alphaLevels,
      minArea: o.minArea,
      tolerance: o.tolerance,
      fitError: o.fitError,
      cornerAngle: o.cornerAngle,
      polygonOnly: o.polygon,
      precision: o.precision,
      background: o.background,
    },
    pixel: { background: o.background },
    embed: {
      strategy: o.embedStrategy as never,
      xlink: o.xlink,
      imageRendering: o.imageRendering as never,
    },
  });

  await writeOutput(outPath, result.svg);
  const outSize = Buffer.byteLength(result.svg);

  if (o.json) {
    emitJson({
      input, output: outPath, mode: result.mode,
      width: result.width, height: result.height,
      shapes: result.shapes, colors: result.colors,
      lossless: result.lossless,
      inputBytes: source.meta.bytes, outputBytes: outSize,
      elapsedMs: result.elapsedMs,
      settled: result.settled,
      quality: result.quality,
      notes: result.notes,
    });
    return;
  }

  info(
    `${green('✓')} ${bold(basename(outPath))}  ${dim(
      `${result.width}×${result.height}  ${result.mode} mode  ` +
        `${result.shapes} shape${result.shapes === 1 ? '' : 's'}  ` +
        `${formatBytes(source.meta.bytes)} → ${formatBytes(outSize)}  ${result.elapsedMs} ms`,
    )}`,
  );

  for (const note of result.notes) info(`  ${dim('·')} ${note}`);
  if (result.quality) printQuality(result.quality);
  else if (result.lossless) info(`\n${bold('Accuracy')}  ${green('bit-exact by construction')} ${dim('(pass --verify to prove it)')}`);
}

// ---------------------------------------------------------------------------
// rasterize
// ---------------------------------------------------------------------------

interface RasterizeCliOptions {
  output?: string;
  width?: number;
  height?: number;
  scale?: number;
  dpi?: number;
  background?: Rgba;
  format?: string;
  quality: number;
  lossless?: boolean;
  effort?: number;
  shapeRendering: string;
  textRendering: string;
  imageRendering: string;
  fontDir?: string[];
  defaultFont?: string;
  verify?: boolean;
  json?: boolean;
}

async function runRasterize(input: string, o: RasterizeCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (!looksLikeSvg(bytes)) {
    fail(`${input} does not look like an SVG. Did you mean \`pixvec vectorize\`?`);
  }

  const outPath = o.output ?? defaultOutput(input, `.${o.format ?? 'png'}`);
  const format = o.format
    ? formatFromExtension(o.format)
    : formatFromExtension(extname(outPath)) ?? 'png';
  if (!format) fail(`Unsupported output format: ${o.format ?? extname(outPath)}`);

  // A lossless request must not be quietly defeated by the container. JPEG has
  // no lossless mode at all, and GIF caps out at 256 colours, so asking either
  // of them for an exact result is a contradiction worth reporting rather than
  // silently honouring halfway.
  if (o.lossless && (format === 'jpeg' || format === 'gif')) {
    fail(
      `--lossless cannot be honoured by ${format}: ` +
        `${format === 'jpeg' ? 'JPEG has no lossless mode' : 'GIF is limited to 256 colours'}. ` +
        `Use PNG, or WebP/AVIF with --lossless.`,
    );
  }

  const outcome = await rasterize(
    bytes,
    {
      baseDir: baseDirFor(input),
      width: o.width,
      height: o.height,
      scale: o.scale,
      dpi: o.dpi,
      background: o.background,
      shapeRendering: o.shapeRendering as never,
      textRendering: o.textRendering as never,
      imageRendering: o.imageRendering as never,
      fontDirs: o.fontDir,
      defaultFontFamily: o.defaultFont,
      encode: {
        format: format as RasterFormat,
        quality: o.quality,
        lossless: o.lossless,
        effort: o.effort,
        background: o.background,
      },
    },
    o.verify || o.lossless,
  );

  await writeOutput(outPath, outcome.buffer);

  // A verified --lossless run must actually be lossless.
  if (o.lossless && outcome.quality && !outcome.quality.lossless) {
    const differing = outcome.quality.pixels - outcome.quality.exactPixels;
    fail(
      `--lossless was requested but the ${format} encoder changed ${differing} pixel(s) ` +
        `(max ${outcome.quality.maxChannelDiff}/255).`,
    );
  }

  if (o.json) {
    emitJson({
      input, output: outPath, format,
      width: outcome.width, height: outcome.height,
      intrinsic: outcome.intrinsic,
      inlined: outcome.inlined,
      outputBytes: outcome.buffer.length,
      quality: outcome.quality,
    });
    return;
  }

  info(
    `${green('✓')} ${bold(basename(outPath))}  ${dim(
      `${outcome.width}×${outcome.height}  ${format}  ${formatBytes(outcome.buffer.length)}`,
    )}`,
  );
  if (outcome.intrinsic.width !== outcome.width) {
    info(`  ${dim('·')} SVG intrinsic size ${outcome.intrinsic.width}×${outcome.intrinsic.height}`);
  }
  for (const f of outcome.inlined) info(`  ${dim('·')} inlined ${basename(f)}`);
  if (outcome.quality) printQuality(outcome.quality, 'Encoding fidelity');
}

// ---------------------------------------------------------------------------
// convert (direction inferred from extensions)
// ---------------------------------------------------------------------------

/**
 * Options `convert` and `batch` accept, before the direction is known.
 *
 * Kept deliberately small and explicitly typed. An earlier version forwarded a
 * merged `Record<string, unknown>` to whichever runner applied, which quietly
 * broke: `background` is a boolean for vectorize ("collapse the dominant colour
 * into one rectangle") and an RGBA colour for rasterize ("paint underneath").
 * Passing `true` where a colour was expected produced
 * `rgba(undefined,undefined,undefined,NaN)` and a baffling parser error.
 */
interface SharedCliOptions {
  mode?: string;
  preset?: string;
  colors?: number;
  width?: number;
  height?: number;
  scale?: number;
  /** Rasterize only: painted under the artwork. */
  background?: Rgba;
  quality?: number;
  lossless?: boolean;
  verify?: boolean;
  json?: boolean;
}

function toVectorizeOptions(o: SharedCliOptions, output: string): VectorizeCliOptions {
  return {
    output,
    mode: o.mode ?? 'auto',
    preset: o.preset ?? 'auto',
    colors: o.colors,
    lossless: o.lossless,
    prefer: 'auto',
    // Vectorize's own meaning: collapse the dominant colour into one rectangle.
    background: true,
    embedStrategy: 'auto',
    generator: true,
    verify: o.verify,
    json: o.json,
  };
}

function toRasterizeOptions(o: SharedCliOptions, output: string): RasterizeCliOptions {
  return {
    output,
    width: o.width,
    height: o.height,
    scale: o.scale,
    background: o.background,
    quality: o.quality ?? 92,
    lossless: o.lossless,
    shapeRendering: 'geometricPrecision',
    textRendering: 'optimizeLegibility',
    imageRendering: 'optimizeQuality',
    verify: o.verify,
    json: o.json,
  };
}

async function runConvert(input: string, output: string, o: SharedCliOptions): Promise<void> {
  if (extname(output).toLowerCase() === '.svg') {
    await runVectorize(input, toVectorizeOptions(o, output));
  } else {
    await runRasterize(input, toRasterizeOptions(o, output));
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

interface VerifyCliOptions {
  alphaMode: string;
  background: Rgba;
  width?: number;
  json?: boolean;
  failUnder?: number;
}

async function runVerify(a: string, b: string, o: VerifyCliOptions): Promise<void> {
  const [bytesA, bytesB] = await Promise.all([readInput(a), readInput(b)]);

  const loadedA = await loadAnyAsRaster(bytesA, a, { baseDir: baseDirFor(a), width: o.width });
  const loadedB = await loadAnyAsRaster(bytesB, b, {
    baseDir: baseDirFor(b),
    // Match the reference size so an SVG compared against a PNG lines up.
    width: o.width ?? (loadedA.kind === 'raster' ? loadedA.image.width : undefined),
  });

  if (
    loadedA.image.width !== loadedB.image.width ||
    loadedA.image.height !== loadedB.image.height
  ) {
    fail(
      `Size mismatch: ${loadedA.image.width}×${loadedA.image.height} vs ` +
        `${loadedB.image.width}×${loadedB.image.height}. Use --width to render both at one size.`,
    );
  }

  const report = compareImages(loadedA.image, loadedB.image, {
    alphaMode: o.alphaMode as AlphaMode,
    deltaEBackground: o.background,
  });

  if (o.json) {
    emitJson({ reference: a, candidate: b, ...report });
  } else {
    info(`${bold(basename(a))} ${dim('vs')} ${bold(basename(b))}  ${dim(`${report.width}×${report.height}`)}`);
    printQuality(report, 'Result');
  }

  if (o.failUnder !== undefined && report.ssim < o.failUnder) {
    process.stderr.write(
      `${red('fail')} mean SSIM ${report.ssim.toFixed(6)} is below --fail-under ${o.failUnder}\n`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

interface ExtractCliOptions {
  output?: string;
  against?: string;
  json?: boolean;
}

/**
 * Recover the bitmap embedded by `embed` mode.
 *
 * This is the other half of a byte-identical round trip: `vectorize --lossless`
 * can carry the original file inside the SVG untouched, and this hands it back.
 * The digest recorded at write time turns "should be the same file" into
 * something checkable.
 */
async function runExtract(input: string, o: ExtractCliOptions): Promise<void> {
  const svg = (await readInput(input)).toString('utf8');
  const payload = extractEmbedded(svg);

  if (!payload) {
    fail(
      `${basename(input)} contains no embedded bitmap. ` +
        `Only SVGs written by embed mode carry one.`,
    );
  }

  const outPath = o.output ?? defaultOutput(input, `.${payload.extension}`);
  await writeOutput(outPath, payload.bytes);

  // Compare against the true original when the caller can supply it.
  let matchesSource: boolean | undefined;
  if (o.against) {
    const original = await readInput(o.against);
    matchesSource = original.equals(payload.bytes);
  }

  if (o.json) {
    emitJson({
      input, output: outPath, mime: payload.mime,
      bytes: payload.bytes.length,
      sha256: payload.actualSha256,
      recordedSha256: payload.recordedSha256 ?? null,
      digestVerified: payload.verified,
      isOriginalFile: payload.isOriginal,
      matchesSource: matchesSource ?? null,
    });
    if (matchesSource === false || (payload.recordedSha256 && !payload.verified)) process.exit(2);
    return;
  }

  info(
    `${green('✓')} ${bold(basename(outPath))}  ${dim(`${payload.mime}  ${formatBytes(payload.bytes.length)}`)}`,
  );
  info(`  ${dim('sha256')}   ${payload.actualSha256}`);

  if (payload.recordedSha256) {
    info(
      payload.verified
        ? `  ${dim('digest')}   ${green('matches the value recorded when the SVG was written')}`
        : `  ${dim('digest')}   ${red('MISMATCH')} — recorded ${payload.recordedSha256}`,
    );
  } else {
    info(`  ${dim('digest')}   ${dim('no recorded digest; nothing to check against')}`);
  }

  info(
    payload.isOriginal
      ? `  ${dim('payload')}  ${green('the original file, preserved byte for byte')}`
      : `  ${dim('payload')}  re-encoded from the source pixels (not the original bytes)`,
  );

  if (matchesSource !== undefined) {
    info(
      matchesSource
        ? `  ${dim('vs source')} ${green('byte-identical to ' + basename(o.against!))}`
        : `  ${dim('vs source')} ${red('differs from ' + basename(o.against!))}`,
    );
  }

  if (matchesSource === false || (payload.recordedSha256 && !payload.verified)) process.exit(2);
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

async function runInfo(input: string, o: { json?: boolean }): Promise<void> {
  const bytes = await readInput(input);
  const size = (await stat(input)).size;

  if (looksLikeSvg(bytes)) {
    const { image, intrinsic, inlined } = await rasterizeSvg(bytes, { baseDir: baseDirFor(input) });
    const payload = {
      path: input, kind: 'svg' as const, bytes: size,
      intrinsic, rendered: { width: image.width, height: image.height },
      externalReferences: inlined,
    };
    if (o.json) {
      emitJson(payload);
      return;
    }
    info(`${bold(basename(input))}  ${dim(formatBytes(size))}`);
    info(`  ${dim('kind')}       SVG`);
    info(`  ${dim('intrinsic')}  ${intrinsic.width}×${intrinsic.height}`);
    if (inlined.length) info(`  ${dim('inlined')}    ${inlined.length} external image(s)`);
    return;
  }

  const { image, meta } = await decodeRaster(bytes);
  const flat = measureFlatness(image, 4096);
  const suggestion = flat.capped || flat.runRatio > 0.12
    ? 'trace (approximate) or embed (exact)'
    : 'pixel — bit-exact vector output is achievable';

  const payload = { path: input, kind: 'raster' as const, ...meta, flatness: flat, suggestion };
  if (o.json) {
    emitJson(payload);
    return;
  }

  info(`${bold(basename(input))}  ${dim(formatBytes(size))}`);
  info(`  ${dim('format')}     ${meta.format}${meta.depth !== 'uchar' ? ` (${meta.depth})` : ''}`);
  info(`  ${dim('size')}       ${meta.width}×${meta.height}`);
  info(`  ${dim('space')}      ${meta.space}${meta.hasProfile ? ' + ICC profile' : ''}`);
  info(`  ${dim('alpha')}      ${meta.hasAlpha ? 'yes' : 'no'}`);
  if (meta.orientation && meta.orientation > 1) info(`  ${dim('EXIF')}       orientation ${meta.orientation}`);
  info(`  ${dim('colours')}    ${flat.capped ? '>4096' : flat.distinctColors}`);
  info(`  ${dim('run density')} ${(flat.runRatio * 100).toFixed(1)}%`);
  info(`  ${cyan('best mode')}  ${suggestion}`);
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

interface BatchCliOptions extends SharedCliOptions {
  outDir: string;
  to: string;
  concurrency: number;
}

async function runBatch(patterns: string[], o: BatchCliOptions): Promise<void> {
  // Glob syntax reserves `\` as an escape character, so a Windows path like
  // `C:\assets\*.png` matches nothing at all. Forward slashes work on every
  // platform, including Windows, so normalise before matching rather than
  // telling users their shell-completed path is wrong.
  const normalized = patterns.map((p) => p.replace(/\\/g, '/'));
  // Absolute results, because a relative path cannot express a match on another
  // drive: `C:\...` relativised against `F:\...` yields `../../C:/...`, which
  // then resolves to the fictional `F:\C:\...`.
  const files = await glob(normalized, { absolute: true, onlyFiles: true });
  if (files.length === 0) fail(`No files matched: ${patterns.join(', ')}`);

  await mkdir(o.outDir, { recursive: true });
  info(`${bold(String(files.length))} file${files.length === 1 ? '' : 's'} → ${o.outDir}\n`);

  let done = 0;
  let failed = 0;
  const queue = [...files];

  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const target = join(o.outDir, `${basename(file, extname(file))}.${o.to.replace(/^\./, '')}`);
      try {
        if (o.to.replace(/^\./, '') === 'svg') {
          await runVectorize(file, toVectorizeOptions(o, target));
        } else {
          await runRasterize(file, toRasterizeOptions(o, target));
        }
        done++;
      } catch (err) {
        failed++;
        info(`${red('✗')} ${file}: ${(err as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  info(`\n${done} succeeded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('pixvec')
  .description(
    'Measurable raster <-> SVG conversion.\n\n' +
      'Raster to SVG has three honest strategies and this tool exposes all of them:\n' +
      '  pixel  real vector geometry, bit-exact, best for flat artwork\n' +
      '  trace  real curves, approximate, best for photos and complex art\n' +
      '  embed  bitmap in an SVG wrapper, bit-exact, not editable geometry\n\n' +
      'SVG to raster is exact at any resolution you ask for.',
  )
  .version(VERSION, '-v, --version');

program
  .command('vectorize')
  .alias('trace')
  .description('Convert a raster image (PNG, JPEG, WebP, AVIF, TIFF, GIF, BMP, ICO, PNM, TGA) to SVG')
  .argument('<input>', 'source image')
  .option('-o, --output <file>', 'output path (defaults to <input>.svg)')
  .addOption(
    new Option('-m, --mode <mode>', 'conversion strategy')
      .choices(['auto', 'lossless', 'pixel', 'trace', 'embed'])
      .default('auto'),
  )
  .addOption(
    new Option('-p, --preset <preset>', 'tuning profile for trace mode')
      .choices(['auto', ...Object.keys(PRESETS), 'pixelart', 'exact'])
      .default('auto'),
  )
  .option('-c, --colors <n>', 'palette size for trace mode', intArg('--colors', 1, 256))
  .option('--alpha-levels <n>', 'distinct alpha levels to keep', intArg('--alpha-levels', 1, 64))
  .option('--min-area <px>', 'absorb regions smaller than this', intArg('--min-area', 0, 1e6))
  .option('--tolerance <px>', 'outline simplification tolerance', floatArg('--tolerance', 0, 100))
  .option('--fit-error <px>', 'maximum curve fitting error', floatArg('--fit-error', 0.01, 100))
  .option('--corner-angle <deg>', 'turn angle treated as a sharp corner', floatArg('--corner-angle', 0, 180))
  .option('--polygon', 'emit polygons instead of curves')
  .option('--precision <n>', 'decimals kept in path coordinates', intArg('--precision', 0, 8))
  .option('--no-background', 'do not collapse the dominant colour into one rectangle')
  .option('--target-ssim <v>', 'escalate settings until SSIM reaches this', floatArg('--target-ssim', 0, 1))
  .option('--target-psnr <db>', 'escalate settings until PSNR reaches this', floatArg('--target-psnr', 0, 200))
  .option('--max-colors <n>', 'palette ceiling during refinement', intArg('--max-colors', 2, 256))
  .option('--max-steps <n>', 'refinement attempts', intArg('--max-steps', 1, 12))
  .option('-l, --lossless', 'guarantee a bit-exact result, or fail (same as --mode lossless)')
  .addOption(
    new Option('--prefer <what>', 'what lossless optimises for once exactness is assured')
      .choices(['auto', 'geometry', 'size'])
      .default('auto'),
  )
  .option(
    '--max-geometry-ratio <n>',
    'how much larger real geometry may be than the alternative under --prefer auto',
    floatArg('--max-geometry-ratio', 1, 1000),
  )
  .option('--verify', 'render the result and measure it against the input')
  .addOption(
    new Option('--embed-strategy <s>', 'payload handling for embed mode')
      .choices(['auto', 'preserve', 'png', 'webp'])
      .default('auto'),
  )
  .option('--xlink', 'use xlink:href for SVG 1.1 consumers')
  .addOption(
    new Option('--image-rendering <mode>', 'scaling hint for embedded bitmaps')
      .choices(['auto', 'optimizeQuality', 'optimizeSpeed', 'pixelated']),
  )
  .option('--no-generator', 'omit the generator comment')
  .option('--title <text>', 'document <title>')
  .option('--json', 'machine-readable output on stdout')
  .action(runVectorize);

program
  .command('rasterize')
  .alias('render')
  .description('Render an SVG to PNG, JPEG, WebP, AVIF, TIFF, or GIF')
  .argument('<input>', 'source SVG')
  .option('-o, --output <file>', 'output path (defaults to <input>.png)')
  .option('-w, --width <px>', 'output width', intArg('--width', 1, 100000))
  .option('-h, --height <px>', 'output height', intArg('--height', 1, 100000))
  .option('-s, --scale <factor>', 'uniform zoom', floatArg('--scale', 0.001, 1000))
  .option('--dpi <n>', 'resolution for physical units', floatArg('--dpi', 1, 10000))
  .option('-b, --background <color>', 'paint under the artwork', colorArg)
  .option('-f, --format <fmt>', 'output format (inferred from the extension otherwise)')
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('--lossless', 'lossless WebP/AVIF')
  .option('--effort <n>', 'encoder effort')
  .addOption(
    new Option('--shape-rendering <mode>', 'antialiasing for shapes')
      .choices(['optimizeSpeed', 'crispEdges', 'geometricPrecision'])
      .default('geometricPrecision'),
  )
  .addOption(
    new Option('--text-rendering <mode>', 'text rasterisation hint')
      .choices(['optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'])
      .default('optimizeLegibility'),
  )
  .addOption(
    new Option('--image-rendering <mode>', 'scaling of embedded bitmaps')
      .choices(['optimizeQuality', 'optimizeSpeed'])
      .default('optimizeQuality'),
  )
  .option('--font-dir <dir...>', 'extra font directories')
  .option('--default-font <family>', 'fallback font family')
  .option('--verify', 're-decode the encoded file and report what the encoder cost')
  .option('--json', 'machine-readable output on stdout')
  .action(runRasterize);

program
  .command('convert')
  .description('Convert in whichever direction the file extensions imply')
  .argument('<input>')
  .argument('<output>')
  .option('-m, --mode <mode>', 'conversion strategy for raster → SVG', 'auto')
  .option('-p, --preset <preset>', 'tuning profile', 'auto')
  .option('-c, --colors <n>', 'palette size', intArg('--colors', 1, 256))
  .option('-w, --width <px>', 'output width for SVG → raster', intArg('--width', 1, 100000))
  .option('-h, --height <px>', 'output height for SVG → raster', intArg('--height', 1, 100000))
  .option('-s, --scale <factor>', 'uniform zoom', floatArg('--scale', 0.001, 1000))
  .option('-b, --background <color>', 'background colour', colorArg)
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('--verify', 'measure the result')
  .option('--json', 'machine-readable output')
  .action((input: string, output: string, opts: SharedCliOptions) =>
    runConvert(input, output, opts),
  );

program
  .command('verify')
  .description('Measure the difference between two images (raster or SVG, in any combination)')
  .argument('<reference>')
  .argument('<candidate>')
  .addOption(
    new Option('--alpha-mode <mode>', 'how to treat colour under transparency')
      .choices(['premultiplied', 'straight'])
      .default('premultiplied'),
  )
  .option('-b, --background <color>', 'flattening colour for CIEDE2000', colorArg, {
    r: 255, g: 255, b: 255, a: 255,
  })
  .option('-w, --width <px>', 'render both at this width first', intArg('--width', 1, 100000))
  .option('--fail-under <ssim>', 'exit non-zero if SSIM falls below this', floatArg('--fail-under', 0, 1))
  .option('--json', 'machine-readable output')
  .action(runVerify);

program
  .command('extract')
  .description('Recover the original bitmap embedded in an SVG, and prove it is unchanged')
  .argument('<input.svg>')
  .option('-o, --output <file>', 'output path (defaults to the recorded media type)')
  .option('--against <file>', 'also compare byte-for-byte against this file')
  .option('--json', 'machine-readable output')
  .action(runExtract);

program
  .command('info')
  .description('Inspect a file and recommend a conversion strategy')
  .argument('<input>')
  .option('--json', 'machine-readable output')
  .action(runInfo);

program
  .command('batch')
  .description('Convert many files at once')
  .argument('<patterns...>', 'glob patterns')
  .requiredOption('-o, --out-dir <dir>', 'destination directory')
  .option('--to <ext>', 'target extension', 'svg')
  .option('-m, --mode <mode>', 'conversion strategy', 'auto')
  .option('-p, --preset <preset>', 'tuning profile', 'auto')
  .option('-c, --colors <n>', 'palette size', intArg('--colors', 1, 256))
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('--concurrency <n>', 'parallel workers', intArg('--concurrency', 1, 64), 4)
  .option('--verify', 'measure every result')
  .action((patterns: string[], opts: SharedCliOptions & { outDir: string; to: string; concurrency: number }) =>
    runBatch(patterns, opts as unknown as BatchCliOptions),
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${red('error')} ${message}\n`);
  if (process.env.PIXVEC_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(`${dim(err.stack)}\n`);
  }
  process.exit(1);
});
