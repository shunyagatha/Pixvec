import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRaster, DEFAULT_MAX_INPUT_PIXELS } from '../src/io/decode.js';
import { rasterizeSvg } from '../src/io/rasterize.js';

/**
 * Guards against hostile input.
 *
 * Vecline decodes files the user did not write — from the CLI, from the public
 * API, and from every MCP tool an agent can reach. These cases exist because
 * each one was, at some point, not guarded at all.
 */

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A PNG whose IHDR declares `w x h` but whose payload is a few bytes.
 *
 * The declared geometry is the whole attack: libvips sizes its allocation from
 * IHDR before it looks at the pixel data, so the file stays tiny while the
 * decode does not. Building a *valid* payload for 400 M pixels would mean
 * deflating 400 MB of zeroes, which is too slow for a test — and unnecessary,
 * because the limit is applied when the header is read.
 */
function declaresSize(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale: one byte per pixel, the cheapest bomb to declare
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(256))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decompression bombs', () => {
  it('refuses an image that declares more pixels than the cap', async () => {
    // 20000 x 20000 = 400 M pixels = 1.6 GB as RGBA, from a file under 1 KB.
    // Measured before this guard existed: a valid version of exactly this file
    // was 380 KB and decoded to 1.60 GB without complaint.
    const bomb = declaresSize(20_000, 20_000);
    expect(bomb.length).toBeLessThan(1024);

    await expect(decodeRaster(bomb)).rejects.toThrow(/more pixels than/i);
  });

  it('says what to do about it, and does not blame the format', async () => {
    // The refusal used to arrive as "Could not read image metadata: … Supported
    // inputs: PNG, JPEG, …", which sends the reader hunting for a format
    // problem that does not exist.
    const err = await decodeRaster(declaresSize(20_000, 20_000)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/limitInputPixels/);
    expect((err as Error).message).not.toMatch(/Supported inputs/);
  });

  it('is opt-out, for input you produced yourself', async () => {
    // Raising the cap must actually raise it — otherwise the guard is a wall
    // rather than a default. This one gets past the size check and fails later
    // on the deliberately short payload, which is the proof it got past.
    const err = await decodeRaster(declaresSize(20_000, 20_000), { limitInputPixels: false })
      .catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/more pixels than/i);
  });

  it('leaves ordinary images alone', async () => {
    // The cap is ~16000x16000, far above anything real, so a normal image must
    // not notice it exists.
    const { image } = await decodeRaster(declaresSize(4, 4));
    expect([image.width, image.height]).toEqual([4, 4]);
  });

  it('caps at libvips own default rather than an invented number', () => {
    expect(DEFAULT_MAX_INPUT_PIXELS).toBe(268_402_689);
  });
});

/**
 * `<image href>` inlining reads files named by a document we did not write.
 *
 * It exists for a good reason — resvg will not load a sibling `logo.png` on its
 * own, so without inlining that layer renders as a hole. But the href was
 * resolved with no containment, and absolute paths and `file:` URLs were taken
 * verbatim, which made it an arbitrary-file-read primitive reachable from four
 * MCP tools: "measure this SVG someone sent me" would load any readable file
 * whose name ended in an image extension and hand it back as pixels.
 */
describe('SVG image inlining is confined to baseDir', () => {
  let root = '';
  let publicDir = '';
  let secretDir = '';

  /** A recognisable 2x2 red PNG, standing in for a file that is not ours. */
  const png = (): Buffer => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // RGB
    const rows = Buffer.concat([
      Buffer.from([0, 255, 0, 0, 255, 0, 0]),
      Buffer.from([0, 255, 0, 0, 255, 0, 0]),
    ]);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(rows)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };

  const doc = (href: string): string =>
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    `width="8" height="8"><image href="${href}" x="0" y="0" width="8" height="8"/></svg>`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vecline-inline-'));
    publicDir = join(root, 'public');
    secretDir = join(root, 'secret');
    await mkdir(publicDir, { recursive: true });
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, 'private.png'), png());
    await writeFile(join(publicDir, 'sibling.png'), png());
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('still inlines a sibling, which is the whole point of the feature', async () => {
    const r = await rasterizeSvg(doc('sibling.png'), { baseDir: publicDir });
    expect(r.inlined).toHaveLength(1);
    expect(r.refusedInline).toHaveLength(0);
  });

  it.each([
    ['relative traversal', () => '../secret/private.png'],
    ['percent-encoded traversal', () => '..%2Fsecret%2Fprivate.png'],
    ['an absolute path', () => join(secretDir, 'private.png').replace(/\\/g, '/')],
    ['a file: URL', () => `file:///${join(secretDir, 'private.png').replace(/\\/g, '/')}`],
  ])('refuses %s', async (_label, href) => {
    const r = await rasterizeSvg(doc(href()), { baseDir: publicDir });
    // Asserting "nothing was read" rather than the refusal count, because the
    // routes differ by platform: on Windows a drive letter (`C:`) is caught
    // earlier as a URL scheme, while on Linux `/etc/...` reaches the
    // containment check. Both must refuse; only one records a refusal.
    expect(r.inlined).toHaveLength(0);
  });

  it('reports refusals rather than leaving an unexplained hole', async () => {
    const r = await rasterizeSvg(doc('../secret/private.png'), { baseDir: publicDir });
    expect(r.refusedInline).toEqual(['../secret/private.png']);
  });
});
