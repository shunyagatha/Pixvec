import { describe, expect, it, beforeAll } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpMessage } from '../src/mcp/server.js';
import { flatArtwork, encode, setPixel } from './fixtures.js';

/**
 * The MCP server is how AI agents drive graver. These tests exercise the JSON-RPC
 * handshake and a couple of real tool calls directly through the handler, so the
 * protocol contract is verified without spawning a process.
 */

let pngPath: string;
let pngPath2: string;
let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'graver-mcp-'));
  pngPath = join(outDir, 'art.png');
  await writeFile(pngPath, await encode(flatArtwork(80, 60), 'png'));
  // A second image, differing in a small block, for the diff tool.
  const b = flatArtwork(80, 60);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) setPixel(b, x, y, 12, 220, 40);
  pngPath2 = join(outDir, 'art2.png');
  await writeFile(pngPath2, await encode(b, 'png'));
});

async function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1) {
  const out = await handleMcpMessage({ jsonrpc: '2.0', id, method, params });
  return out ? JSON.parse(out) : null;
}

describe('MCP server', () => {
  it('completes the initialize handshake', async () => {
    const r = await rpc('initialize', {});
    expect(r.result.serverInfo.name).toBe('graver');
    expect(r.result.protocolVersion).toBeTruthy();
    expect(r.result.capabilities.tools).toBeTruthy();
  });

  it('lists tools, each with an object input schema', async () => {
    const r = await rpc('tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('vectorize');
    expect(names).toContain('convert');
    expect(names).toContain('centerline');
    expect(names).toContain('measure');
    expect(names).toContain('diff');
    expect(names).toContain('crop');
    expect(names).toContain('doc_to_images');
    expect(names).toContain('office_convert');
    expect(names).toContain('images_to_pdf');
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('runs images_to_pdf, writing a valid PDF', async () => {
    const out = join(outDir, 'album.pdf');
    const r = await rpc('tools/call', { name: 'images_to_pdf', arguments: { inputs: [pngPath, pngPath2], output: out } });
    expect(r.result.content[0].text).toContain('2-page PDF');
    const { readFile } = await import('node:fs/promises');
    const bytes = new Uint8Array(await readFile(out));
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('images_to_pdf rejects a non-array "inputs" with an actionable error', async () => {
    const r = await rpc('tools/call', { name: 'images_to_pdf', arguments: { inputs: pngPath, output: join(outDir, 'x.pdf') } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/inputs.*array/i);
  });

  it('surfaces office_convert without LibreOffice as isError, not a crash', async () => {
    const src = join(outDir, 'thing.docx');
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(src, 'x');
    const r = await rpc('tools/call', { name: 'office_convert', arguments: { input: src, output: join(outDir, 'thing.pdf') } });
    // Either LibreOffice is present (unlikely in CI) or the error is actionable.
    if (r.result.isError) expect(r.result.content[0].text).toMatch(/LibreOffice|not found/i);
  });

  it('runs the diff tool and reports the changed region', async () => {
    const out = join(outDir, 'diff.png');
    const r = await rpc('tools/call', { name: 'diff', arguments: { reference: pngPath, candidate: pngPath2, output: out } });
    const stats = JSON.parse(r.result.content[0].text);
    expect(stats.changedPixels).toBeGreaterThan(0);
    expect(stats.totalPixels).toBe(80 * 60);
    expect(stats.ssim).toBeLessThan(1);
    expect(stats.heatmap).toBe(out);
  });

  it('runs the crop tool and writes a content-aware crop', async () => {
    const out = join(outDir, 'crop.png');
    const r = await rpc('tools/call', { name: 'crop', arguments: { input: pngPath, output: out, aspect: '1:1' } });
    expect(r.result.content[0].text).toContain('content-aware crop');
    expect(r.result.isError).toBeUndefined();
  });

  it('does not reply to the initialized notification', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('runs the palette tool on a real file', async () => {
    const r = await rpc('tools/call', { name: 'palette', arguments: { input: pngPath, colors: 3 } });
    expect(r.result.content[0].type).toBe('text');
    const pal = JSON.parse(r.result.content[0].text);
    expect(pal[0].hex).toMatch(/^#[0-9a-f]+$/);
  });

  it('runs the vectorize tool and returns SVG', async () => {
    const r = await rpc('tools/call', { name: 'vectorize', arguments: { input: pngPath, mode: 'trace' } });
    expect(r.result.content[0].text).toContain('<svg');
  });

  it('surfaces a tool failure as isError, not a broken protocol reply', async () => {
    const r = await rpc('tools/call', { name: 'palette', arguments: { input: '/no/such/file.png' } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('Error');
  });

  it('returns method-not-found for an unknown method', async () => {
    const r = await rpc('bogus/method');
    expect(r.error.code).toBe(-32601);
  });
});
