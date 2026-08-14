/**
 * Model Context Protocol (MCP) server for pixvec.
 *
 * Exposes pixvec's conversion, tracing, export and measurement as tools an AI
 * agent or IDE (Claude, Cursor, Continue, …) can call directly — "vectorise this
 * logo", "turn this drawing into laser G-code", "how close is this SVG to the
 * PNG?" — without the model shelling out and parsing text.
 *
 * A minimal, dependency-free stdio JSON-RPC 2.0 implementation of the MCP
 * handshake (initialize → tools/list → tools/call), so it adds nothing to the
 * install. Node-only: the tools read and write real files.
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { loadRaster, vectorize, VERSION } from '../api.js';
import { compareImages } from '../metrics/index.js';
import { rasterizeSvg, baseDirFor } from '../io/rasterize.js';
import { decodeRaster, looksLikeSvg } from '../io/decode.js';
import { centerlineTrace, centerlinePolylines } from '../vectorize/centerline.js';
import { traceGeometry, toDxf, toEps, toPdf, toGcode } from '../io/export/index.js';
import { extractPalette } from '../vectorize/quantize.js';
import { blurHash } from '../placeholder/index.js';
import { diffImages } from '../diff.js';
import { smartCrop, cropImage } from '../crop.js';

interface Rpc { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; }

const s = (o: Record<string, unknown>): { type: 'object'; properties: Record<string, unknown>; required?: string[] } =>
  ({ type: 'object', ...o } as never);

const TOOLS = [
  {
    name: 'vectorize',
    description: 'Convert a raster image file (PNG/JPEG/WebP/…) to SVG. Auto-picks pixel/trace/embed, or force a mode. Writes to output if given, else returns the SVG.',
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
];

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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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
      return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pixvec', version: VERSION } });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
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
