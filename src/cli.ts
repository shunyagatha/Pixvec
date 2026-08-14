#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { glob } from 'tinyglobby';
import {
  PRESETS, VERSION, loadAnyAsRaster, loadRaster, measureFlatness, rasterize, suggestTitle, vectorize,
} from './api.js';
import { parseCssColor } from './color.js';
import { decodeRaster, looksLikeSvg } from './io/decode.js';
import { encodeRaster, formatFromExtension } from './io/encode.js';
import { baseDirFor, rasterizeSvg } from './io/rasterize.js';
import { compareImages } from './metrics/index.js';
import { extractEmbedded } from './vectorize/embed.js';
import { bytesEqual } from './io/formats/bytes.js';
import { removeBackground, type RemoveBackgroundOptions } from './background.js';
import { editImage, hasOps, type OpsChain } from './ops.js';
import { toComponent, type Framework } from './emit/component.js';
import { faviconSet } from './pipelines/favicon.js';
import { responsiveSet } from './pipelines/responsive.js';
import { traceAnimation } from './pipelines/animate.js';
import { blurHash, lqipSvg } from './placeholder/index.js';
import { extractPalette, paletteToCssVars } from './vectorize/quantize.js';
import { traceGeometry, toDxf, toEps, toPdf, toGcode } from './io/export/index.js';
import { centerlineTrace, centerlinePolylines } from './vectorize/centerline.js';
import { startMcpServer } from './mcp/server.js';
import { optimizeSvg } from './svg/optimize.js';
import { svgSprite } from './emit/sprite.js';
import { smartCrop, cropImage } from './crop.js';
import { diffImages } from './diff.js';
import { formatBatchSummary } from './io/batch-summary.js';
import { isPdf, renderPdfPages, countPdfPages, resolvePageIndices } from './io/pdf.js';
import { convertOffice, convertOfficeBatch, isOfficeDocument } from './io/office.js';
import { imagesToPdf } from './io/images-pdf.js';
import type { AlphaMode, QualityReport, RasterFormat, RasterImage, Rgba, SizeBudgetReport } from './types.js';

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

/**
 * A byte size, written the way people say it: `40000`, `40KB`, `1.5MB`.
 * Decimal units (KB = 1000) because that is what a "40 KB page budget" means.
 */
function byteSizeArg(value: string): number {
  const m = value.trim().match(/^([\d.]+)\s*(b|kb|mb)?$/i);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('--max-bytes must be a positive size, e.g. 40000, 40KB or 1.5MB.');
  }
  const scale = { b: 1, kb: 1000, mb: 1_000_000 }[(m![2] ?? 'b').toLowerCase()]!;
  return Math.round(n * scale);
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

/** `--palette` is a comma-separated list of colours to trace to exactly. */
function paletteArg(value: string): Rgba[] {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const out = parts.map((p) => {
    const c = parseCssColor(p);
    if (!c) throw new InvalidArgumentError(`Unrecognised colour in --palette: ${p}`);
    return c;
  });
  if (out.length === 0) throw new InvalidArgumentError('--palette needs at least one colour');
  return out;
}

/** `--threshold` is a 0–255 cutoff or the literal `auto`. */
function thresholdArg(value: string): number | 'auto' {
  if (value.toLowerCase() === 'auto') return 'auto';
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new InvalidArgumentError('--threshold must be an integer 0-255 or "auto".');
  }
  return n;
}

function boolArg(value: string): boolean {
  const v = value.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new InvalidArgumentError('expected true or false.');
}

/** `--resize 800x600`, `--resize 800x`, `--resize x600`. */
function sizeArg(value: string): { width?: number; height?: number } {
  const m = /^(\d*)x(\d*)$/i.exec(value.trim());
  if (!m || (!m[1] && !m[2])) {
    throw new InvalidArgumentError('expected WIDTHxHEIGHT, e.g. 800x600, 800x, or x600.');
  }
  return { width: m[1] ? Number(m[1]) : undefined, height: m[2] ? Number(m[2]) : undefined };
}

/** `--crop x,y,w,h`. */
function cropArg(value: string): { left: number; top: number; width: number; height: number } {
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new InvalidArgumentError('expected four non-negative integers: x,y,width,height.');
  }
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3] };
}

async function readInput(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    return fail(`Cannot read ${path}: ${(err as Error).message}`);
  }
}

async function writeOutput(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
}

function defaultOutput(input: string, ext: string, suffix = ''): string {
  const dir = dirname(input);
  const stem = basename(input, extname(input));
  return join(dir, `${stem}${suffix}${ext}`);
}

interface TransparencyCliOptions {
  transparent?: boolean | string;
  bgTolerance?: number;
  bgEverywhere?: boolean;
  feather?: boolean;
}

/**
 * Build background-removal options from the CLI flags, or null when the user
 * did not ask for transparency.
 */
function transparencyOptions(o: TransparencyCliOptions): RemoveBackgroundOptions | null {
  if (!o.transparent) return null;
  let color: Rgba | undefined;
  if (typeof o.transparent === 'string') {
    const parsed = parseCssColor(o.transparent);
    if (!parsed) fail(`Unrecognised colour for --transparent: ${o.transparent}`);
    color = parsed;
  }
  return {
    color,
    tolerance: o.bgTolerance,
    edgesOnly: !o.bgEverywhere,
    feather: o.feather,
  };
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
  primitives?: boolean;
  primitiveError?: number;
  optimize?: boolean;
  optTolerance?: number;
  refineIterations?: number;
  blur?: number;
  blurDelta?: number;
  threshold?: number | 'auto';
  blackOnWhite?: boolean;
  strokeWidth?: number;
  turnPolicy?: string;
  fillStrategy?: string;
  rightAngle?: boolean;
  rightAngleThreshold?: number;
  gradients?: boolean;
  layers?: boolean;
  palette?: Rgba[];
  minify?: boolean;
  precision?: number;
  background: boolean;
  targetSsim?: number;
  maxBytes?: number;
  maxNodes?: number;
  targetPsnr?: number;
  maxColors?: number;
  maxSteps?: number;
  lossless?: boolean;
  prefer?: string;
  maxGeometryRatio?: number;
  transparent?: boolean | string;
  bgTolerance?: number;
  bgEverywhere?: boolean;
  feather?: boolean;
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
    fail(`${input} is already an SVG. Did you mean \`vecline rasterize\`?`);
  }

  let source = await loadRaster(bytes);
  const outPath = o.output ?? defaultOutput(input, '.svg');

  // Knock out the background before vectorising, so the tracer never sees it
  // as a region worth describing.
  const transparency = transparencyOptions(o);
  if (transparency) {
    const removed = removeBackground(source.image, transparency);
    // The original bytes no longer describe these pixels, so embed mode must
    // re-encode rather than preserve them.
    source = {
      image: removed.image,
      meta: { ...source.meta, hasAlpha: true, format: source.meta.format },
      bytes: await encodeRaster(removed.image, { format: 'png' }),
    };
    info(
      `  ${dim('·')} Removed background ` +
        `${removed.detected ? '(detected) ' : ''}` +
        `rgb(${removed.color.r},${removed.color.g},${removed.color.b}) — ` +
        `${removed.removed} pixel(s) now transparent`,
    );
  }

  const result = await vectorize(source, {
    mode: (o.lossless ? 'lossless' : o.mode) as never,
    preset: o.preset as never,
    losslessPrefer: o.prefer as never,
    maxGeometryRatio: o.maxGeometryRatio,
    verify: o.verify,
    targetSsim: o.targetSsim,
    targetPsnr: o.targetPsnr,
    maxBytes: o.maxBytes,
    maxNodes: o.maxNodes,
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
      primitives: o.primitives,
      primitiveError: o.primitiveError,
      // commander stores --no-optimize as optimize:false; leave undefined when
      // the flag was never passed so the default stays in force.
      optimize: o.optimize,
      optimizeError: o.optTolerance,
      refineIterations: o.refineIterations,
      blur: o.blur,
      blurDelta: o.blurDelta,
      threshold: o.threshold,
      blackOnWhite: o.blackOnWhite,
      strokeWidth: o.strokeWidth,
      turnPolicy: o.turnPolicy as never,
      fillStrategy: o.fillStrategy as never,
      rightAngleEnhance: o.rightAngle,
      rightAngleThreshold: o.rightAngleThreshold,
      gradients: o.gradients,
      groupByColor: o.layers,
      fixedPalette: o.palette,
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

  const svg = o.minify ? optimizeSvg(result.svg) : result.svg;
  await writeOutput(outPath, svg);
  const outSize = Buffer.byteLength(svg);

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
  if (result.budget) printBudget(result.budget);
  if (result.quality) printQuality(result.quality);
  else if (result.lossless) info(`\n${bold('Accuracy')}  ${green('bit-exact by construction')} ${dim('(pass --verify to prove it)')}`);
}

/**
 * The budget receipt: what was asked, what was delivered, and what it cost.
 * Printed as a ledger rather than a verdict — the whole point is that the
 * trade-off is visible instead of hidden behind a slider.
 */
function printBudget(b: SizeBudgetReport): void {
  const pct = (a: number, from: number): string =>
    from === 0 ? '' : ` ${dim(`(${a > from ? '+' : ''}${Math.round(((a - from) / from) * 100)}%)`)}`;

  info(`\n${bold('Budget')}  ${b.met ? green('met') : red('not reached')}${b.steps ? dim(`  in ${b.steps} step${b.steps === 1 ? '' : 's'}`) : dim('  (defaults already fit)')}`);
  if (b.targetBytes !== undefined) {
    info(`  size        ${formatBytes(b.baselineBytes)} → ${formatBytes(b.bytes)}${pct(b.bytes, b.baselineBytes)}  ${dim(`target ${formatBytes(b.targetBytes)}`)}`);
  }
  if (b.targetNodes !== undefined) {
    info(`  nodes       ${b.baselineNodes} → ${b.nodes}${pct(b.nodes, b.baselineNodes)}  ${dim(`target ${b.targetNodes}`)}`);
  }
  if (b.ssim !== undefined && b.baselineSsim !== undefined) {
    const cost = b.ssimCost ?? 0;
    const costText = cost >= -1e-6
      ? green('no accuracy lost')
      : `${red(`−${Math.abs(cost).toFixed(4)} SSIM`)} ${dim('paid')}`;
    info(`  accuracy    ${b.baselineSsim.toFixed(4)} → ${b.ssim.toFixed(4)}  ${costText}`);
  }
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
  transparent?: boolean | string;
  bgTolerance?: number;
  bgEverywhere?: boolean;
  feather?: boolean;
  verify?: boolean;
  json?: boolean;
}

async function runRasterize(input: string, o: RasterizeCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (!looksLikeSvg(bytes)) {
    fail(`${input} does not look like an SVG. Did you mean \`vecline vectorize\`?`);
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

  // Applied after rendering, so it works on any SVG rather than only ones with
  // a literal background rectangle.
  const transparency = transparencyOptions(o);
  if (transparency) {
    const removed = removeBackground(
      (await rasterizeSvg(bytes, {
        baseDir: baseDirFor(input), width: o.width, height: o.height, scale: o.scale,
      })).image,
      transparency,
    );
    outcome.buffer = await encodeRaster(removed.image, {
      format: format as RasterFormat,
      quality: o.quality,
      lossless: o.lossless,
      effort: o.effort,
    });
    info(
      removed.removed === 0
        ? `  ${dim('·')} Nothing to remove — the background is already transparent`
        : `  ${dim('·')} Removed background rgb(${removed.color.r},${removed.color.g},` +
            `${removed.color.b}) — ${removed.removed} pixel(s) now transparent`,
    );
  }

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
  tolerance?: number;
  precision?: number;
  width?: number;
  height?: number;
  scale?: number;
  /** Rasterize only: painted under the artwork. */
  background?: Rgba;
  quality?: number;
  lossless?: boolean;
  transparent?: boolean | string;
  bgTolerance?: number;
  bgEverywhere?: boolean;
  feather?: boolean;
  verify?: boolean;
  json?: boolean;
}

function toVectorizeOptions(o: SharedCliOptions, output: string): VectorizeCliOptions {
  return {
    output,
    mode: o.mode ?? 'auto',
    preset: o.preset ?? 'auto',
    colors: o.colors,
    tolerance: o.tolerance,
    precision: o.precision,
    lossless: o.lossless,
    prefer: 'auto',
    transparent: o.transparent,
    bgTolerance: o.bgTolerance,
    bgEverywhere: o.bgEverywhere,
    feather: o.feather,
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
    transparent: o.transparent,
    bgTolerance: o.bgTolerance,
    bgEverywhere: o.bgEverywhere,
    feather: o.feather,
    shapeRendering: 'geometricPrecision',
    textRendering: 'optimizeLegibility',
    imageRendering: 'optimizeQuality',
    verify: o.verify,
    json: o.json,
  };
}

async function runConvert(input: string, output: string, o: SharedCliOptions): Promise<void> {
  const ext = extname(output).toLowerCase();
  if (ext === '.svg') {
    await runVectorize(input, toVectorizeOptions(o, output));
  } else if (ext === '.dxf' || ext === '.eps' || ext === '.pdf') {
    await runVectorExport(input, output, ext, o);
  } else {
    await runRasterize(input, toRasterizeOptions(o, output));
  }
}

/** Raster → a non-SVG vector format (DXF/EPS/PDF) via structured trace geometry. */
async function runVectorExport(
  input: string,
  output: string,
  ext: '.dxf' | '.eps' | '.pdf',
  o: SharedCliOptions,
): Promise<void> {
  const bytes = await readInput(input);
  if (looksLikeSvg(bytes)) {
    fail(`${ext} export needs a raster input; got an SVG. Rasterize it first.`);
  }
  const source = await loadRaster(bytes);
  const geometry = traceGeometry(source.image, { colors: o.colors, tolerance: o.tolerance });
  const cmyk = Boolean((o as SharedCliOptions & { cmyk?: boolean }).cmyk);

  const data: string | Uint8Array =
    ext === '.dxf' ? toDxf(geometry)
      : ext === '.eps' ? toEps(geometry, { cmyk })
        : toPdf(geometry, { cmyk });
  await writeOutput(output, data);

  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (o.json) {
    emitJson({ input, output, format: ext.slice(1), colorPaths: geometry.paths.length, outputBytes: size });
    return;
  }
  info(`${green('✓')} ${bold(basename(output))}  ${dim(`${ext.slice(1).toUpperCase()}  ${geometry.paths.length} colour path(s)  ${formatBytes(size)}`)}`);
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
// diff
// ---------------------------------------------------------------------------

async function runDiff(
  a: string,
  b: string,
  o: { output: string; threshold: number; width?: number; failOver?: number; json?: boolean },
): Promise<void> {
  const [bytesA, bytesB] = await Promise.all([readInput(a), readInput(b)]);
  const loadedA = await loadAnyAsRaster(bytesA, a, { baseDir: baseDirFor(a), width: o.width });
  const loadedB = await loadAnyAsRaster(bytesB, b, {
    baseDir: baseDirFor(b),
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

  const result = diffImages(loadedA.image, loadedB.image, { threshold: o.threshold });
  const quality = compareImages(loadedA.image, loadedB.image);
  const encoded = await encodeRaster(result.image, { format: formatFromExtension(extname(o.output)) ?? 'png' });
  await writeOutput(o.output, encoded);

  const pct = (result.changedFraction * 100).toFixed(3);
  if (o.json) {
    emitJson({
      reference: a, candidate: b, output: o.output,
      changedPixels: result.changedPixels, totalPixels: result.totalPixels,
      changedFraction: result.changedFraction,
      maxDeltaE: result.maxDeltaE, meanDeltaE: result.meanDeltaE,
      ssim: quality.ssim, psnr: quality.psnr,
    });
  } else {
    info(`${bold(basename(a))} ${dim('vs')} ${bold(basename(b))}  ${dim(`${result.totalPixels} px`)}`);
    info(`  ${result.changedPixels === 0 ? green('✓ identical within threshold') : `${red(`${result.changedPixels} changed`)} ${dim(`(${pct}%)`)}`}`);
    info(`  ${dim(`ΔE max ${result.maxDeltaE.toFixed(2)}  mean ${result.meanDeltaE.toFixed(3)}  ·  SSIM ${quality.ssim.toFixed(6)}  ·  heatmap → ${basename(o.output)}`)}`);
  }

  if (o.failOver !== undefined && result.changedFraction > o.failOver) {
    process.stderr.write(
      `${red('fail')} changed fraction ${result.changedFraction.toFixed(6)} exceeds --fail-over ${o.failOver}\n`,
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
    matchesSource = bytesEqual(original, payload.bytes);
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
// edit
// ---------------------------------------------------------------------------

interface EditCliOptions {
  output?: string;
  resize?: { width?: number; height?: number };
  fit?: string;
  rotate?: number;
  flip?: boolean;
  flop?: boolean;
  crop?: { left: number; top: number; width: number; height: number };
  trim?: boolean;
  blur?: number;
  sharpen?: number;
  median?: number;
  clahe?: { width?: number; height?: number };
  gamma?: number;
  grayscale?: boolean;
  negate?: boolean;
  sepia?: boolean;
  normalize?: boolean;
  threshold?: number;
  tint?: Rgba;
  dilate?: number;
  erode?: number;
  brightness?: number;
  saturation?: number;
  hue?: number;
  lightness?: number;
  unflatten?: boolean;
  background?: Rgba;
  quality: number;
  json?: boolean;
}

/** The standard sepia channel mix, applied via a 3×3 recombination. */
const SEPIA_MATRIX: [[number, number, number], [number, number, number], [number, number, number]] = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
];

async function runEdit(input: string, o: EditCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (looksLikeSvg(bytes)) {
    fail(`${input} is an SVG. \`edit\` works on raster images; rasterize it first.`);
  }
  const source = await loadRaster(bytes);

  const clahe = o.clahe?.width && o.clahe?.height
    ? { width: o.clahe.width, height: o.clahe.height }
    : undefined;
  if (o.clahe && !clahe) fail('--clahe needs both dimensions, e.g. 8x8.');

  const chain: OpsChain = {
    resize: o.resize ? { ...o.resize, fit: o.fit as never } : undefined,
    rotate: o.rotate,
    flip: o.flip,
    flop: o.flop,
    crop: o.crop,
    trim: o.trim,
    blur: o.blur,
    sharpen: o.sharpen,
    median: o.median,
    clahe,
    gamma: o.gamma,
    grayscale: o.grayscale,
    negate: o.negate,
    recomb: o.sepia ? SEPIA_MATRIX : undefined,
    normalize: o.normalize,
    threshold: o.threshold,
    tint: o.tint,
    dilate: o.dilate,
    erode: o.erode,
    modulate: (o.brightness || o.saturation || o.hue || o.lightness)
      ? { brightness: o.brightness, saturation: o.saturation, hue: o.hue, lightness: o.lightness }
      : undefined,
    unflatten: o.unflatten,
    flatten: o.background,
  };

  if (!hasOps(chain)) fail('No operation given. See `vecline edit --help`.');

  const edited = await editImage(source.image, chain);

  // Preserve the source format unless the output extension says otherwise.
  const outPath = o.output ?? defaultOutput(input, extname(input) || `.${source.meta.format}`);
  const format = formatFromExtension(extname(outPath)) ?? (source.meta.format as RasterFormat);
  const encoded = await encodeRaster(edited, { format, quality: o.quality });
  await writeOutput(outPath, encoded);

  if (o.json) {
    emitJson({
      input, output: outPath, format,
      from: { width: source.image.width, height: source.image.height },
      to: { width: edited.width, height: edited.height },
      outputBytes: encoded.length,
    });
    return;
  }
  info(
    `${green('✓')} ${bold(basename(outPath))}  ${dim(
      `${source.image.width}×${source.image.height} → ${edited.width}×${edited.height}  ` +
        `${format}  ${formatBytes(encoded.length)}`,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

interface ComponentCliOptions {
  output?: string;
  framework: Framework;
  name: string;
  currentColor?: boolean;
  js?: boolean;
  json?: boolean;
}

const COMPONENT_EXT: Record<Framework, string> = {
  react: 'tsx', solid: 'tsx', vue: 'vue', svelte: 'svelte',
};

async function runComponent(input: string, o: ComponentCliOptions): Promise<void> {
  const bytes = await readInput(input);

  // Accept an SVG directly, or vectorise a raster first.
  const svg = looksLikeSvg(bytes)
    ? new TextDecoder().decode(bytes)
    : (await vectorize(await loadRaster(bytes), { mode: 'trace' })).svg;

  const typescript = !o.js;
  const source = toComponent(svg, {
    framework: o.framework,
    name: o.name,
    currentColor: o.currentColor,
    typescript,
  });

  let ext = COMPONENT_EXT[o.framework];
  if ((o.framework === 'react' || o.framework === 'solid') && !typescript) ext = 'jsx';
  const outPath = o.output ?? `${o.name}.${ext}`;
  await writeOutput(outPath, source);

  if (o.json) {
    emitJson({ input, output: outPath, framework: o.framework, name: o.name, bytes: source.length });
    return;
  }
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`${o.framework} component "${o.name}"  ${formatBytes(source.length)}`)}`);
}

// ---------------------------------------------------------------------------
// animate (GIF/APNG → animated SVG)
// ---------------------------------------------------------------------------

async function runAnimate(
  input: string,
  o: { output?: string; colors: number; maxFrames?: number; fps: number; loop?: boolean; minify?: boolean; json?: boolean },
): Promise<void> {
  const bytes = await readInput(input);
  const result = await traceAnimation(bytes, {
    maxFrames: o.maxFrames,
    fps: o.fps,
    loop: o.loop,
    trace: { colors: o.colors },
  });
  let svg = result.svg;
  if (o.minify) svg = optimizeSvg(svg);

  const outPath = o.output ?? defaultOutput(input, '.svg');
  await writeOutput(outPath, svg);

  if (o.json) {
    emitJson({
      input, output: outPath,
      frames: result.frames, sourceFrames: result.sourceFrames,
      width: result.width, height: result.height,
      duration: result.duration, outputBytes: Buffer.byteLength(svg),
    });
    return;
  }
  const framesNote = result.frames < result.sourceFrames ? `${result.frames}/${result.sourceFrames} frames` : `${result.frames} frames`;
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`${result.width}×${result.height}  ${framesNote}  ${result.duration.toFixed(2)}s loop  ${formatBytes(Buffer.byteLength(svg))}`)}`);
}

// ---------------------------------------------------------------------------
// pdf (combine images → one multi-page PDF)
// ---------------------------------------------------------------------------

async function runImagesToPdf(
  inputs: string[],
  o: { output: string; dpi: number; quality: number; json?: boolean },
): Promise<void> {
  const images: RasterImage[] = [];
  for (const input of inputs) {
    images.push((await loadRaster(await readInput(input))).image);
  }
  const pdf = await imagesToPdf(images, { dpi: o.dpi, quality: o.quality });
  await writeOutput(o.output, pdf);

  if (o.json) {
    emitJson({ output: o.output, pages: images.length, outputBytes: pdf.length });
    return;
  }
  info(`${green('✓')} ${bold(basename(o.output))}  ${dim(`${images.length} page${images.length === 1 ? '' : 's'}  ${formatBytes(pdf.length)}`)}`);
}

// ---------------------------------------------------------------------------
// office (Office ⇄ PDF via the user's LibreOffice)
// ---------------------------------------------------------------------------

async function runOffice(
  inputs: string[],
  o: { output: string; to?: string; soffice?: string; timeout: number; json?: boolean },
): Promise<void> {
  const opts = { soffice: o.soffice, timeoutMs: o.timeout * 1000 };

  // The shape of -o decides the mode: a path with an extension is a single output
  // file; a bare name / directory is batch mode (with --to). This keeps a real
  // filename that contains glob metacharacters (report[1].docx) convertable, and
  // stops `--to pdf -o result.pdf` from creating a *directory* called result.pdf.
  if (extname(o.output)) {
    if (inputs.length !== 1) {
      fail('Writing to a single file (-o with an extension) needs exactly one input. For many inputs, give a directory as -o with --to <fmt>.');
    }
    const res = await convertOffice(inputs[0], o.output, opts);
    if (o.json) { emitJson({ input: inputs[0], output: res.output, engine: res.engine }); return; }
    info(`${green('✓')} ${bold(basename(inputs[0]))} → ${bold(basename(res.output))}  ${dim('(via LibreOffice)')}`);
    return;
  }

  // Batch mode: -o is a directory, --to is the target format.
  if (!o.to) fail('When -o is a directory, give a target format with --to <fmt>, e.g. office "docs/*.docx" --to pdf -o out/');
  // Use an input literally when it exists on disk (so a real filename with
  // [ ] { } converts); only treat it as a glob when the literal does not resolve.
  const files: string[] = [];
  for (const inp of inputs) {
    if (existsSync(inp)) files.push(inp);
    else files.push(...await glob(inp.replace(/\\/g, '/'), { absolute: true, onlyFiles: true }));
  }
  if (files.length === 0) fail(`No files matched: ${inputs.join(', ')}`);

  const results = await convertOfficeBatch(files, o.output, o.to, opts);
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  if (o.json) {
    emitJson({ outDir: o.output, to: o.to, converted: ok.length, failed: failed.length, files: results });
  } else {
    info(`${green('✓')} ${bold(String(ok.length))} document${ok.length === 1 ? '' : 's'} → ${o.to}${failed.length ? `, ${red(`${failed.length} failed`)}` : ''} ${dim(`in ${o.output}  (via LibreOffice)`)}`);
    for (const r of results) info(`  ${r.error ? red(`✗ ${basename(r.input)}: ${r.error}`) : dim(basename(r.output!))}`);
  }
  if (failed.length) process.exit(1);
}

// ---------------------------------------------------------------------------
// doc (PDF / SVG → images, one per page)
// ---------------------------------------------------------------------------

async function runDoc(
  input: string,
  o: { output?: string; format: string; dpi?: number; scale?: number; pages?: string; quality?: number; json?: boolean },
): Promise<void> {
  const bytes = await readInput(input);

  let pages: RasterImage[];
  let labels: number[]; // 1-based page numbers aligned with `pages`, for filenames
  let kind: string;
  if (isPdf(bytes)) {
    const requested = parsePageSpec(o.pages);
    pages = await renderPdfPages(bytes, { dpi: o.dpi, scale: o.scale, pages: requested });
    // Label by the real page number, not the output index — so `--pages 3-5`
    // writes doc-3/doc-4/doc-5, and a later `--pages 1-2` can't overwrite them.
    labels = resolvePageIndices(await countPdfPages(bytes), requested).map((p) => p + 1);
    kind = 'PDF';
  } else if (looksLikeSvg(bytes)) {
    const scale = o.scale ?? (o.dpi ? o.dpi / 96 : 1); // SVG user units are 96 dpi
    const r = await rasterizeSvg(new TextDecoder().decode(bytes), { baseDir: baseDirFor(input), scale });
    pages = [r.image];
    labels = [1];
    kind = 'SVG';
  } else if (isOfficeDocument(input)) {
    // Word/Excel/PowerPoint → PDF (LibreOffice) → images (mupdf), so an Office
    // doc yields one image per page like any other document.
    const tmp = await mkdtemp(join(tmpdir(), 'vecline-doc-'));
    try {
      const tmpPdf = join(tmp, 'render.pdf');
      await convertOffice(input, tmpPdf, {});
      const pdfBytes = await readFile(tmpPdf);
      const requested = parsePageSpec(o.pages);
      pages = await renderPdfPages(pdfBytes, { dpi: o.dpi, scale: o.scale, pages: requested });
      labels = resolvePageIndices(await countPdfPages(pdfBytes), requested).map((p) => p + 1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    kind = 'Office';
  } else {
    fail('`doc` renders a PDF, SVG or Office document (docx/xlsx/pptx/…) to images. For a raster image use `vecline vectorize` or `vecline edit`.');
    return;
  }
  if (pages.length === 0) fail('No pages to render (check --pages).');

  const format = o.format;
  const toSvg = format === 'svg';
  const outDir = o.output ?? dirname(resolve(input));
  await mkdir(outDir, { recursive: true });
  const stem = basename(input, extname(input));
  const multi = pages.length > 1;

  const written: Array<{ file: string; width: number; height: number }> = [];
  for (let i = 0; i < pages.length; i++) {
    const name = multi ? `${stem}-${labels[i]}.${format}` : `${stem}.${format}`;
    if (toSvg) {
      // Vectorise the rendered page — turn a raster/scanned PDF into real SVG.
      // Round-trip through PNG so the vectoriser gets proper metadata and bytes
      // (auto mode may pick embed on a photographic page, which needs them).
      const png = await encodeRaster(pages[i], { format: 'png' });
      const r = await vectorize(await loadRaster(png), { mode: 'auto' });
      await writeOutput(join(outDir, name), r.svg);
    } else {
      await writeOutput(join(outDir, name), await encodeRaster(pages[i], { format: format as RasterFormat, quality: o.quality }));
    }
    written.push({ file: name, width: pages[i].width, height: pages[i].height });
  }

  if (o.json) {
    emitJson({ input, kind, pages: written.length, outDir, files: written });
    return;
  }
  info(`${green('✓')} ${dim(kind)} ${bold(basename(input))} → ${bold(String(written.length))} image${written.length === 1 ? '' : 's'} ${dim(`in ${outDir}`)}`);
  for (const w of written) info(`  ${dim(`${w.file}  ${w.width}×${w.height}`)}`);
}

/** Parse a 1-based page spec like "1,3-5" into 0-based indices. */
function parsePageSpec(spec?: string): number[] | undefined {
  if (!spec) return undefined;
  // No real document has this many pages; the cap stops a typo like "1-9999999999"
  // from materialising a multi-gigabyte array before the renderer clamps it.
  const MAX = 100_000;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(Math.max(a, b), lo + MAX);
    for (let p = lo; p <= hi && out.length < MAX; p++) out.push(p - 1);
  }
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// crop (content-aware)
// ---------------------------------------------------------------------------

async function runCrop(
  input: string,
  o: { output?: string; aspect: string; width?: number; height?: number; minScale?: number; quality?: number; json?: boolean },
): Promise<void> {
  const source = await loadRaster(await readInput(input));
  const aspect = parseAspect(o.aspect, o.width, o.height);

  const rect = smartCrop(source.image, {
    aspect,
    minScale: o.minScale,
  });
  let out = cropImage(source.image, rect);

  // If both dimensions are given, deliver them exactly by resizing the crop.
  if (o.width && o.height) {
    out = await editImage(out, { resize: { width: o.width, height: o.height, fit: 'fill' } });
  }

  const outPath = o.output ?? defaultOutput(input, extname(input) || `.${source.meta.format}`, '-crop');
  const format = formatFromExtension(extname(outPath)) ?? (source.meta.format as RasterFormat);
  const encoded = await encodeRaster(out, { format, quality: o.quality });
  await writeOutput(outPath, encoded);

  if (o.json) {
    emitJson({
      input, output: outPath, format,
      from: { width: source.image.width, height: source.image.height },
      crop: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      to: { width: out.width, height: out.height },
      outputBytes: encoded.length,
    });
    return;
  }
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`${source.image.width}×${source.image.height} → crop ${rect.width}×${rect.height} @ (${rect.x},${rect.y}) → ${out.width}×${out.height}  ${formatBytes(encoded.length)}`)}`);
}

/** Parse "16:9" / "1.5" into a width/height ratio, or derive it from w×h. */
function parseAspect(spec: string, w?: number, h?: number): [number, number] {
  if (w && h) return [w, h];
  const m = spec.match(/^\s*([\d.]+)\s*[:x/]\s*([\d.]+)\s*$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const single = Number(spec);
  if (Number.isFinite(single) && single > 0) return [single, 1];
  fail(`Invalid --aspect "${spec}". Use forms like 1:1, 16:9, 4:5, or a number.`);
  return [1, 1]; // unreachable; fail() throws
}

// ---------------------------------------------------------------------------
// sprite
// ---------------------------------------------------------------------------

async function runSprite(
  inputs: string[],
  o: { output: string; minify?: boolean; json?: boolean },
): Promise<void> {
  const items: Array<{ id: string; svg: string }> = [];
  for (const input of inputs) {
    const bytes = await readInput(input);
    const id = basename(input, extname(input)).replace(/[^\w-]/g, '-');
    const svg = looksLikeSvg(bytes)
      ? new TextDecoder().decode(bytes)
      : (await vectorize(await loadRaster(bytes), { mode: 'auto' })).svg;
    items.push({ id, svg });
  }
  let sprite = svgSprite(items);
  if (o.minify) sprite = optimizeSvg(sprite);
  await writeOutput(o.output, sprite);

  if (o.json) {
    emitJson({ output: o.output, symbols: items.map((i) => i.id), outputBytes: Buffer.byteLength(sprite) });
    return;
  }
  info(`${green('✓')} ${bold(basename(o.output))}  ${dim(`${items.length} symbols  ${formatBytes(Buffer.byteLength(sprite))}`)}`);
  info(`  ${dim('use:')} <svg><use href="#${items[0]?.id ?? 'icon'}"/></svg>`);
}

// ---------------------------------------------------------------------------
// optimize
// ---------------------------------------------------------------------------

async function runOptimize(
  input: string,
  o: { output?: string; precision: number; json?: boolean },
): Promise<void> {
  const bytes = await readInput(input);
  if (!looksLikeSvg(bytes)) fail(`${input} is not an SVG.`);
  const before = new TextDecoder().decode(bytes);
  const after = optimizeSvg(before, { precision: o.precision });
  const outPath = o.output ?? defaultOutput(input, '.min.svg');
  await writeOutput(outPath, after);

  const saved = Buffer.byteLength(before) - Buffer.byteLength(after);
  const pct = ((saved / Buffer.byteLength(before)) * 100).toFixed(1);
  if (o.json) {
    emitJson({ input, output: outPath, before: Buffer.byteLength(before), after: Buffer.byteLength(after), savedPct: +pct });
    return;
  }
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`${formatBytes(Buffer.byteLength(before))} → ${formatBytes(Buffer.byteLength(after))}  (−${pct}%)`)}`);
}

// ---------------------------------------------------------------------------
// centerline
// ---------------------------------------------------------------------------

interface CenterlineCliOptions {
  output?: string;
  threshold?: number | 'auto';
  whiteOnBlack?: boolean;
  strokeWidth: number;
  stroke: string;
  simplify: number;
  minLength: number;
  json?: boolean;
}

async function runCenterline(input: string, o: CenterlineCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (looksLikeSvg(bytes)) fail(`${input} is already an SVG.`);
  const source = await loadRaster(bytes);
  const out = centerlineTrace(source.image, {
    threshold: o.threshold,
    blackOnWhite: !o.whiteOnBlack,
    strokeWidth: o.strokeWidth,
    stroke: o.stroke,
    simplify: o.simplify,
    minLength: o.minLength,
    generator: `Generated by vecline v${VERSION}`,
    title: suggestTitle(input),
  });
  const outPath = o.output ?? defaultOutput(input, '.svg');
  await writeOutput(outPath, out.svg);

  if (o.json) {
    emitJson({ input, output: outPath, paths: out.paths, outputBytes: Buffer.byteLength(out.svg) });
    return;
  }
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`centreline  ${out.paths} stroke path(s)  ${formatBytes(Buffer.byteLength(out.svg))}`)}`);
}

// ---------------------------------------------------------------------------
// gcode
// ---------------------------------------------------------------------------

interface GcodeCliOptions {
  output?: string;
  tool: 'laser' | 'pen';
  feed: number;
  power: number;
  scale: number;
  units: 'mm' | 'in';
  threshold?: number | 'auto';
  whiteOnBlack?: boolean;
  simplify: number;
  json?: boolean;
}

async function runGcode(input: string, o: GcodeCliOptions): Promise<void> {
  const bytes = await readInput(input);
  if (looksLikeSvg(bytes)) fail(`${input} is an SVG; G-code export needs a raster line drawing.`);
  const source = await loadRaster(bytes);
  const polylines = centerlinePolylines(source.image, {
    threshold: o.threshold,
    blackOnWhite: !o.whiteOnBlack,
    simplify: o.simplify,
  });
  const gcode = toGcode(polylines, {
    mode: o.tool, feed: o.feed, power: o.power, scale: o.scale, units: o.units,
    height: source.image.height,
  });
  const outPath = o.output ?? defaultOutput(input, '.gcode');
  await writeOutput(outPath, gcode);

  if (o.json) {
    emitJson({ input, output: outPath, tool: o.tool, paths: polylines.length, outputBytes: Buffer.byteLength(gcode) });
    return;
  }
  info(`${green('✓')} ${bold(basename(outPath))}  ${dim(`${o.tool} G-code  ${polylines.length} toolpath(s)  ${formatBytes(Buffer.byteLength(gcode))}`)}`);
}

// ---------------------------------------------------------------------------
// favicon / responsive / placeholder / palette
// ---------------------------------------------------------------------------

async function runFavicon(
  input: string,
  o: { outDir: string; name: string; themeColor: string; backgroundColor: string; json?: boolean },
): Promise<void> {
  const source = await loadRaster(await readInput(input));
  const set = await faviconSet(source.image, {
    name: o.name, themeColor: o.themeColor, backgroundColor: o.backgroundColor,
  });
  await mkdir(o.outDir, { recursive: true });
  for (const f of set.files) await writeFile(join(o.outDir, f.name), f.bytes);
  await writeFile(join(o.outDir, 'favicon.html'), set.html);

  if (o.json) {
    emitJson({ input, outDir: o.outDir, files: set.files.map((f) => f.name), html: set.html });
    return;
  }
  info(`${green('✓')} ${bold(`${set.files.length} icon files`)} ${dim(`→ ${o.outDir}`)}`);
  for (const f of set.files) info(`  ${dim('·')} ${f.name}  ${dim(formatBytes(f.bytes.length))}`);
  info(`\n${dim('Paste into <head>:')}\n${set.html}`);
}

async function runResponsive(
  input: string,
  o: { outDir: string; widths: string; formats: string; quality: number; alt: string; json?: boolean },
): Promise<void> {
  const source = await loadRaster(await readInput(input));
  const widths = o.widths.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  const formats = o.formats.split(',').map((s) => s.trim()).filter(Boolean) as RasterFormat[];
  const set = await responsiveSet(source.image, {
    widths, formats, quality: o.quality, alt: o.alt, name: basename(input, extname(input)),
  });
  await mkdir(o.outDir, { recursive: true });
  for (const v of set.variants) await writeFile(join(o.outDir, v.name), v.bytes);

  if (o.json) {
    emitJson({ input, outDir: o.outDir, variants: set.variants.map((v) => ({ name: v.name, width: v.width, bytes: v.bytes.length })), html: set.html });
    return;
  }
  info(`${green('✓')} ${bold(`${set.variants.length} variants`)} ${dim(`→ ${o.outDir}`)}`);
  info(`\n${dim('Markup:')}\n${set.html}`);
}

async function runPlaceholder(
  input: string,
  o: { format: 'blurhash' | 'svg'; output?: string; json?: boolean },
): Promise<void> {
  const source = await loadRaster(await readInput(input));
  const value = o.format === 'svg' ? lqipSvg(source.image) : blurHash(source.image);

  if (o.output) await writeOutput(o.output, value);
  if (o.json) {
    emitJson({ input, format: o.format, value, bytes: Buffer.byteLength(value) });
    return;
  }
  if (o.output) info(`${green('✓')} ${bold(basename(o.output))}  ${dim(`${o.format}  ${formatBytes(Buffer.byteLength(value))}`)}`);
  else process.stdout.write(`${value}\n`);
}

async function runPalette(
  input: string,
  o: { colors: number; css?: boolean; json?: boolean },
): Promise<void> {
  const source = await loadRaster(await readInput(input));
  const palette = extractPalette(source.image, o.colors);

  if (o.json) {
    emitJson({ input, palette });
    return;
  }
  if (o.css) {
    process.stdout.write(paletteToCssVars(palette));
    return;
  }
  info(`${bold(basename(input))}  ${dim(`${palette.length} colours`)}`);
  for (const e of palette) info(`  ${e.hex}  ${dim(`${(e.weight * 100).toFixed(1)}%`)}`);
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
  summary?: string;
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
  const rows: Array<{ file: string; target: string; inBytes: number; outBytes: number }> = [];
  // A recursive glob can match same-named files in different directories; keying
  // the output only on basename would silently overwrite. Reserve a unique target
  // synchronously per file so concurrent workers never collide.
  const usedTargets = new Set<string>();
  const ext = o.to.replace(/^\./, '');
  const uniqueTarget = (file: string): string => {
    const stem = basename(file, extname(file));
    let target = join(o.outDir, `${stem}.${ext}`);
    for (let k = 2; usedTargets.has(target); k++) target = join(o.outDir, `${stem}-${k}.${ext}`);
    usedTargets.add(target);
    return target;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const target = uniqueTarget(file);
      try {
        if (o.to.replace(/^\./, '') === 'svg') {
          await runVectorize(file, toVectorizeOptions(o, target));
        } else {
          await runRasterize(file, toRasterizeOptions(o, target));
        }
        done++;
        if (o.summary) {
          const [inS, outS] = await Promise.all([stat(file), stat(target)]);
          rows.push({ file: basename(file), target: basename(target), inBytes: inS.size, outBytes: outS.size });
        }
      } catch (err) {
        failed++;
        info(`${red('✗')} ${file}: ${(err as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  info(`\n${done} succeeded, ${failed} failed.`);
  if (o.summary) await writeFile(o.summary, formatBatchSummary(rows, done, failed));
  if (failed > 0) process.exit(1);
}


// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('vecline')
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
  .option('--primitives', 'recognise circles, ellipses, rectangles and rounded rectangles and emit <circle>/<ellipse>/<rect>/<rect rx> — smaller, editable, render-preserving')
  .option('--primitive-error <px>', 'per-vertex residual budget for --primitives', floatArg('--primitive-error', 0.1, 10))
  .option('--no-optimize', 'do not merge adjacent curves that a single curve fits')
  .option('--opt-tolerance <n>', 'error budget for a curve merge (defaults to --fit-error)', floatArg('--opt-tolerance', 0.01, 100))
  .option('--refine-iterations <n>', 'Lloyd relaxation passes during palette construction', intArg('--refine-iterations', 0, 32))
  .option('--blur <radius>', 'selective (edge-preserving) blur before quantisation, 1-5', intArg('--blur', 0, 5))
  .option('--blur-delta <n>', 'edge-preservation threshold for --blur', intArg('--blur-delta', 0, 255))
  .option('--threshold <cutoff>', 'reduce to two colours by luminance: a 0-255 number or "auto" (Otsu)', thresholdArg)
  .option('--black-on-white <bool>', 'with --threshold: dark pixels are the shape (default true)', boolArg)
  .option('--stroke-width <n>', 'stroke each path in its fill colour to hide seams between regions', floatArg('--stroke-width', 0, 100))
  .addOption(
    new Option('--turn-policy <policy>', 'how to resolve diagonal self-touches (checkerboard saddles)')
      .choices(['left', 'right', 'black', 'white', 'minority', 'majority']),
  )
  .addOption(
    new Option('--fill-strategy <how>', 'how each palette colour is picked from its cluster')
      .choices(['mean', 'dominant', 'median']),
  )
  .option('--right-angle', 'snap near-axis right-angle corners to exact 90° (crisper UI/pixel art)')
  .option('--right-angle-threshold <deg>', 'degrees of slack for --right-angle', floatArg('--right-angle-threshold', 0, 45))
  .option('--gradients', 'reconstruct smooth colour ramps as SVG gradients — de-bands photos, only where it measurably beats flat')
  .option('--layers', 'emit one named Inkscape/Illustrator layer per colour (editable, screen-print/vinyl separation-ready)')
  .option('--palette <colors>', 'trace to exactly these comma-separated colours (brand/spot colours), e.g. "#fff,#e4002b,#000"', paletteArg)
  .option('--minify', 'minify the output SVG (render-preserving: round coords, strip defaults)')
  .option('--precision <n>', 'decimals kept in path coordinates', intArg('--precision', 0, 8))
  .option('--no-background', 'do not collapse the dominant colour into one rectangle')
  .option('--target-ssim <v>', 'escalate settings until SSIM reaches this', floatArg('--target-ssim', 0, 1))
  .option('--target-psnr <db>', 'escalate settings until PSNR reaches this', floatArg('--target-psnr', 0, 200))
  .option('--max-bytes <size>', 'size budget: relax until the SVG fits, and report the accuracy it cost (e.g. 40KB)', byteSizeArg)
  .option('--max-nodes <n>', 'complexity budget: relax until the geometry has at most this many anchor points', intArg('--max-nodes', 4, 10_000_000))
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
  .option('-t, --transparent [color]', 'make the background transparent; detects the colour when omitted')
  .option('--bg-tolerance <n>', 'how far a pixel may sit from the background colour (Oklab distance)', floatArg('--bg-tolerance', 0, 1))
  .option('--bg-everywhere', 'remove matching pixels anywhere, not just those reachable from the edge')
  .option('--feather', 'fade the cut instead of a hard edge')
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
  .option('--effort <n>', 'encoder effort (PNG 0-9, WebP 0-6, AVIF 0-9)', intArg('--effort', 0, 10))
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
  .option('-t, --transparent [color]', 'make the background transparent; detects the colour when omitted')
  .option('--bg-tolerance <n>', 'how far a pixel may sit from the background colour (Oklab distance)', floatArg('--bg-tolerance', 0, 1))
  .option('--bg-everywhere', 'remove matching pixels anywhere, not just those reachable from the edge')
  .option('--feather', 'fade the cut instead of a hard edge')
  .option('--verify', 're-decode the encoded file and report what the encoder cost')
  .option('--json', 'machine-readable output on stdout')
  .action(runRasterize);

program
  .command('pdf')
  .description('Combine images into one multi-page PDF — one image per page')
  .argument('<inputs...>', 'source images (PNG/JPEG/WebP/…)')
  .requiredOption('-o, --output <file>', 'output PDF path')
  .option('--dpi <n>', 'page resolution used to size each page (pixels per inch)', intArg('--dpi', 12, 1200), 96)
  .option('-q, --quality <n>', 'JPEG quality for the embedded page images', intArg('--quality', 1, 100), 85)
  .option('--json', 'machine-readable output')
  .action(runImagesToPdf);

program
  .command('office')
  .description('Convert Office documents ⇄ PDF (and between Office formats) via your local LibreOffice — nothing bundled, install stays tiny')
  .argument('<inputs...>', 'source document(s) or glob(s): docx, xlsx, pptx, odt, ods, odp, rtf, html, csv, txt, or pdf')
  .requiredOption('-o, --output <path>', 'output file (single) — or output directory when --to is given (batch)')
  .option('--to <fmt>', 'target format for batch mode (e.g. pdf, docx); writes <outdir>/<stem>.<fmt> for each input')
  .option('--soffice <path>', 'path to the LibreOffice soffice binary (else auto-detected, or set $VECLINE_SOFFICE)')
  .option('--timeout <s>', 'conversion timeout in seconds', intArg('--timeout', 1, 3600), 120)
  .option('--json', 'machine-readable output')
  .action(runOffice);

program
  .command('doc')
  .description('Render a document (PDF, SVG, or Office docx/xlsx/pptx) to images — one file per page')
  .argument('<input>', 'source PDF or SVG')
  .option('-o, --output <dir>', 'output directory (default: alongside the input)')
  .option('-f, --format <fmt>', 'output per page: png (default), jpeg, webp, avif, tiff — or svg to vectorise each page', 'png')
  .option('--dpi <n>', 'render resolution in DPI (overrides --scale)', intArg('--dpi', 12, 1200))
  .option('--scale <n>', 'scale relative to native size', floatArg('--scale', 0.1, 20))
  .option('--pages <spec>', 'pages to render, 1-based, e.g. "1,3-5" (PDF only)')
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100))
  .option('--json', 'machine-readable output on stdout')
  .action(runDoc);

program
  .command('edit')
  .description('Edit a raster image — resize, rotate, crop, and tone adjustments')
  .argument('<input>', 'source raster image')
  .option('-o, --output <file>', 'output path (defaults to editing in the same format)')
  .option('--resize <WxH>', 'resize, e.g. 800x600, 800x, or x600', sizeArg)
  .addOption(
    new Option('--fit <mode>', 'how resize reconciles a differing aspect ratio')
      .choices(['cover', 'contain', 'fill', 'inside', 'outside']),
  )
  .option('--rotate <deg>', 'rotate clockwise; multiples of 90 are lossless', floatArg('--rotate', -360, 360))
  .option('--flip', 'mirror top-to-bottom')
  .option('--flop', 'mirror left-to-right')
  .option('--crop <x,y,w,h>', 'crop to a pixel region', cropArg)
  .option('--trim', 'auto-crop a uniform border')
  .option('--blur <sigma>', 'Gaussian blur', floatArg('--blur', 0.3, 100))
  .option('--sharpen <sigma>', 'unsharp mask', floatArg('--sharpen', 0.3, 100))
  .option('--median <size>', 'median filter — denoise without softening edges', intArg('--median', 1, 1000))
  .option('--clahe <WxH>', 'contrast-limited adaptive histogram equalisation, e.g. 8x8', sizeArg)
  .option('--gamma <g>', 'gamma correction, 1.0-3.0', floatArg('--gamma', 1, 3))
  .option('--grayscale', 'desaturate to greyscale')
  .option('--negate', 'photographic negative')
  .option('--sepia', 'sepia tone (a 3×3 channel recombination)')
  .option('--normalize', 'stretch contrast to the full range')
  .option('--threshold <n>', 'binarise at this luminance, 0-255', intArg('--threshold', 0, 255))
  .option('--tint <color>', 'tint toward a colour, preserving alpha', colorArg)
  .option('--dilate <px>', 'grow foreground (morphological dilation)', intArg('--dilate', 1, 100))
  .option('--erode <px>', 'shrink foreground (morphological erosion)', intArg('--erode', 1, 100))
  .option('--brightness <factor>', 'brightness multiplier (1 = unchanged)', floatArg('--brightness', 0, 10))
  .option('--saturation <factor>', 'saturation multiplier (1 = unchanged)', floatArg('--saturation', 0, 10))
  .option('--hue <deg>', 'hue rotation in degrees', floatArg('--hue', -360, 360))
  .option('--lightness <n>', 'additive lightness', floatArg('--lightness', -100, 100))
  .option('--unflatten', 'make pure-white pixels transparent')
  .option('-b, --background <color>', 'flatten transparency onto this colour', colorArg)
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('--json', 'machine-readable output on stdout')
  .action(runEdit);

program
  .command('component')
  .description('Convert a raster image (or SVG) into a framework component (React/Vue/Svelte/Solid)')
  .argument('<input>', 'source image or SVG')
  .option('-o, --output <file>', 'output path (defaults to <Name>.<ext>)')
  .addOption(
    new Option('-f, --framework <fw>', 'target framework')
      .choices(['react', 'vue', 'svelte', 'solid'])
      .default('react'),
  )
  .option('-n, --name <name>', 'component name', 'Icon')
  .option('--current-color', 'use currentColor for solid fills so CSS `color` drives it')
  .option('--js', 'emit JavaScript instead of TypeScript')
  .option('--json', 'machine-readable output on stdout')
  .action(runComponent);

program
  .command('centerline')
  .description('Trace line art to single-stroke centreline paths (plotter/laser/CNC/signature)')
  .argument('<input>', 'source image (line art / drawing)')
  .option('-o, --output <file>', 'output SVG path (defaults to <input>.svg)')
  .option('--threshold <cutoff>', 'binarise cutoff 0-255 or "auto" (Otsu)', thresholdArg)
  .option('--white-on-black', 'the line is light on a dark ground')
  .option('--stroke-width <n>', 'stroke width in px', floatArg('--stroke-width', 0.1, 100), 1)
  .option('--stroke <color>', 'stroke colour', '#000')
  .option('--simplify <px>', 'Douglas-Peucker tolerance', floatArg('--simplify', 0, 100), 1)
  .option('--min-length <px>', 'drop strokes shorter than this', floatArg('--min-length', 0, 1000), 3)
  .option('--json', 'machine-readable output on stdout')
  .action(runCenterline);

program
  .command('sprite')
  .description('Pack many images/SVGs into one <symbol> sprite sheet (referenced via <use href="#id">)')
  .argument('<inputs...>', 'source images or SVGs')
  .option('-o, --output <file>', 'output sprite path', 'sprite.svg')
  .option('--minify', 'minify the sheet')
  .option('--json', 'machine-readable output on stdout')
  .action(runSprite);

program
  .command('crop')
  .description('Content-aware crop to an aspect ratio — keeps the interesting subject, not the centre')
  .argument('<input>', 'source image')
  .option('-o, --output <file>', 'output path (default <input>-crop.<ext>)')
  .option('-a, --aspect <w:h>', 'target aspect ratio, e.g. 1:1, 16:9, 4:5', '1:1')
  .option('-w, --width <px>', 'exact output width', intArg('--width', 1, 1e5))
  .option('-h, --height <px>', 'exact output height', intArg('--height', 1, 1e5))
  .option('--min-scale <n>', 'smallest window as a fraction of the max fitting window', floatArg('--min-scale', 0.1, 1))
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100))
  .option('--json', 'machine-readable output on stdout')
  .action(runCrop);

program
  .command('animate')
  .description('Trace an animated GIF/APNG into one CSS-animated SVG (shared palette, no JS)')
  .argument('<input>', 'animated GIF or APNG')
  .option('-o, --output <file>', 'output SVG path (default <input>.svg)')
  .option('-c, --colors <n>', 'palette size shared across frames', intArg('--colors', 2, 256), 16)
  .option('--max-frames <n>', 'cap frames (sampled evenly) to bound size', intArg('--max-frames', 1, 1000))
  .option('--fps <n>', 'playback rate when the source carries no delays', floatArg('--fps', 0.1, 60), 10)
  .option('--no-loop', 'freeze on the first frame (no animation)')
  .option('--minify', 'minify the assembled SVG')
  .option('--json', 'machine-readable output on stdout')
  .action(runAnimate);

program
  .command('optimize')
  .alias('minify')
  .description('Minify an SVG (strip prologue/comments, round coordinates, drop defaults) — render-preserving')
  .argument('<input>', 'source SVG')
  .option('-o, --output <file>', 'output path (defaults to overwriting a copy)')
  .option('--precision <n>', 'decimals to keep', intArg('--precision', 0, 8), 2)
  .option('--json', 'machine-readable output on stdout')
  .action(runOptimize);

program
  .command('mcp')
  .description('Start the MCP server (stdio), exposing vecline as tools for AI agents/IDEs')
  .action(() => { startMcpServer(); });

program
  .command('gcode')
  .description('Generate G-code toolpaths from line art (laser/pen plotter, GRBL-style)')
  .argument('<input>', 'source image (line art)')
  .option('-o, --output <file>', 'output .gcode/.nc path (defaults to <input>.gcode)')
  .addOption(new Option('--tool <mode>', 'machine mode').choices(['laser', 'pen']).default('laser'))
  .option('--feed <n>', 'cutting/drawing feed rate', floatArg('--feed', 1, 100000), 1000)
  .option('--power <n>', 'laser power (S value)', floatArg('--power', 0, 100000), 1000)
  .option('--scale <n>', 'units per pixel', floatArg('--scale', 0.0001, 1000), 1)
  .addOption(new Option('--units <u>', 'measurement units').choices(['mm', 'in']).default('mm'))
  .option('--threshold <cutoff>', 'binarise cutoff 0-255 or "auto"', thresholdArg)
  .option('--white-on-black', 'the line is light on a dark ground')
  .option('--simplify <px>', 'path simplification tolerance', floatArg('--simplify', 0, 100), 1)
  .option('--json', 'machine-readable output on stdout')
  .action(runGcode);

program
  .command('favicon')
  .description('Generate a full favicon / PWA icon set + manifest + <head> HTML from one image')
  .argument('<input>', 'source image (square works best)')
  .option('-o, --out-dir <dir>', 'output directory', '.')
  .option('-n, --name <name>', 'app name for the manifest', 'App')
  .option('--theme-color <color>', 'manifest theme_color', '#ffffff')
  .option('--background-color <color>', 'manifest background_color', '#ffffff')
  .option('--json', 'machine-readable output on stdout')
  .action(runFavicon);

program
  .command('responsive')
  .description('Generate a responsive image variant set (AVIF/WebP/fallback) + <picture> markup')
  .argument('<input>', 'source image')
  .option('-o, --out-dir <dir>', 'output directory', '.')
  .option('--widths <list>', 'comma-separated target widths', '320,640,960,1280')
  .option('--formats <list>', 'comma-separated formats, best first', 'avif,webp,jpeg')
  .option('-q, --quality <n>', 'lossy quality', intArg('--quality', 1, 100), 74)
  .option('--alt <text>', 'alt text for the <img>', '')
  .option('--json', 'machine-readable output on stdout')
  .action(runResponsive);

program
  .command('placeholder')
  .description('Generate a lazy-load placeholder: BlurHash string, ThumbHash-style, or a tiny LQIP-SVG')
  .argument('<input>', 'source image')
  .addOption(
    new Option('-f, --format <fmt>', 'placeholder kind').choices(['blurhash', 'svg']).default('blurhash'),
  )
  .option('-o, --output <file>', 'write to a file (SVG); otherwise printed to stdout')
  .option('--json', 'machine-readable output on stdout')
  .action(runPlaceholder);

program
  .command('palette')
  .description('Extract a perceptual dominant-colour palette (JSON or CSS custom properties)')
  .argument('<input>', 'source image')
  .option('-c, --colors <n>', 'palette size', intArg('--colors', 1, 64), 6)
  .option('--css', 'emit CSS custom properties instead of JSON')
  .option('--json', 'machine-readable output on stdout')
  .action(runPalette);

program
  .command('convert')
  .description('Convert in whichever direction the file extensions imply (incl. .svg/.dxf/.eps/.pdf out)')
  .argument('<input>')
  .argument('<output>')
  .addOption(
    new Option('-m, --mode <mode>', 'conversion strategy for raster → SVG')
      .choices(['auto', 'lossless', 'pixel', 'trace', 'embed'])
      .default('auto'),
  )
  .addOption(
    new Option('-p, --preset <preset>', 'tuning profile')
      .choices(['auto', ...Object.keys(PRESETS), 'pixelart', 'exact'])
      .default('auto'),
  )
  .option('-c, --colors <n>', 'palette size', intArg('--colors', 1, 256))
  .option('--tolerance <px>', 'outline simplification tolerance', floatArg('--tolerance', 0, 100))
  .option('--precision <n>', 'decimals kept in path coordinates', intArg('--precision', 0, 8))
  .option('-w, --width <px>', 'output width for SVG → raster', intArg('--width', 1, 100000))
  .option('-h, --height <px>', 'output height for SVG → raster', intArg('--height', 1, 100000))
  .option('-s, --scale <factor>', 'uniform zoom', floatArg('--scale', 0.001, 1000))
  .option('-b, --background <color>', 'background colour', colorArg)
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('-l, --lossless', 'guarantee a bit-exact result, or fail')
  .option('-t, --transparent [color]', 'make the background transparent; detects the colour when omitted')
  .option('--bg-tolerance <n>', 'how far a pixel may sit from the background colour (Oklab distance)', floatArg('--bg-tolerance', 0, 1))
  .option('--bg-everywhere', 'remove matching pixels anywhere, not just those reachable from the edge')
  .option('--feather', 'fade the cut instead of a hard edge')
  .option('--cmyk', 'emit CMYK colours for .pdf/.eps output (print/prepress)')
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
  .command('diff')
  .description('Paint a perceptual (CIEDE2000) difference heatmap between two images, for visual regression')
  .argument('<reference>')
  .argument('<candidate>')
  .option('-o, --output <file>', 'heatmap output path (default diff.png)', 'diff.png')
  .option('-t, --threshold <de>', 'CIEDE2000 above which a pixel counts as changed', floatArg('--threshold', 0, 100), 2)
  .option('-w, --width <px>', 'render both at this width first', intArg('--width', 1, 100000))
  .option('--fail-over <fraction>', 'exit non-zero if the changed fraction exceeds this (0-1)', floatArg('--fail-over', 0, 1))
  .option('--json', 'machine-readable output')
  .action(runDiff);

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
  .addOption(
    new Option('-m, --mode <mode>', 'conversion strategy')
      .choices(['auto', 'lossless', 'pixel', 'trace', 'embed'])
      .default('auto'),
  )
  .addOption(
    new Option('-p, --preset <preset>', 'tuning profile')
      .choices(['auto', ...Object.keys(PRESETS), 'pixelart', 'exact'])
      .default('auto'),
  )
  .option('-c, --colors <n>', 'palette size', intArg('--colors', 1, 256))
  .option('-q, --quality <n>', 'lossy encoder quality', intArg('--quality', 1, 100), 92)
  .option('-l, --lossless', 'guarantee a bit-exact result, or fail')
  .option('-t, --transparent [color]', 'make the background transparent; detects the colour when omitted')
  .option('--concurrency <n>', 'parallel workers', intArg('--concurrency', 1, 64), 4)
  .option('--verify', 'measure every result')
  .option('--summary <file>', 'write a Markdown report (sizes + savings) — point it at $GITHUB_STEP_SUMMARY in CI')
  .option('--json', 'machine-readable output')
  .action((patterns: string[], opts: SharedCliOptions & { outDir: string; to: string; concurrency: number }) =>
    runBatch(patterns, opts as unknown as BatchCliOptions),
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${red('error')} ${message}\n`);
  if (process.env.VECLINE_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(`${dim(err.stack)}\n`);
  }
  process.exit(1);
});
