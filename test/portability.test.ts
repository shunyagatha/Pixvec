import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import { compareImages } from '../src/metrics/index.js';
import { flatArtwork, pixelArt } from './fixtures.js';

/**
 * The portability contract.
 *
 * `vecline/core` promises to run anywhere JavaScript runs — browser, Deno, Bun,
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
  'svg/budget.ts',
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
  'metrics/severity.ts',
  'metrics/ssim.ts',
  'vectorize/quantize.ts',
  'vectorize/components.ts',
  'vectorize/merge.ts',
  'vectorize/smooth.ts',
  'vectorize/junctions.ts',
  'vectorize/arcs.ts',
  'vectorize/contour.ts',
  'vectorize/subpixel.ts',
  'vectorize/refine-source.ts',
  'vectorize/despike.ts',
  'vectorize/fit.ts',
  'vectorize/gradient.ts',
  'vectorize/primitives.ts',
  'vectorize/interpolate.ts',
  'vectorize/centerline.ts',
  'vectorize/pixel.ts',
  'vectorize/exact.ts',
  'vectorize/trace.ts',
  'vectorize/threshold.ts',
  'vectorize/index.ts',
  'io/route.ts',
  'io/formats/bytes.ts',
  // APNG splitting and compositing are both pure: the reader hands back
  // standalone PNG bytes and the compositor takes a decoder as a callback, so
  // neither reaches a codec itself and both run anywhere.
  'io/formats/apng.ts',
  'io/apng-compose.ts',
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

describe('vecline/core portability', () => {
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
      // cli-help.ts imports commander, so it belongs with cli.ts rather than
      // with anything the browser bundle can reach.
      'index.ts', 'api.ts', 'cli.ts', 'cli-help.ts', 'ops.ts',
      // native.ts exists to load the two native addons, so it is node-only by
      // definition — it is the one file whose whole purpose is the thing the
      // portable core must not reach.
      'io/native.ts',
      // Asks node:v8 for the real heap ceiling, which is its entire purpose.
      'io/loop-budget.ts',
      'io/decode.ts', 'io/encode.ts', 'io/rasterize.ts', 'io/batch-summary.ts', 'io/pdf.ts', 'io/office.ts', 'io/images-pdf.ts',
      // Opens a socket and spawns LibreOffice — node:http, node:fs, node:crypto.
      'io/bridge.ts',
      'vectorize/embed.ts',
      'pipelines/favicon.ts', 'pipelines/responsive.ts', 'pipelines/animate.ts',
      'mcp/server.ts', 'plugin/vite.ts',
    ]);
    const unclassified = found.filter((f) => !nodeOnly.has(f) && !CORE_MODULES.includes(f));
    expect(unclassified).toEqual([]);
  });
});

describe('vecline/core surface', () => {
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

/**
 * The stronger form of the same promise.
 *
 * Everything above reads the *source* and walks its import graph, which is a
 * good proxy and still a proxy: it trusts that the walk sees every edge, that
 * no dependency pulls something in behind it, and that nothing arrives through
 * a form the walk does not parse. The claim users actually rely on is narrower
 * and more testable — *this bundles for a browser* — so this asserts that
 * directly, by bundling it for a browser.
 *
 * A bundler resolves the real graph, follows transitive dependencies, and fails
 * loudly on anything it cannot satisfy without a Node shim. If `vecline/core`
 * ever grows an edge to `node:fs`, this goes red before anyone deploys it to a
 * Worker and finds out there.
 */
describe('vecline/core bundles for the browser', () => {
  it('bundles with no externals and no Node built-ins', async () => {
    const result = await build({
      entryPoints: ['src/core.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      // No `platform: 'node'`, and deliberately no `external` list: anything the
      // core reaches for must resolve here, or the build throws.
      platform: 'browser',
      target: ['es2022', 'chrome111', 'firefox111', 'safari16'],
      logLevel: 'silent',
    });

    expect(result.errors).toEqual([]);
    const [output] = result.outputFiles ?? [];
    expect(output).toBeDefined();

    const code = output!.text;

    // A `node:` specifier surviving into a browser bundle means esbuild left an
    // import it could not resolve — the exact failure this guards.
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toMatch(/require\(\s*["']node:/);
    expect(code).not.toMatch(/import\(\s*["']node:/);

    // The globals a Node-only path reaches for. `Buffer` is already checked
    // against the source above; these catch it arriving through a dependency.
    expect(code).not.toMatch(/\bprocess\.(env|argv|cwd|platform)\b/);
    expect(code).not.toMatch(/\b__dirname\b|\b__filename\b/);
  }, 60_000);

  it('stays small enough to be worth shipping to a browser', async () => {
    const result = await build({
      entryPoints: ['src/core.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      minify: true,
      target: ['es2022'],
      logLevel: 'silent',
    });

    const bytes = (result.outputFiles ?? [])[0]?.contents.length ?? 0;
    // Not a performance assertion — a tripwire. The portable core is a few
    // hundred KB of pure geometry and colour maths; a jump past this ceiling
    // means something large arrived that probably should not have.
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThan(600_000);
    // eslint-disable-next-line no-console
    console.log(`  vecline/core bundles to ${(bytes / 1024).toFixed(1)} KB minified`);
  }, 60_000);
});

describe('optional dependencies are actually optional', () => {
  /**
   * The two native addons must not be imported at module top level.
   *
   * `sharp` and `@resvg/resvg-js` are declared in `optionalDependencies`, and
   * `--omit=optional` is offered as a supported install. That combination was
   * broken: both were static top-level imports, so an install without them made
   * even `vecline --version` die on a raw `ERR_MODULE_NOT_FOUND` out of Node's
   * module reader — no mention of a codec, no mention of which one.
   *
   * This reads the source rather than trusting review, because the regression is
   * one stray `import sharp from 'sharp'` away and it cannot be felt on a
   * developer machine where both packages are installed.
   */
  const NATIVE = ['sharp', '@resvg/resvg-js'];

  it('imports no native addon as a value, anywhere in src', async () => {
    const offenders: string[] = [];
    async function walk(dir: string, prefix = ''): Promise<void> {
      for (const entry of await readdir(join('src', dir), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await walk(join(dir, entry.name), rel); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(join('src', dir, entry.name), 'utf8');
        for (const pkg of NATIVE) {
          // A value import. `import type { X } from 'sharp'` is erased at
          // compile time and therefore costs nothing at runtime, so it is fine;
          // so is a lazy `await import(name)` behind a string variable.
          const valueImport = new RegExp(
            String.raw`^\s*import\s+(?!type\b)[^;]*?from\s*['"]` + pkg.replace(/[/\^$*+?.()|[\]{}]/g, '\$&') + String.raw`['"]`,
            'm',
          );
          const m = source.match(valueImport);
          if (!m) continue;
          // `import { type A, type B } from 'x'` is also fully erased — every
          // binding is type-only even though the statement lacks the modifier.
          const allTypeOnly = /^\s*import\s*\{([^}]*)\}/.exec(m[0]);
          if (allTypeOnly) {
            const bindings = allTypeOnly[1].split(',').map((b) => b.trim()).filter(Boolean);
            if (bindings.length > 0 && bindings.every((b) => b.startsWith('type '))) continue;
          }
          offenders.push(`${rel}: ${m[0].trim()}`);
        }
      }
    }
    await walk('.');
    expect(offenders).toEqual([]);
  });

  it('loads them through the lazy loader, which reports what is missing', async () => {
    const source = await readFile(join('src', 'io/native.ts'), 'utf8');
    // The specifier must be a variable, or TypeScript resolves it statically and
    // emits a hard dependency on a package consumers need not install.
    expect(source).toMatch(/const name: string = 'sharp'/);
    expect(source).toMatch(/const name: string = '@resvg\/resvg-js'/);
    // And a failure has to name the package and the fix, not surface Node's
    // module-resolution error.
    expect(source).toMatch(/npm i \$\{pkg\}|npm i sharp/);
    for (const pkg of ['sharp', '@resvg/resvg-js']) expect(source).toContain(pkg);
  });
});
