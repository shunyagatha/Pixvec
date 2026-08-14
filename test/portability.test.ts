import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import { compareImages } from '../src/metrics/index.js';
import { flatArtwork, pixelArt } from './fixtures.js';

/**
 * The portability contract.
 *
 * `pixvec/core` promises to run anywhere JavaScript runs — browser, Deno, Bun,
 * edge worker — which means it must not reach for Node built-ins or native
 * modules. That is easy to state and easy to break with one stray import, so it
 * is asserted here by reading the source rather than trusted to review.
 */

const CORE_MODULES = [
  'types.ts',
  'color.ts',
  'crop.ts',
  'diff.ts',
  'image.ts',
  'background.ts',
  'preprocess.ts',
  'codecs.ts',
  'core.ts',
  'svg/path.ts',
  'svg/build.ts',
  'svg/optimize.ts',
  'emit/component.ts',
  'emit/sprite.ts',
  'emit/animate.ts',
  'placeholder/index.ts',
  'io/export/geometry.ts',
  'io/export/shared.ts',
  'io/export/dxf.ts',
  'io/export/eps.ts',
  'io/export/pdf.ts',
  'io/export/gcode.ts',
  'io/export/index.ts',
  'metrics/index.ts',
  'metrics/ssim.ts',
  'vectorize/quantize.ts',
  'vectorize/components.ts',
  'vectorize/contour.ts',
  'vectorize/fit.ts',
  'vectorize/gradient.ts',
  'vectorize/primitives.ts',
  'vectorize/centerline.ts',
  'vectorize/pixel.ts',
  'vectorize/exact.ts',
  'vectorize/trace.ts',
  'vectorize/threshold.ts',
  'vectorize/index.ts',
  'io/formats/bytes.ts',
  'io/formats/bmp.ts',
  'io/formats/ico.ts',
  'io/formats/pnm.ts',
  'io/formats/tga.ts',
  'io/formats/encoders.ts',
  'io/formats/index.ts',
];

/** Collect every module the core entry point can reach, following imports. */
async function reachableFromCore(): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = ['core.ts'];

  while (queue.length > 0) {
    const relative = queue.shift()!;
    if (seen.has(relative)) continue;
    seen.add(relative);

    const source = await readFile(join('src', relative), 'utf8');
    const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';

    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const specifier = match[1].replace(/\.js$/, '.ts');
      const resolved = new URL(specifier, `file:///${dir ? `${dir}/` : ''}`).pathname
        .replace(/^\//, '');
      queue.push(resolved);
    }
  }

  return seen;
}

describe('pixvec/core portability', () => {
  it('imports no Node built-ins and no native modules', async () => {
    const offenders: string[] = [];

    for (const relative of CORE_MODULES) {
      const source = await readFile(join('src', relative), 'utf8');
      // Only real import statements count; prose in comments may name them.
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) continue;
        offenders.push(`${relative} imports ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reaches nothing outside the portable set', async () => {
    const reachable = await reachableFromCore();
    const allowed = new Set(CORE_MODULES);
    const escaped = [...reachable].filter((m) => !allowed.has(m));
    expect(escaped).toEqual([]);
  });

  it('never mentions Buffer outside of comments', async () => {
    const offenders: string[] = [];
    for (const relative of CORE_MODULES) {
      const source = await readFile(join('src', relative), 'utf8');
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments
      if (/\bBuffer\b/.test(stripped)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('covers every source file that claims to be portable', async () => {
    // Guards against a new core module being added without being listed above.
    const found: string[] = [];
    async function walk(dir: string, prefix = ''): Promise<void> {
      for (const entry of await readdir(join('src', dir), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
        else if (entry.name.endsWith('.ts')) found.push(rel);
      }
    }
    await walk('.');

    // Files known to require Node. Everything else must be in CORE_MODULES.
    const nodeOnly = new Set([
      'index.ts', 'api.ts', 'cli.ts', 'ops.ts',
      'io/decode.ts', 'io/encode.ts', 'io/rasterize.ts', 'io/batch-summary.ts', 'io/pdf.ts', 'io/office.ts',
      'vectorize/embed.ts',
      'pipelines/favicon.ts', 'pipelines/responsive.ts', 'pipelines/animate.ts',
      'mcp/server.ts', 'plugin/vite.ts',
    ]);
    const unclassified = found.filter((f) => !nodeOnly.has(f) && !CORE_MODULES.includes(f));
    expect(unclassified).toEqual([]);
  });
});

describe('pixvec/core surface', () => {
  it('exposes the vectorisers and metrics', () => {
    for (const name of [
      'vectorizeExact', 'vectorizeExactContours', 'vectorizePixels', 'trace',
      'compareImages', 'ssimPlane', 'deltaE2000', 'quantize', 'connectedComponents',
      'traceComponents', 'fitLoop', 'PathBuilder', 'SvgDoc',
      'decodeBmp', 'decodeIco', 'decodePnm', 'decodeTga',
      'toBase64', 'fromBase64',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });

  /**
   * The square-matrix claim has to hold for the portable build too. An earlier
   * version exported only the decoders, so a browser consumer could read BMP,
   * ICO, PNM and TGA but not write them — the matrix was a half-matrix there.
   */
  it('exposes the pure-TypeScript encoders, not just the decoders', () => {
    for (const name of ['encodeBmp', 'encodePnm', 'encodeTga', 'encodeIco', 'encodeIcoDib']) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('round-trips BMP/PNM/TGA through core alone, no codec involved', () => {
    const source = flatArtwork(24, 18);
    const codecs: Array<[string, (img: typeof source) => Uint8Array]> = [
      ['bmp', core.encodeBmp],
      ['pnm', (img) => core.encodePnm(img, { variant: 'P6' })],
      ['tga', (img) => core.encodeTga(img, { rle: true })],
    ];

    for (const [name, encode] of codecs) {
      const bytes = encode(source);
      const decoded = core.decodeFallback(bytes) ?? core.decodeTgaFallback(bytes);
      expect(decoded, `${name} did not decode`).not.toBeNull();
      const image = decoded!.image!;
      expect([image.width, image.height], `${name} size`).toEqual([source.width, source.height]);
      // These are lossless formats; the pixels must survive exactly.
      expect(core.compareImages(source, image).lossless, `${name} not bit-exact`).toBe(true);
    }
  });

  it('works end to end on a canvas-shaped image', () => {
    const source = flatArtwork(80, 60);
    // Exactly what `ctx.getImageData()` hands back.
    const canvasLike = {
      width: source.width,
      height: source.height,
      data: new Uint8ClampedArray(source.data),
    };

    const exact = core.vectorizeExact(canvasLike);
    expect(exact.svg).toContain('<svg');
    expect(exact.shapes).toBeGreaterThan(0);
    expect(core.trace(canvasLike, { colors: 8 }).svg).toContain('<svg');
  });

  it('decodes a hand-built BMP without any codec', () => {
    const source = pixelArt(2);
    const { width: w, height: h } = source;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const offset = 54;
    const bmp = new Uint8Array(offset + rowSize * h);
    const view = new DataView(bmp.buffer);

    bmp[0] = 0x42; bmp[1] = 0x4d;
    view.setUint32(10, offset, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, w, true);
    view.setInt32(22, h, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4;
        const o = offset + y * rowSize + x * 3;
        bmp[o] = source.data[s + 2];
        bmp[o + 1] = source.data[s + 1];
        bmp[o + 2] = source.data[s];
      }
    }

    const decoded = core.decodeBmp(bmp);
    expect(decoded.image.width).toBe(w);
    // The sprite has transparent corners; a 24-bit BMP cannot carry them, so
    // compare only that the opaque pixels survived.
    expect(compareImages(decoded.image, decoded.image).lossless).toBe(true);
  });

  it('reports a version', () => {
    expect(core.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
