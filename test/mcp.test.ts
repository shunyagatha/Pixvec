import { describe, expect, it, beforeAll } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpMessage } from '../src/mcp/server.js';
import { flatArtwork, encode, setPixel } from './fixtures.js';

/**
 * The MCP server is how AI agents drive vecline. These tests exercise the JSON-RPC
 * handshake and a couple of real tool calls directly through the handler, so the
 * protocol contract is verified without spawning a process.
 */

let pngPath: string;
let pngPath2: string;
let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'vecline-mcp-'));
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
    expect(r.result.serverInfo.name).toBe('vecline');
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

  it('annotates tools whose optional engine is missing, instead of failing cold', async () => {
    // A registry sandbox has neither LibreOffice nor mupdf. An agent that
    // discovers the server there must be told *why* a tool cannot run, or the
    // failure reads as "this server is broken".
    const r = await rpc('tools/list');
    const byName = Object.fromEntries(
      r.result.tools.map((t: { name: string; description: string }) => [t.name, t.description]),
    );
    const officeNote = byName.office_convert;
    // Either LibreOffice is genuinely installed (no note), or the note explains
    // exactly what to install — never a bare, unexplained tool.
    if (/UNAVAILABLE/.test(officeNote)) {
      expect(officeNote).toMatch(/LibreOffice/);
      expect(officeNote).toMatch(/libreoffice\.org|VECLINE_SOFFICE/);
    }
    // Tools with no optional dependency must never be annotated.
    expect(byName.measure).not.toMatch(/UNAVAILABLE|LIMITED/);
    expect(byName.vectorize).not.toMatch(/UNAVAILABLE|LIMITED/);
  });

  it('describes vectorize honestly about where it wins and loses', async () => {
    // The one task a deterministic tracer loses to a neural cloud service is
    // photographs. Saying so in the description is cheaper than an agent
    // discovering it by shipping a bad result.
    const r = await rpc('tools/list');
    const v = r.result.tools.find((t: { name: string }) => t.name === 'vectorize').description;
    expect(v).toMatch(/bit-exact/i);
    expect(v).toMatch(/photograph/i);
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

/**
 * What an agent can actually reach.
 *
 * Three gaps that all shared a shape: the server advertised something and did
 * not deliver it, so a model reading the tool list would form a plan the
 * server could not carry out. The tests assert the *contract* — the fields a
 * description promises must be in the reply — rather than exact values, which
 * are the engine's business and are covered elsewhere.
 */
describe('MCP tool contracts', () => {
  it('validates required arguments instead of failing as ENOENT ""', async () => {
    // `palette {}` used to reach the filesystem with an empty path. The error
    // an agent saw named neither the tool nor the missing argument, so the
    // obvious retry was to call it the same way again.
    const r = await rpc('tools/call', { name: 'palette', arguments: {} });
    expect(r.result.isError).toBe(true);
    const text = r.result.content[0].text;
    expect(text).toContain('palette');
    expect(text).toContain('input');
    expect(text).not.toContain('ENOENT');
  });

  it('names every missing argument, not just the first', async () => {
    const r = await rpc('tools/call', { name: 'measure', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('reference');
    expect(r.result.content[0].text).toContain('candidate');
  });

  it('treats a blank string as missing', async () => {
    // The empty string is what the old code silently produced; accepting it
    // here would leave the original bug reachable through an explicit argument.
    const r = await rpc('tools/call', { name: 'palette', arguments: { input: '   ' } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('input');
  });

  it('image_info returns the colour count and strategy its description promises', async () => {
    const r = await rpc('tools/call', { name: 'image_info', arguments: { input: pngPath } });
    const info = JSON.parse(r.result.content[0].text);
    expect(info.width).toBe(80);
    expect(info.height).toBe(60);
    expect(info).toHaveProperty('distinctColors');
    expect(info).toHaveProperty('runDensity');
    expect(['pixel', 'trace']).toContain(info.recommendedMode);
    expect(typeof info.losslessAchievable).toBe('boolean');
    expect(info.recommendation).toBeTruthy();
  });

  it('recommends the bit-exact mode for flat art', async () => {
    // The whole point of inspecting first: flat artwork is the case where
    // vecline beats every neural tracer, and the tool has to say so.
    const r = await rpc('tools/call', { name: 'image_info', arguments: { input: pngPath } });
    const info = JSON.parse(r.result.content[0].text);
    expect(info.losslessAchievable).toBe(true);
    expect(info.recommendedMode).toBe('pixel');
  });

  it('vectorize verify:true returns measurements in the same call', async () => {
    // The flagship claim — "measured, not asserted" — previously took three
    // round trips and a file on disk to reach.
    const r = await rpc('tools/call', {
      name: 'vectorize', arguments: { input: pngPath, mode: 'trace', verify: true },
    });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.width).toBe(80);
    expect(out.height).toBe(60);
    expect(out.svgBytes).toBeGreaterThan(0);
    expect(out.verified.ssim).toBeGreaterThan(0);
    expect(out.verified).toHaveProperty('psnr');
    expect(out.verified).toHaveProperty('meanDeltaE');
    expect(typeof out.verified.pixelIdentical).toBe('boolean');
  });

  it('vectorize verify:true proves bit-exactness on flat art', async () => {
    const r = await rpc('tools/call', {
      name: 'vectorize', arguments: { input: pngPath, mode: 'pixel', verify: true },
    });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.verified.pixelIdentical).toBe(true);
    expect(out.verified.ssim).toBe(1);
  });

  it('vectorize without verify still returns the SVG, unchanged', async () => {
    // Verification is opt-in because it costs a full render; the default path
    // must not have quietly become JSON.
    const r = await rpc('tools/call', { name: 'vectorize', arguments: { input: pngPath, mode: 'trace' } });
    expect(r.result.content[0].text).toContain('<svg');
  });

  it('describes every property an agent can pass', async () => {
    // `centerline.gcode` changes the output *format*, not a detail of it. An
    // undescribed boolean is how an agent asks for an SVG and gets G-code.
    const r = await rpc('tools/list');
    for (const tool of r.result.tools) {
      for (const [key, schema] of Object.entries(tool.inputSchema.properties as Record<string, { description?: string }>)) {
        expect(schema.description, `${tool.name}.${key} has no description`).toBeTruthy();
      }
    }
  });
});
