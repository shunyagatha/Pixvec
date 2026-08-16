/**
 * Model Context Protocol (MCP) server for vecline.
 *
 * Exposes vecline's conversion, tracing, export and measurement as tools an AI
 * agent or IDE (Claude, Cursor, Continue, …) can call directly — "vectorise this
 * logo", "turn this drawing into laser G-code", "how close is this SVG to the
 * PNG?" — without the model shelling out and parsing text.
 *
 * A minimal, dependency-free stdio JSON-RPC 2.0 implementation of the MCP
 * handshake (initialize → tools/list → tools/call), so it adds nothing to the
 * install. Node-only: the tools read and write real files.
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { loadRaster, vectorize, measureFlatness, VERSION } from '../api.js';
import { compareImages } from '../metrics/index.js';
import { rasterizeSvg, baseDirFor } from '../io/rasterize.js';
import { decodeRaster, looksLikeSvg } from '../io/decode.js';
import { encodeRaster, formatFromExtension } from '../io/encode.js';
import { centerlineTrace, centerlinePolylines } from '../vectorize/centerline.js';
import { traceGeometry, toDxf, toEps, toPdf, toGcode } from '../io/export/index.js';
import { extractPalette } from '../vectorize/quantize.js';
import { blurHash } from '../placeholder/index.js';
import { diffImages } from '../diff.js';
import { smartCrop, cropImage } from '../crop.js';
import { isPdf, renderPdfPages, countPdfPages, resolvePageIndices } from '../io/pdf.js';
import { isOfficeDocument, convertOffice, findSoffice } from '../io/office.js';
import { imagesToPdf } from '../io/images-pdf.js';
import type { RasterImage, RasterFormat } from '../types.js';

interface Rpc { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; }

const s = (o: Record<string, unknown>): { type: 'object'; properties: Record<string, unknown>; required?: string[] } =>
  ({ type: 'object', ...o } as never);

const TOOLS = [
  {
    name: 'vectorize',
    // Says what this is good at and what it is not, because an agent choosing
    // between tools should not have to discover the limit by shipping a bad
    // result. On flat art (logos, icons, UI, screenshots, pixel art) the output
    // is provably bit-exact — a guarantee no neural vectoriser offers. On
    // photographs it is a deterministic approximation, and a cloud ML tracer
    // will usually look better; saying so here is cheaper than a wrong choice.
    description:
      'Convert a raster image (PNG/JPEG/WebP/…) to SVG, locally and deterministically. '
      + 'BEST FOR flat art — logos, icons, UI, screenshots, pixel art — where `lossless` mode returns '
      + 'vector geometry that rasterises back BIT-EXACT (verified, not asserted). '
      + 'For photographs it produces a measured approximation; a neural cloud vectoriser will often '
      + 'look better, so prefer this when determinism, privacy or provable exactness matter. '
      + 'Auto-picks pixel/trace/embed, or force a mode. Writes to `output` if given, else returns the SVG. '
      + 'Pass `verify: true` to render the SVG back and return SSIM/PSNR/ΔE and whether it is pixel-identical — '
      + 'the proof, in the same call.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the source raster image' },
        output: { type: 'string', description: 'Optional .svg output path' },
        mode: {
          type: 'string', enum: ['auto', 'lossless', 'pixel', 'trace', 'embed'],
          description: 'auto (default) picks per image; pixel/lossless are bit-exact on flat art; '
            + 'trace approximates with paths; embed wraps the original raster losslessly',
        },
        preset: {
          type: 'string', enum: ['auto', 'logo', 'lineart', 'poster', 'photo', 'detailed', 'pixelart', 'exact'],
          description: 'Tuning for the trace path; ignored by pixel and embed modes',
        },
        colors: { type: 'number', description: 'Palette size for trace mode (2–256)' },
        verify: {
          type: 'boolean',
          description: 'Rasterise the result back and measure it. Returns JSON with ssim, psnr, '
            + 'meanDeltaE, pixelIdentical and svgBytes instead of the SVG text. Costs one extra render.',
        },
      },
      required: ['input'],
    }),
  },
  {
    name: 'convert',
    description: 'Convert between formats by extension. Supports raster↔SVG plus vector export to .dxf/.eps/.pdf (CAD/CNC/print).',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the source file (raster or SVG)' },
        output: { type: 'string', description: 'Destination path; its extension chooses the target format' },
        cmyk: { type: 'boolean', description: 'Emit CMYK colour in EPS/PDF output, for print workflows' },
      },
      required: ['input', 'output'],
    }),
  },
  {
    name: 'centerline',
    description: 'Trace line art to single-stroke centreline SVG (for plotters, lasers, CNC). Optionally emit G-code with tool=laser|pen.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the line-art image' },
        output: { type: 'string', description: 'Optional output path; extension should match the format produced' },
        // Not cosmetic: this flag changes what the tool returns, not just how.
        // Undescribed, an agent could ask for an SVG and be handed G-code.
        gcode: { type: 'boolean', description: 'Emit G-code toolpaths instead of an SVG. Changes the output format.' },
        tool: { type: 'string', enum: ['laser', 'pen'], description: 'G-code dialect; only used when gcode is true' },
      },
      required: ['input'],
    }),
  },
  {
    name: 'measure',
    description: 'Measure how close two images (raster or SVG) are: PSNR, SSIM, mean CIEDE2000, and whether they are pixel-identical.',
    inputSchema: s({
      properties: {
        reference: { type: 'string', description: 'Path to the original / expected image (raster or SVG)' },
        candidate: { type: 'string', description: 'Path to the image being scored against the reference' },
      },
      required: ['reference', 'candidate'],
    }),
  },
  {
    name: 'diff',
    description: 'Perceptual visual-regression diff. Paints a CIEDE2000 heatmap of what changed between two images (raster or SVG) and reports changed-pixel count/fraction, max & mean ΔE, and SSIM. Give an output path to save the heatmap.',
    inputSchema: s({
      properties: {
        reference: { type: 'string', description: 'Path to the baseline image (raster or SVG)' },
        candidate: { type: 'string', description: 'Path to the image being compared; must match the reference size' },
        output: { type: 'string', description: 'Optional .png heatmap path' },
        threshold: { type: 'number', description: 'CIEDE2000 above which a pixel counts as changed (default 2)' },
      },
      required: ['reference', 'candidate'],
    }),
  },
  {
    name: 'crop',
    description: 'Content-aware crop to an aspect ratio, keeping the salient subject (edges + saturation) rather than the centre. aspect like "1:1", "16:9", "4:5".',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the image to crop' },
        output: { type: 'string', description: 'Destination path; its extension chooses the encoder' },
        aspect: { type: 'string', description: 'Target ratio as "W:H", e.g. "1:1", "16:9", "4:5". Default "1:1"' },
        width: { type: 'number', description: 'Explicit target width in pixels; an alternative to aspect' },
        height: { type: 'number', description: 'Explicit target height in pixels; an alternative to aspect' },
      },
      required: ['input', 'output'],
    }),
  },
  {
    name: 'palette',
    description: 'Extract a perceptual dominant-colour palette (hex + weight) from an image.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the image to sample' },
        colors: { type: 'number', description: 'How many dominant colours to return (default 6)' },
      },
      required: ['input'],
    }),
  },
  {
    name: 'placeholder',
    description: 'Generate a BlurHash string for lazy-loading a raster image.',
    inputSchema: s({
      properties: { input: { type: 'string', description: 'Path to the raster image to summarise' } },
      required: ['input'],
    }),
  },
  {
    name: 'image_info',
    description:
      'Inspect an image without converting it: dimensions, format, colour space, alpha, distinct colour '
      + 'count and run density — and which vectorize mode suits it, including whether bit-exact output is '
      + 'achievable. Call this first when choosing between `pixel` and `trace`.',
    inputSchema: s({ properties: { input: { type: 'string', description: 'Path to the image to inspect' } }, required: ['input'] }),
  },
  {
    name: 'doc_to_images',
    description: 'Render a document (PDF, SVG, or Office docx/xlsx/pptx) to one image per page. PDF needs the optional mupdf package; Office needs local LibreOffice.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the PDF, SVG or Office document' },
        outDir: { type: 'string', description: 'Directory to write page images into; created if absent' },
        format: { type: 'string', description: 'png (default), jpeg, webp, avif' },
        dpi: { type: 'number', description: 'Render resolution; higher is sharper and slower (default 144)' },
        pages: { type: 'string', description: '1-based page spec, e.g. "1,3-5" (PDF/Office)' },
      },
      required: ['input', 'outDir'],
    }),
  },
  {
    name: 'office_convert',
    description: 'Convert an Office document ⇄ PDF (and between Office formats) via local LibreOffice. Target format is the output file extension.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the source document' },
        output: { type: 'string', description: 'Destination path; its extension chooses the target format' },
      },
      required: ['input', 'output'],
    }),
  },
  {
    name: 'images_to_pdf',
    description: 'Combine images into one multi-page PDF (one image per page).',
    inputSchema: s({
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Image paths, in the page order you want' },
        output: { type: 'string', description: 'Destination .pdf path' },
        dpi: { type: 'number', description: 'Assumed image resolution, which sets the physical page size (default 72)' },
      },
      required: ['inputs', 'output'],
    }),
  },
];

/**
 * Which optional engines are actually present on this machine.
 *
 * Three of the tools need something this package deliberately does not bundle:
 * PDF rendering needs the optional `mupdf`, and the Office paths need the user's
 * own LibreOffice. In a registry's sandbox neither exists, so an agent that
 * discovers the server there would call them and get a bare failure — which
 * reads as "this server is broken" rather than "this machine lacks LibreOffice".
 *
 * Probing once and saying so in the tool description turns a confusing error
 * into information the model can act on: it will pick a different tool, or tell
 * the user what to install, instead of retrying something that cannot work.
 */
let capabilities: { pdf: boolean; office: boolean } | null = null;

async function probeCapabilities(): Promise<{ pdf: boolean; office: boolean }> {
  if (capabilities) return capabilities;
  let pdf = false;
  try {
    await import('mupdf' as string);
    pdf = true;
  } catch { /* not installed; the tool will say so */ }
  capabilities = { pdf, office: findSoffice() !== null };
  return capabilities;
}

/** The tool list, annotated with what this machine can currently do. */
/**
 * Behavioural annotations, per the MCP tool-annotation contract.
 *
 * These let a client decide what needs confirming before it runs: a tool that
 * only reads pixels is safe to call freely, while one that writes to a path the
 * user supplied can overwrite a file that was already there. Every tool here
 * that takes an output path is marked destructive for exactly that reason —
 * "destructive" is about what *could* be lost, not about intent, and claiming
 * otherwise would be the sort of quiet inaccuracy this project exists to avoid.
 */
const ANNOTATIONS: Record<string, { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }> = {
  vectorize: { title: 'Vectorize image to SVG', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  convert: { title: 'Convert between formats', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  centerline: { title: 'Trace centrelines / G-code', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  measure: { title: 'Measure image similarity', readOnlyHint: true },
  diff: { title: 'Perceptual image diff', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  crop: { title: 'Content-aware crop', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  palette: { title: 'Extract colour palette', readOnlyHint: true },
  placeholder: { title: 'Generate BlurHash placeholder', readOnlyHint: true },
  image_info: { title: 'Inspect image metadata', readOnlyHint: true },
  doc_to_images: { title: 'Render document to images', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  office_convert: { title: 'Convert Office document', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  images_to_pdf: { title: 'Combine images into a PDF', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

async function describeTools(): Promise<typeof TOOLS> {
  const cap = await probeCapabilities();
  const missing = (tool: string): string | null => {
    if (tool === 'office_convert' && !cap.office) {
      return 'UNAVAILABLE on this machine: needs LibreOffice (install from libreoffice.org, or set VECLINE_SOFFICE).';
    }
    if (tool === 'doc_to_images' && !cap.pdf && !cap.office) {
      return 'LIMITED on this machine: SVG input works; PDF needs the optional `mupdf` package (npm i mupdf) and Office needs LibreOffice.';
    }
    if (tool === 'doc_to_images' && !cap.pdf) {
      return 'LIMITED on this machine: PDF input needs the optional `mupdf` package (npm i mupdf).';
    }
    if (tool === 'doc_to_images' && !cap.office) {
      return 'LIMITED on this machine: Office input needs LibreOffice (install from libreoffice.org).';
    }
    return null;
  };
  return TOOLS.map((t) => {
    const note = missing(t.name);
    const annotations = ANNOTATIONS[t.name];
    const described = note ? { ...t, description: `${t.description} [${note}]` } : { ...t };
    // `openWorldHint: false` is accurate and worth stating: every tool operates
    // on local files only — none of them reach the network.
    return annotations ? { ...described, annotations: { ...annotations, openWorldHint: false } } : described;
  });
}

/**
 * Largest reply returned inline, in characters.
 *
 * Omitting `output` used to return the whole SVG as text with no ceiling. A
 * trivial four-colour logo came back at 7,723 characters; a photograph traced
 * in this repo is 2,090,768 — roughly half a million tokens, straight into the
 * model's context, from one tool call the agent had no way to know was
 * expensive. Past this size the result goes to a file and the agent is told
 * where, which is the answer it wanted anyway: something it can read a piece of
 * or hand to another tool.
 */
const MAX_INLINE_CHARS = 64_000;

/** How long any one tool call may run before it is abandoned. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Spill an over-large reply to a file rather than into the conversation.
 *
 * Written next to the input when we can, because that is where the agent is
 * already working and where it will look; the system temp directory otherwise.
 */
async function spill(text: string, hint: string, ext: string): Promise<string> {
  const stem = hint ? basename(hint, extname(hint)) : 'vecline';
  const dir = hint ? dirname(resolve(hint)) : tmpdir();
  const out = join(dir, `${stem}.vecline${ext}`);
  await writeFile(out, text);
  return (
    `The result is ${text.length.toLocaleString('en-US')} characters, too large to return inline, ` +
    `so it was written to ${out} instead. Read it from there, or pass an explicit \`output\` path next time.`
  );
}

/**
 * Hold a call to the shape its own schema advertises.
 *
 * Every tool declares `required`, and nothing checked it. A missing argument
 * fell through `String(args.input ?? '')` to the empty string and surfaced as
 * `ENOENT: no such file or directory, open ''` — which tells an agent nothing
 * about what it did wrong, and reads as a broken server rather than a
 * malformed call. A model that gets this error retries the same way.
 *
 * The check is deliberately shallow: presence and non-emptiness, not types.
 * The schemas are the contract an agent already saw, so restating them here in
 * a second, stricter form would mean two places to keep in step.
 */
function assertArgs(name: string, args: Record<string, unknown>): void {
  const tool = TOOLS.find((t) => t.name === name);
  const required = tool?.inputSchema.required ?? [];
  const missing = required.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
      || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) {
    throw new Error(
      `${name} needs ${missing.map((m) => `\`${m}\``).join(' and ')}. `
      + `Required: ${required.join(', ')}.`,
    );
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  assertArgs(name, args);
  const inPath = String(args.input ?? args.reference ?? '');
  switch (name) {
    case 'vectorize': {
      const src = await loadRaster(await readFile(inPath));
      const r = await vectorize(src, {
        mode: (args.mode as never) ?? 'auto',
        preset: (args.preset as never) ?? 'auto',
        trace: args.colors ? { colors: Number(args.colors) } : undefined,
      });

      // "Measured, not asserted" is this project's whole claim, and an agent
      // could not reach it: the tool returned an SVG or a one-line summary and
      // nothing about how close the result actually is. Proving it took a
      // second `measure` call, which needs the SVG on disk first — so the
      // headline guarantee cost three round trips and was usually skipped.
      //
      // Opt-in rather than automatic, because verifying means rasterising the
      // output back and comparing every pixel; an agent converting a folder of
      // icons should not pay for that unasked.
      if (args.verify) {
        const rendered = await rasterizeSvg(r.svg, { baseDir: baseDirFor(inPath) });
        const q = compareImages(src.image, rendered.image);
        if (args.output) await writeFile(String(args.output), r.svg);
        return JSON.stringify({
          output: args.output ?? null,
          mode: r.mode, shapes: r.shapes, colors: r.colors,
          width: src.image.width, height: src.image.height,
          svgBytes: Buffer.byteLength(r.svg, 'utf8'),
          // `lossless` from the converter is what the mode intended; `verified`
          // is what the pixels say after a round trip. They should agree, and
          // reporting both is what makes disagreement visible instead of silent.
          lossless: r.lossless,
          verified: { pixelIdentical: q.lossless, ssim: q.ssim, psnr: q.psnr === Infinity ? 'Infinity' : q.psnr, meanDeltaE: +q.deltaE.mean.toFixed(4) },
        }, null, 2);
      }

      if (args.output) { await writeFile(String(args.output), r.svg); return `Wrote ${args.output} — ${r.mode} mode, ${r.shapes} shapes, ${r.colors} colours, lossless=${r.lossless}. Pass verify:true to measure the result.`; }
      return r.svg.length > MAX_INLINE_CHARS ? spill(r.svg, inPath, '.svg') : r.svg;
    }
    case 'convert': {
      const out = String(args.output);
      const ext = extname(out).toLowerCase();
      const bytes = await readFile(inPath);
      if (ext === '.dxf' || ext === '.eps' || ext === '.pdf') {
        const src = await loadRaster(bytes);
        const g = traceGeometry(src.image, {});
        const cmyk = Boolean(args.cmyk);
        const data = ext === '.dxf' ? toDxf(g) : ext === '.eps' ? toEps(g, { cmyk }) : toPdf(g, { cmyk });
        await writeFile(out, data);
        return `Wrote ${out} (${ext.slice(1).toUpperCase()}, ${g.paths.length} colour paths).`;
      }
      if (ext === '.svg') { const src = await loadRaster(bytes); const r = await vectorize(src, { mode: 'auto' }); await writeFile(out, r.svg); return `Wrote ${out} (SVG, ${r.mode} mode).`; }
      // SVG/raster → raster
      const { image } = looksLikeSvg(bytes) ? await rasterizeSvg(new TextDecoder().decode(bytes), { baseDir: baseDirFor(inPath) }) : await decodeRaster(bytes);
      const { encodeRaster, formatFromExtension } = await import('../io/encode.js');
      const fmt = formatFromExtension(ext) ?? 'png';
      await writeFile(out, await encodeRaster(image, { format: fmt }));
      return `Wrote ${out} (${fmt}, ${image.width}×${image.height}).`;
    }
    case 'centerline': {
      const src = await loadRaster(await readFile(inPath));
      if (args.gcode) {
        const polys = centerlinePolylines(src.image, {});
        const gc = toGcode(polys, { mode: (args.tool as never) ?? 'laser', height: src.image.height });
        const out = String(args.output ?? inPath.replace(/\.[^.]+$/, '.gcode'));
        await writeFile(out, gc);
        return `Wrote ${out} — ${polys.length} toolpaths.`;
      }
      const r = centerlineTrace(src.image, {});
      if (args.output) { await writeFile(String(args.output), r.svg); return `Wrote ${args.output} — ${r.paths} stroke paths.`; }
      return r.svg.length > MAX_INLINE_CHARS ? spill(r.svg, inPath, '.svg') : r.svg;
    }
    case 'measure': {
      const load = async (p: string) => {
        const b = await readFile(p);
        if (looksLikeSvg(b)) return (await rasterizeSvg(new TextDecoder().decode(b), { baseDir: baseDirFor(p) })).image;
        return (await decodeRaster(b)).image;
      };
      const ref = await load(inPath);
      const cand = await load(String(args.candidate));
      const q = compareImages(ref, cand);
      return JSON.stringify({ psnr: q.psnr === Infinity ? 'Infinity' : q.psnr, ssim: q.ssim, deltaE: q.deltaE.mean, lossless: q.lossless }, null, 2);
    }
    case 'diff': {
      const load = async (p: string) => {
        const b = await readFile(p);
        if (looksLikeSvg(b)) return (await rasterizeSvg(new TextDecoder().decode(b), { baseDir: baseDirFor(p) })).image;
        return (await decodeRaster(b)).image;
      };
      const ref = await load(inPath);
      const cand = await load(String(args.candidate));
      if (ref.width !== cand.width || ref.height !== cand.height) {
        throw new Error(`Size mismatch: ${ref.width}×${ref.height} vs ${cand.width}×${cand.height}. Render both at one size first.`);
      }
      const d = diffImages(ref, cand, { threshold: args.threshold !== undefined ? Number(args.threshold) : undefined });
      const q = compareImages(ref, cand);
      if (args.output) {
        const { encodeRaster } = await import('../io/encode.js');
        await writeFile(String(args.output), await encodeRaster(d.image, { format: 'png' }));
      }
      return JSON.stringify({
        changedPixels: d.changedPixels, totalPixels: d.totalPixels,
        changedFraction: +d.changedFraction.toFixed(6),
        maxDeltaE: +d.maxDeltaE.toFixed(3), meanDeltaE: +d.meanDeltaE.toFixed(3),
        ssim: q.ssim, heatmap: args.output ?? null,
      }, null, 2);
    }
    case 'crop': {
      const src = await loadRaster(await readFile(inPath));
      const rect = smartCrop(src.image, { aspect: parseAspectArg(String(args.aspect ?? '1:1'), args.width, args.height) });
      const cropped = cropImage(src.image, rect);
      const out = String(args.output);
      const { encodeRaster, formatFromExtension } = await import('../io/encode.js');
      const fmt = formatFromExtension(extname(out)) ?? 'png';
      await writeFile(out, await encodeRaster(cropped, { format: fmt }));
      return `Wrote ${out} — content-aware crop ${rect.width}×${rect.height} at (${rect.x},${rect.y}) from ${src.image.width}×${src.image.height}.`;
    }
    case 'palette': {
      const src = await loadRaster(await readFile(inPath));
      return JSON.stringify(extractPalette(src.image, Number(args.colors) || 6).map((e) => ({ hex: e.hex, weight: +e.weight.toFixed(3) })), null, 2);
    }
    case 'placeholder': {
      const src = await loadRaster(await readFile(inPath));
      return blurHash(src.image);
    }
    case 'image_info': {
      // The description promised colour count and a recommended strategy and
      // returned neither — four fields, none of them the ones an agent asks
      // this tool for. Deciding between `pixel` (bit-exact) and `trace`
      // (approximate) is the whole reason to inspect an image first, and the
      // CLI's `info` has answered it since v1; this is the same measurement,
      // so the two surfaces cannot drift apart in their advice.
      const { image, meta } = await decodeRaster(await readFile(inPath));
      const flat = measureFlatness(image, 4096);
      const losslessAchievable = !flat.capped && flat.runRatio <= 0.12;
      return JSON.stringify({
        width: image.width,
        height: image.height,
        format: meta.format,
        space: meta.space,
        depth: meta.depth,
        hasAlpha: meta.hasAlpha,
        hasProfile: meta.hasProfile,
        // Counting stops at 4096 — for a photograph the answer is "basically
        // all of them", and the cap is what makes this cheap on large inputs.
        distinctColors: flat.capped ? '>4096' : flat.distinctColors,
        runDensity: +flat.runRatio.toFixed(4),
        recommendedMode: losslessAchievable ? 'pixel' : 'trace',
        losslessAchievable,
        recommendation: losslessAchievable
          ? 'Flat art: `pixel` mode returns geometry that rasterises back bit-exact.'
          : 'Photographic or heavily dithered: `trace` gives a measured approximation, '
            + '`embed` stays exact but wraps the original raster.',
      }, null, 2);
    }
    case 'doc_to_images': {
      const bytes = new Uint8Array(await readFile(inPath));
      const outDir = String(args.outDir);
      const format = (args.format ? String(args.format) : 'png') as RasterFormat;
      const dpi = args.dpi !== undefined ? Number(args.dpi) : undefined;
      const requested = parsePageSpecRpc(args.pages !== undefined ? String(args.pages) : undefined);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });

      let images: RasterImage[];
      let labels: number[];
      if (isPdf(bytes)) {
        images = await renderPdfPages(bytes, { dpi, pages: requested });
        labels = resolvePageIndices(await countPdfPages(bytes), requested).map((p) => p + 1);
      } else if (looksLikeSvg(bytes)) {
        images = [(await rasterizeSvg(new TextDecoder().decode(bytes), { baseDir: baseDirFor(inPath), scale: dpi ? dpi / 96 : 1 })).image];
        labels = [1];
      } else if (isOfficeDocument(inPath)) {
        const tmp = await mkdtemp(join(tmpdir(), 'vecline-mcp-doc-'));
        try {
          const tmpPdf = join(tmp, 'render.pdf');
          await convertOffice(inPath, tmpPdf, {});
          const pdfBytes = new Uint8Array(await readFile(tmpPdf));
          images = await renderPdfPages(pdfBytes, { dpi, pages: requested });
          labels = resolvePageIndices(await countPdfPages(pdfBytes), requested).map((p) => p + 1);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      } else {
        throw new Error('doc_to_images accepts a PDF, SVG, or Office document.');
      }
      const stem = basename(inPath, extname(inPath));
      const multi = images.length > 1;
      const files: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const name = multi ? `${stem}-${labels[i]}.${format}` : `${stem}.${format}`;
        await writeFile(join(outDir, name), await encodeRaster(images[i], { format }));
        files.push(name);
      }
      return JSON.stringify({ outDir, pages: files.length, files }, null, 2);
    }
    case 'office_convert': {
      const res = await convertOffice(inPath, String(args.output), {});
      return `Wrote ${res.output} (via LibreOffice).`;
    }
    case 'images_to_pdf': {
      if (!Array.isArray(args.inputs) || args.inputs.length === 0) {
        throw new Error('images_to_pdf needs a non-empty "inputs" array of image paths.');
      }
      const inputs = (args.inputs as unknown[]).map(String);
      const images: RasterImage[] = [];
      for (const p of inputs) images.push((await loadRaster(await readFile(p))).image);
      const pdf = await imagesToPdf(images, { dpi: args.dpi !== undefined ? Number(args.dpi) : undefined });
      await writeFile(String(args.output), pdf);
      return `Wrote ${args.output} — ${images.length}-page PDF (${pdf.length} bytes).`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Parse a 1-based page spec like "1,3-5" into 0-based indices (range-capped). */
function parsePageSpecRpc(spec?: string): number[] | undefined {
  if (!spec) return undefined;
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

/** Parse "16:9" / "1.5" into a width/height ratio, or derive it from w×h. */
function parseAspectArg(spec: string, w?: unknown, h?: unknown): [number, number] {
  if (w && h) return [Number(w), Number(h)];
  const m = spec.match(/^\s*([\d.]+)\s*[:x/]\s*([\d.]+)\s*$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(spec);
  return Number.isFinite(n) && n > 0 ? [n, 1] : [1, 1];
}

function reply(id: Rpc['id'], result?: unknown, error?: { code: number; message: string }): string {
  return JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
}

/** Handle one JSON-RPC message; returns the serialised reply, or null for notifications. */
export async function handleMcpMessage(msg: Rpc): Promise<string | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vecline', version: VERSION } });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: await describeTools() });
    case 'tools/call':
      try {
        // A call that never returns takes the whole session with it, because
        // the queue behind it never drains. Nothing here should take two
        // minutes on any sane input; if it does, the agent is better told so
        // than left waiting.
        let timer: NodeJS.Timeout | undefined;
        const text = await Promise.race([
          callTool(String(params?.name), (params?.arguments as Record<string, unknown>) ?? {}),
          new Promise<never>((_, rejectCall) => {
            timer = setTimeout(
              () => rejectCall(new Error(
                `This call passed ${CALL_TIMEOUT_MS / 1000}s and was abandoned. The input is probably far ` +
                'larger than it looks — try a smaller image, or an explicit `output` path so the result ' +
                'is written rather than returned.',
              )),
              CALL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    default:
      return id === undefined || id === null ? null : reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

/**
 * Start the MCP stdio server: read JSON-RPC lines from stdin, reply on stdout.
 *
 * Messages are handled **one at a time**. Every tool here is CPU-bound and
 * synchronous inside — tracing a photograph pins a core for seconds — so
 * dispatching each line the moment it arrives let a batching client start N
 * traces at once and take the machine with it. Replies also came back out of
 * order (measured: eight requests answered 1,7,8,6,5,2,3,4), which is legal
 * JSON-RPC but makes a transcript very hard to read.
 *
 * The local bridge already bounds concurrency for the same reason; this is the
 * same idea with a queue of one, because there is nothing to gain from
 * overlapping work that cannot overlap.
 */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Rpc;
    try { msg = JSON.parse(trimmed); } catch { return; }
    queue = queue.then(async () => {
      const out = await handleMcpMessage(msg);
      if (out) process.stdout.write(out + '\n');
    });
  });
}
