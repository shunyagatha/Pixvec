import { describe, expect, it, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
