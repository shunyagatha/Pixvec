import { describe, expect, it, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encode } from './fixtures.js';
import { flatArtwork } from './fixtures.js';

const run = promisify(execFile);

/**
 * The CLI's promises to a machine.
 *
 * Everything here is a contract a script depends on and a human would never
 * notice breaking: which stream carries what, whether the bytes parse, what an
 * exit code means. The library tests cover the algorithms; nothing covered the
 * interface until these, which is how all three defects below shipped.
 *
 * They spawn the built CLI rather than importing it, because argument parsing,
 * stream separation and exit codes only exist in a real process.
 */
const CLI = resolve(process.cwd(), 'dist', 'esm', 'cli.js');
const built = existsSync(CLI);

/** Run the CLI, capturing both streams and the exit code without throwing. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe.skipIf(!built)('CLI: -h reaches help', () => {
  // -h set --height on these three, so `vecline crop photo.jpg -h` did not print
  // help — it reported "option '-h, --height <px>' argument missing", and
  // `rasterize -h logo.svg` ate the filename as a height and rejected it. Every
  // other command in the tool, and essentially every Unix program, treats -h as
  // help; these three silently did not.
  for (const cmd of ['rasterize', 'crop', 'convert']) {
    it(`${cmd} -h prints usage, not a height error`, async () => {
      const r = await cli([cmd, '-h']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage:');
      expect(r.stderr).not.toContain('--height');
    });
  }

  it('keeps --height working in long form', async () => {
    const r = await cli(['rasterize', '--help']);
    expect(r.stdout).toContain('--height');
  });
});

describe.skipIf(!built)('CLI: --json is machine-readable on failure', () => {
  it('reports an error as JSON on stdout, with the exit code in it', async () => {
    // A --json run that failed printed nothing on stdout and a human sentence on
    // stderr, so a consumer got an empty string and had to guess whether that
    // meant "no results" or "it broke".
    const r = await cli(['info', '/no/such/file.png', '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout.trim()) as { ok: boolean; error: string; exitCode: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(parsed.exitCode).toBe(1);
  });

  it('still writes the human sentence to stderr', async () => {
    // The JSON is for the script; the person watching the terminal should not
    // have to pipe through a parser to read an error.
    const r = await cli(['info', '/no/such/file.png', '--json']);
    expect(r.stderr).toMatch(/error/i);
  });

  it('leaves stdout empty on failure when --json was NOT asked for', async () => {
    // The corollary, and the reason this is safe: a plain run must not start
    // emitting JSON to stdout, or it would break every pipeline that reads it.
    const r = await cli(['info', '/no/such/file.png']);
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe('');
  });
});

describe.skipIf(!built)('CLI: batch --json is NDJSON', () => {
  let dir: string;
  let outDir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vecline-cli-'));
    outDir = join(dir, 'out');
    for (const name of ['a', 'b']) {
      await writeFile(join(dir, `${name}.png`), await encode(flatArtwork(40, 30), 'png'));
    }
  });

  it('emits one parseable record per line, not concatenated documents', async () => {
    // It used to print N pretty-printed objects back to back: JSON.parse failed
    // at the second, and line-by-line parsing failed at the first. Machine
    // readable in name only.
    const r = await cli(['batch', join(dir, '*.png'), '-o', outDir, '--json']);
    expect(r.code).toBe(0);

    const lines = r.stdout.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(() => JSON.parse(line), `line is not valid JSON: ${line.slice(0, 80)}`).not.toThrow();
    }
  });

  it('ends with a summary record so a truncated pipe is distinguishable', async () => {
    // "Finished with two failures" and "the pipe was cut after two files" look
    // identical without a terminator, and the difference matters in CI.
    const r = await cli(['batch', join(dir, '*.png'), '-o', outDir, '--json']);
    const records = r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const summary = records.at(-1)!;
    expect(summary.event).toBe('summary');
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('gives every record its own input path, because order is not stable', async () => {
    // Workers are concurrent, so a small file finishes ahead of a large one
    // queued before it. A consumer has to key on `input`, never on position.
    const r = await cli(['batch', join(dir, '*.png'), '-o', outDir, '--json']);
    const files = r.stdout.split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { input?: string; event?: string })
      .filter((rec) => rec.event !== 'summary');
    expect(files).toHaveLength(2);
    for (const rec of files) expect(rec.input).toBeTruthy();
    expect(new Set(files.map((f) => f.input)).size).toBe(2);
  });
});

describe.skipIf(!built)('CLI: contradictory strategies are refused', () => {
  let png: string;
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vecline-conflict-'));
    png = join(dir, 'flat.png');
    await writeFile(png, await encode(flatArtwork(40, 30), 'png'));
  });

  it('refuses --lossless together with a different --mode', async () => {
    // `-l` used to overwrite `-m` in silence, so this produced a real result
    // that was not the one asked for, with nothing to suggest otherwise.
    const r = await cli(['vectorize', png, '-m', 'embed', '-l', '-o', join(tmpdir(), 'x.svg')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('two different strategies');
  });

  it('still allows --lossless with the redundant --mode lossless', async () => {
    // Saying the same thing twice is not a contradiction, and rejecting it
    // would break a command line that was never wrong.
    const r = await cli(['vectorize', png, '-m', 'lossless', '-l', '-o', join(tmpdir(), 'y.svg'), '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).lossless).toBe(true);
  });

  it('still allows --lossless on its own', async () => {
    const r = await cli(['vectorize', png, '-l', '-o', join(tmpdir(), 'z.svg'), '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).lossless).toBe(true);
  });
});

describe.skipIf(!built)('CLI: verify scores foreign SVGs fairly', () => {
  let src: string;
  let opaque: string;
  let transparent: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vecline-ground-'));
    src = join(dir, 'source.png');
    await writeFile(src, await encode(flatArtwork(60, 40), 'png'));
    // The same artwork twice. Most tracers — potrace and vtracer among them —
    // emit the transparent form, so it is the normal input when measuring a
    // competitor, not a curiosity.
    opaque = join(dir, 'opaque.svg');
    transparent = join(dir, 'transparent.svg');
    const shape = '<circle cx="30" cy="20" r="14" fill="#d64541"/>';
    await writeFile(opaque, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="40" fill="#ffffff"/>${shape}</svg>`);
    await writeFile(transparent, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40">${shape}</svg>`);
  });

  const ssimOf = (out: string): number => Number(JSON.parse(out.trim()).ssim);

  it('scores a transparent SVG the same as the identical opaque one', async () => {
    // This is the whole point. Without the flag the two differ by an order of
    // magnitude, and the transparent one — anybody else's output — loses.
    const a = await cli(['verify', src, opaque, '--json']);
    const b = await cli(['verify', src, transparent, '--render-background', '#ffffff', '--json']);
    expect(ssimOf(b.stdout)).toBeCloseTo(ssimOf(a.stdout), 6);
  });

  it('warns when the candidate is transparent and the reference is not', async () => {
    // Silence here is what made the wrong number look like a real measurement.
    const r = await cli(['verify', src, transparent]);
    expect(r.stderr).toContain('--render-background');
    expect(r.stderr).toMatch(/transparent/i);
  });

  it('does not warn when the flag was given', async () => {
    const r = await cli(['verify', src, transparent, '--render-background', '#ffffff']);
    expect(r.stderr).not.toContain('--render-background');
  });

  it('leaves the default scoring untouched', async () => {
    // The flag must add a capability, not silently move numbers people have
    // already recorded. An opaque candidate scores the same either way.
    const withFlag = await cli(['verify', src, opaque, '--render-background', '#ffffff', '--json']);
    const without = await cli(['verify', src, opaque, '--json']);
    expect(ssimOf(withFlag.stdout)).toBeCloseTo(ssimOf(without.stdout), 9);
  });
});

describe.skipIf(!built)('CLI: --help groups the big commands', () => {
  it('splits vectorize into named groups instead of one flat block', async () => {
    // 56 options in declaration order put --adaptive-t between --adaptive-window
    // and --stroke-width. Exhaustive and unreadable at the same time.
    const r = await cli(['vectorize', '--help']);
    for (const heading of [
      'Strategy:',
      'Colour and palette:',
      'Geometry and curve fitting:',
      'Thresholding (bilevel / line art):',
      'Pixel mode:',
      'Budgets and measurement:',
      'Transparency and background:',
      'Output and document:',
    ]) {
      expect(r.stdout, `missing group: ${heading}`).toContain(`\n${heading}\n`);
    }
  });

  it('leaves --help in its own section, not in whichever group came last', async () => {
    // Commander synthesises it after everything declared, so a positional rule
    // silently files it under the final group.
    const r = await cli(['vectorize', '--help']);
    // Reported with the tail of the output, because vitest truncates a 6 KB
    // received value and the preview then says nothing about whether the section
    // was present, absent, or merely formatted differently.
    const tail = r.stdout.slice(-300);
    expect(r.stdout, `help did not end with an ungrouped Options section. tail:\n${tail}`)
      .toMatch(/\nOptions:\n\s+-h, --help/);
  });

  /**
   * Help must survive a pipe, whole.
   *
   * `process.exit()` does not wait for stdout to drain, and a pipe on macOS holds
   * 8192 bytes. `vectorize --help` is now 8517, so the last 325 — the entire
   * trailing `Options:` section — were discarded whenever help was piped or
   * redirected. It printed in full to a terminal, which is why nobody saw it, and
   * only the macOS leg of CI ever failed, because Linux pipes hold 64 KB.
   *
   * This asserts the property rather than the platform: the output is captured
   * through a pipe, and it must be complete and end where help ends. Anything
   * that reintroduces an un-drained exit fails here on every OS whose pipe is
   * smaller than the help text.
   */
  it('delivers the whole of a >8KB help text through a pipe', async () => {
    const r = await cli(['vectorize', '--help']);
    expect(r.code).toBe(0);
    // Guard the guard: if help ever shrinks below a pipe buffer this test stops
    // proving anything, and should be pointed at a longer command instead.
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(8192);
    // The last thing help writes. Present => nothing was dropped.
    expect(r.stdout.trimEnd().endsWith('display help for command')).toBe(true);
  });

  it('does not change commands that declare no groups', async () => {
    // The whole design rests on this: grouping is opt-in per command, and a
    // command that opts out must render exactly as commander would.
    const r = await cli(['palette', '--help']);
    expect(r.stdout).toContain('Options:');
    expect(r.stdout).toMatch(/-c, --colors <n>\s+palette size/);
    // No stray group headings leaked in from the root configuration.
    expect(r.stdout).not.toContain('Geometry and curve fitting:');
  });

  it('keeps the did-you-mean suggestion working', async () => {
    // The alternative implementation (emptying visibleOptions and printing via
    // addHelpText) silently kills these, which is worst on the command with the
    // most options.
    const r = await cli(['vectorize', 'x.png', '--palete', '4']);
    expect(r.stderr).toContain('--palette');
  });
});

describe.skipIf(!built)('CLI: exit codes are documented', () => {
  it('explains 0, 1 and 2 in --help', async () => {
    // They were designed deliberately — 1 is "could not run", 2 is "ran, and the
    // assertion failed" — and documented nowhere, so every script had to
    // rediscover them by experiment.
    const r = await cli(['--help']);
    expect(r.stdout).toContain('Exit codes:');
    expect(r.stdout).toMatch(/2\s+the command ran/);
  });
});

describe.skipIf(!built)('CLI: exports reach the primitive-aware writers', () => {
  let disc: string;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vecline-prim-'));
    disc = join(dir, 'disc.png');
    const size = 200, r = 70;
    const img = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        const inside = Math.hypot(x - size / 2, y - size / 2) < r;
        img.data[o] = inside ? 214 : 255;
        img.data[o + 1] = inside ? 69 : 255;
        img.data[o + 2] = inside ? 65 : 255;
        img.data[o + 3] = 255;
      }
    }
    await writeFile(disc, await encode(img, 'png'));
  });

  // These assert the WIRING, not the writers. The writers have their own unit
  // tests, and they passed for a fortnight while the CLI silently never handed
  // them the annotation: `convert` decides per format whether to detect
  // primitives at all, PDF learned to consume them in a later change, and the
  // list of formats that receive them was not updated. Result — a feature that
  // worked when called as a library and did nothing when called as a tool.
  //
  // A unit test on toPdf cannot catch that. Only running the binary can.
  for (const [ext, marker] of [['pdf', / c\n/], ['eps', / 0 360 arc/]] as const) {
    it(`${ext} export receives the primitive annotation`, async () => {
      const out = join(tmpdir(), `vecline-prim-check.${ext}`);
      const r = await cli(['convert', disc, out]);
      expect(r.code).toBe(0);
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(out, 'latin1');
      expect(text, `${ext} fell back to the flattened polygon`).toMatch(marker);
    });
  }

  it('dxf still declares a CIRCLE entity', async () => {
    const out = join(tmpdir(), 'vecline-prim-check.dxf');
    const r = await cli(['convert', disc, out]);
    expect(r.code).toBe(0);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(out, 'utf8')).toContain('CIRCLE');
  });
});

describe.skipIf(!built)('CLI: converting an animation says what it dropped', () => {
  /**
   * The raster pipeline is single-frame by architecture — `decodeRaster` returns
   * one `RasterImage` and `encodeRaster` takes one — so `convert` writes the first
   * frame of an animation. That is a defensible limit. Reporting
   * "✓ out.gif  gif → gif  300.9 KB → 72.9 KB (-76%)" while 35 frames went in the
   * bin was not: the -76% *was* the discarded frames, and the decoder had known the
   * true count all along (`meta.frames`).
   */
  const dir = mkdtempSync(join(tmpdir(), 'vecline-anim-'));

  /**
   * A tiny animated GIF, built the way test/animate.ts already does it: an array
   * of encoded frames joined with `{ join: { animated: true } }`. A raw vertical
   * filmstrip plus `pageHeight` does NOT work — sharp writes it as one tall still
   * image, which is how the first version of this test passed against a
   * single-frame fixture and proved nothing.
   */
  async function animatedGif(count: number): Promise<string> {
    const sharpMod = (await import('sharp')).default;
    const size = 8;
    const frames = await Promise.all(
      Array.from({ length: count }, (_, f) => {
        const buf = Buffer.alloc(size * size * 4);
        for (let i = 0; i < buf.length; i += 4) {
          buf[i] = (f * 50) % 256; buf[i + 1] = 40; buf[i + 2] = 200; buf[i + 3] = 255;
        }
        return sharpMod(buf, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
      }),
    );
    const out = join(dir, `anim-${count}.gif`);
    await sharpMod(frames, { join: { animated: true } })
      .gif({ delay: frames.map(() => 100), loop: 0 })
      .toFile(out);
    return out;
  }

  it('the fixture really is animated, or the rest of this proves nothing', async () => {
    const sharpMod = (await import('sharp')).default;
    const meta = await sharpMod(await animatedGif(5), { animated: true }).metadata();
    expect(meta.pages).toBe(5);
  });

  it('names the frame count and points at the command that keeps them', async () => {
    const src = await animatedGif(5);
    const r = await cli(['convert', src, join(dir, 'first.gif')]);
    expect(r.code).toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).toMatch(/5 frames/);
    expect(all).toMatch(/4 frames were not carried over/);
    expect(all).toMatch(/vecline animate/);
  });

  it('reports both counts in --json, so a script can detect it', async () => {
    const src = await animatedGif(3);
    const r = await cli(['convert', src, join(dir, 'j.png'), '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.sourceFrames).toBe(3);
    expect(j.framesWritten).toBe(1);
  });

  it('stays quiet for a still image', async () => {
    // The note must not fire on the overwhelmingly common case.
    const src = join(dir, 'still.png');
    const sharpMod = (await import('sharp')).default;
    await sharpMod({ create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png().toFile(src);
    const r = await cli(['convert', src, join(dir, 'still-out.png')]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/not carried over/);
  });
});

describe.skipIf(!built)('CLI: vectorize refuses a non-SVG output name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vecline-ext-'));

  it('does not write an SVG under a .dxf name', async () => {
    // It used to. `vectorize logo.png -o logo.dxf` produced an SVG document
    // called logo.dxf and said nothing — a file that opens in a browser and
    // fails in every CAD tool, which is the one place a .dxf is going.
    const src = join(dir, 'in.png');
    const sharpMod = (await import('sharp')).default;
    await sharpMod({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } } })
      .png().toFile(src);

    const r = await cli(['vectorize', src, '-o', join(dir, 'out.dxf')]);
    expect(r.code).not.toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).toMatch(/vectorize writes SVG/);
    // It must name the command that does work.
    expect(all).toMatch(/vecline convert/);
    expect(existsSync(join(dir, 'out.dxf'))).toBe(false);
  });

  it('still accepts .svg and the default output', async () => {
    const src = join(dir, 'in2.png');
    const sharpMod = (await import('sharp')).default;
    await sharpMod({ create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } } })
      .png().toFile(src);

    const r = await cli(['vectorize', src, '-o', join(dir, 'out.svg')]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'out.svg'))).toBe(true);
  });
});
