import { describe, expect, it, beforeAll } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpMessage } from '../src/mcp/server.js';
import { flatArtwork, encode } from './fixtures.js';

/**
 * The MCP server is how AI agents drive pixvec. These tests exercise the JSON-RPC
 * handshake and a couple of real tool calls directly through the handler, so the
 * protocol contract is verified without spawning a process.
 */

let pngPath: string;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixvec-mcp-'));
  pngPath = join(dir, 'art.png');
  await writeFile(pngPath, await encode(flatArtwork(80, 60), 'png'));
});

async function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1) {
  const out = await handleMcpMessage({ jsonrpc: '2.0', id, method, params });
  return out ? JSON.parse(out) : null;
}

describe('MCP server', () => {
  it('completes the initialize handshake', async () => {
    const r = await rpc('initialize', {});
    expect(r.result.serverInfo.name).toBe('pixvec');
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
    for (const t of r.result.tools) expect(t.inputSchema.type).toBe('object');
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
