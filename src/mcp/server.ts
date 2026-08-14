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
import { basename, extname, join } from 'node:path';
import { loadRaster, vectorize, VERSION } from '../api.js';
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
      + 'Auto-picks pixel/trace/embed, or force a mode. Writes to `output` if given, else returns the SVG.',
    inputSchema: s({
      properties: {
        input: { type: 'string', description: 'Path to the source raster image' },
        output: { type: 'string', description: 'Optional .svg output path' },
        mode: { type: 'string', enum: ['auto', 'lossless', 'pixel', 'trace', 'embed'] },
        preset: { type: 'string', enum: ['auto', 'logo', 'lineart', 'poster', 'photo', 'detailed'] },
        colors: { type: 'number' },
      },
      required: ['input'],
    }),
  },
  {
    name: 'convert',
    description: 'Convert between formats by extension. Supports raster↔SVG plus vector export to .dxf/.eps/.pdf (CAD/CNC/print).',
    inputSchema: s({ properties: { input: { type: 'string' }, output: { type: 'string' }, cmyk: { type: 'boolean' } }, required: ['input', 'output'] }),
  },
  {
    name: 'centerline',
    description: 'Trace line art to single-stroke centreline SVG (for plotters, lasers, CNC). Optionally emit G-code with tool=laser|pen.',
    inputSchema: s({ properties: { input: { type: 'string' }, output: { type: 'string' }, gcode: { type: 'boolean' }, tool: { type: 'string', enum: ['laser', 'pen'] } }, required: ['input'] }),
  },
  {
    name: 'measure',
    description: 'Measure how close two images (raster or SVG) are: PSNR, SSIM, mean CIEDE2000, and whether they are pixel-identical.',
    inputSchema: s({ properties: { reference: { type: 'string' }, candidate: { type: 'string' } }, required: ['reference', 'candidate'] }),
  },
  {
    name: 'diff',
    description: 'Perceptual visual-regression diff. Paints a CIEDE2000 heatmap of what changed between two images (raster or SVG) and reports changed-pixel count/fraction, max & mean ΔE, and SSIM. Give an output path to save the heatmap.',
    inputSchema: s({ properties: { reference: { type: 'string' }, candidate: { type: 'string' }, output: { type: 'string', description: 'Optional .png heatmap path' }, threshold: { type: 'number', description: 'CIEDE2000 above which a pixel counts as changed (default 2)' } }, required: ['reference', 'candidate'] }),
  },
  {
    name: 'crop',
    description: 'Content-aware crop to an aspect ratio, keeping the salient subject (edges + saturation) rather than the centre. aspect like "1:1", "16:9", "4:5".',
    inputSchema: s({ properties: { input: { type: 'string' }, output: { type: 'string' }, aspect: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['input', 'output'] }),
  },
  {
    name: 'palette',
    description: 'Extract a perceptual dominant-colour palette (hex + weight) from an image.',
    inputSchema: s({ properties: { input: { type: 'string' }, colors: { type: 'number' } }, required: ['input'] }),
  },
  {
    name: 'placeholder',
    description: 'Generate a BlurHash string for lazy-loading a raster image.',
    inputSchema: s({ properties: { input: { type: 'string' } }, required: ['input'] }),
  },
  {
    name: 'image_info',
    description: 'Inspect an image: dimensions, format, colour count, and the recommended vectorisation strategy.',
    inputSchema: s({ properties: { input: { type: 'string' } }, required: ['input'] }),
  },
  {
    name: 'doc_to_images',
    description: 'Render a document (PDF, SVG, or Office docx/xlsx/pptx) to one image per page. PDF needs the optional mupdf package; Office needs local LibreOffice.',
    inputSchema: s({
      properties: {
        input: { type: 'string' }, outDir: { type: 'string', description: 'directory to write page images into' },
        format: { type: 'string', description: 'png (default), jpeg, webp, avif' }, dpi: { type: 'number' },
        pages: { type: 'string', description: '1-based page spec, e.g. "1,3-5" (PDF/Office)' },
      },
      required: ['input', 'outDir'],
    }),
  },
  {
    name: 'office_convert',
    description: 'Convert an Office document ⇄ PDF (and between Office formats) via local LibreOffice. Target format is the output file extension.',
    inputSchema: s({ properties: { input: { type: 'string' }, output: { type: 'string' } }, required: ['input', 'output'] }),
  },
  {
    name: 'images_to_pdf',
    description: 'Combine images into one multi-page PDF (one image per page).',
    inputSchema: s({ properties: { inputs: { type: 'array', items: { type: 'string' } }, output: { type: 'string' }, dpi: { type: 'number' } }, required: ['inputs', 'output'] }),
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
    return note ? { ...t, description: `${t.description} [${note}]` } : t;
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const inPath = String(args.input ?? args.reference ?? '');
  switch (name) {
    case 'vectorize': {
      const src = await loadRaster(await readFile(inPath));
      const r = await vectorize(src, {
        mode: (args.mode as never) ?? 'auto',
        preset: (args.preset as never) ?? 'auto',
        trace: args.colors ? { colors: Number(args.colors) } : undefined,
      });
      if (args.output) { await writeFile(String(args.output), r.svg); return `Wrote ${args.output} — ${r.mode} mode, ${r.shapes} shapes, ${r.colors} colours, lossless=${r.lossless}.`; }
      return r.svg;
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
      return r.svg;
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
      const { image, meta } = await decodeRaster(await readFile(inPath));
      return JSON.stringify({ width: image.width, height: image.height, format: meta.format, hasAlpha: meta.hasAlpha }, null, 2);
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
        const text = await callTool(String(params?.name), (params?.arguments as Record<string, unknown>) ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    default:
      return id === undefined || id === null ? null : reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

/** Start the MCP stdio server: read JSON-RPC lines from stdin, reply on stdout. */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Rpc;
    try { msg = JSON.parse(trimmed); } catch { return; }
    void handleMcpMessage(msg).then((out) => { if (out) process.stdout.write(out + '\n'); });
  });
}
