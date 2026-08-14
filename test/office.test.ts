import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { convertOffice, convertOfficeBatch, findSoffice, buildSofficeArgs, isOfficeDocument, OFFICE_FORMATS } from '../src/io/office.js';

/**
 * Faithful Office⇄PDF needs LibreOffice, which is not bundled and not present in
 * CI. The conversion is driven through an injectable runner so the whole
 * orchestration — arg building, picking up LibreOffice's output file, moving it
 * to the requested path — is verified deterministically with a stand-in for the
 * engine. The real spawn path is exercised only for its error handling.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vecline-office-test-'));
  // convertOffice checks the input exists before spawning; give the tests real
  // (dummy) inputs — the stand-in engine ignores their contents.
  for (const f of ['report.docx', 'scan.pdf', 'unsupp.docx', 'real.docx']) {
    await writeFile(join(dir, f), 'x');
  }
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** A stand-in for soffice: writes the output file LibreOffice would produce. */
async function fakeSoffice(_bin: string, args: string[]): Promise<void> {
  const outDir = args[args.indexOf('--outdir') + 1];
  const fmt = args[args.indexOf('--convert-to') + 1];
  const input = args[args.length - 1];
  await writeFile(join(outDir, `${basename(input, extname(input))}.${fmt}`), `converted:${fmt}`);
}

describe('buildSofficeArgs', () => {
  it('is the headless convert-to invocation', () => {
    expect(buildSofficeArgs('/in/report.docx', 'pdf', '/tmp/out')).toEqual([
      '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', '/tmp/out', '/in/report.docx',
    ]);
  });
});

describe('findSoffice', () => {
  it('honours VECLINE_SOFFICE when it points at a real file', async () => {
    const fake = join(dir, 'soffice-marker');
    await writeFile(fake, '');
    const prev = process.env.VECLINE_SOFFICE;
    process.env.VECLINE_SOFFICE = fake;
    try {
      expect(findSoffice()).toBe(fake);
    } finally {
      if (prev === undefined) delete process.env.VECLINE_SOFFICE; else process.env.VECLINE_SOFFICE = prev;
    }
  });

  it('returns null or a real path, never throws', () => {
    const prev = process.env.VECLINE_SOFFICE;
    delete process.env.VECLINE_SOFFICE;
    try {
      const r = findSoffice();
      expect(r === null || typeof r === 'string').toBe(true);
    } finally {
      if (prev !== undefined) process.env.VECLINE_SOFFICE = prev;
    }
  });
});

describe('convertOffice', () => {
  it('converts docx → pdf (orchestration verified with a stand-in engine)', async () => {
    const out = join(dir, 'report.pdf');
    const res = await convertOffice(join(dir, 'report.docx'), out, { run: fakeSoffice });
    expect(res.output).toBe(out);
    expect(await readFile(out, 'utf8')).toBe('converted:pdf');
  });

  it('works in reverse: pdf → docx', async () => {
    const out = join(dir, 'scan.docx');
    await convertOffice(join(dir, 'scan.pdf'), out, { run: fakeSoffice });
    expect(await readFile(out, 'utf8')).toBe('converted:docx');
  });

  it('rejects an output path without an extension', async () => {
    await expect(convertOffice(join(dir, 'real.docx'), join(dir, 'noext'), { run: fakeSoffice })).rejects.toThrow(/extension/);
  });

  it('reports a missing input clearly (not as an unsupported conversion)', async () => {
    await expect(
      convertOffice(join(dir, 'does-not-exist.docx'), join(dir, 'out.pdf'), { run: fakeSoffice }),
    ).rejects.toThrow(/not found/i);
  });

  it('creates the output parent directory if it does not exist', async () => {
    const src = join(dir, 'src.docx');
    await writeFile(src, 'x');
    const out = join(dir, 'nested', 'deep', 'out.pdf');
    await convertOffice(src, out, { run: fakeSoffice });
    expect(await readFile(out, 'utf8')).toBe('converted:pdf');
  });

  it('reports an unsupported conversion when the engine produces nothing', async () => {
    const noop = async () => { /* engine wrote no file */ };
    await expect(convertOffice(join(dir, 'unsupp.docx'), join(dir, 'x.pdf'), { run: noop })).rejects.toThrow(/no PDF|unsupported/i);
  });

  it('gives an actionable error when LibreOffice is not installed', async () => {
    // A bogus binary → ENOENT → the install-guidance message. (Real input so the
    // existence guard passes and we actually reach the spawn.)
    await expect(
      convertOffice(join(dir, 'real.docx'), join(dir, 'y.pdf'), { soffice: join(dir, 'definitely-not-soffice') }),
    ).rejects.toThrow(/LibreOffice was not found/);
  });

  it('lists the common formats it bridges', () => {
    for (const f of ['pdf', 'docx', 'xlsx', 'pptx', 'odt']) expect(OFFICE_FORMATS).toContain(f);
  });
});

describe('convertOfficeBatch', () => {
  const names = (results: Array<{ output?: string }>) => results.map((r) => (r.output ? basename(r.output) : '(failed)')).sort();

  it('converts every input into the output directory as <stem>.<ext>', async () => {
    const a = join(dir, 'batch', 'a.docx');
    const b = join(dir, 'batch', 'b.xlsx');
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    await mkdir(join(dir, 'batch'), { recursive: true });
    await wf(a, 'x'); await wf(b, 'x');
    const outDir = join(dir, 'batch-out');
    const results = await convertOfficeBatch([a, b], outDir, 'pdf', { run: fakeSoffice });
    expect(names(results)).toEqual(['a.pdf', 'b.pdf']);
    expect(await readFile(join(outDir, 'a.pdf'), 'utf8')).toBe('converted:pdf');
  });

  it('disambiguates same-named inputs from different folders (no overwrite)', async () => {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const d1 = join(dir, 'src1'); const d2 = join(dir, 'src2');
    await mkdir(d1, { recursive: true }); await mkdir(d2, { recursive: true });
    await wf(join(d1, 'report.docx'), 'x'); await wf(join(d2, 'report.docx'), 'x');
    const outDir = join(dir, 'dedup-out');
    const results = await convertOfficeBatch([join(d1, 'report.docx'), join(d2, 'report.docx')], outDir, 'pdf', { run: fakeSoffice });
    expect(names(results)).toEqual(['report-2.pdf', 'report.pdf']);
  });

  it("does not steal a real <stem>-2 input's natural name", async () => {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const d1 = join(dir, 'n1'); const d2 = join(dir, 'n2');
    await mkdir(d1, { recursive: true }); await mkdir(d2, { recursive: true });
    await wf(join(d1, 'report.docx'), 'x'); await wf(join(d2, 'report.docx'), 'x'); await wf(join(dir, 'report-2.docx'), 'x');
    const outDir = join(dir, 'natural-out');
    const results = await convertOfficeBatch(
      [join(d1, 'report.docx'), join(d2, 'report.docx'), join(dir, 'report-2.docx')], outDir, 'pdf', { run: fakeSoffice },
    );
    // The genuine report-2.docx keeps report-2.pdf; the duplicate is bumped past it.
    expect(names(results)).toEqual(['report-2.pdf', 'report-3.pdf', 'report.pdf']);
  });

  it('records a failed document and keeps converting the rest', async () => {
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const bad = join(dir, 'bad.docx'); const good = join(dir, 'good.docx');
    await mkdir(dir, { recursive: true }); await wf(bad, 'x'); await wf(good, 'x');
    const flaky = async (b: string, a: string[]): Promise<void> => {
      if (basename(a[a.length - 1]).startsWith('bad')) throw new Error('boom');
      await fakeSoffice(b, a);
    };
    const results = await convertOfficeBatch([bad, good], join(dir, 'flaky-out'), 'pdf', { run: flaky });
    expect(results.find((r) => r.input === bad)?.error).toMatch(/boom|LibreOffice/);
    expect(results.find((r) => r.input === good)?.output).toBeTruthy();
  });

  it('requires a target format', async () => {
    await expect(convertOfficeBatch(['a.docx'], join(dir, 'o'), '', { run: fakeSoffice })).rejects.toThrow(/target format/i);
  });
});

describe('isOfficeDocument', () => {
  it('recognises Office/ODF documents by extension, case-insensitively', () => {
    for (const p of ['a.docx', 'b.XLSX', 'c.pptx', 'd.odt', 'e.rtf', '/x/y.ODS']) {
      expect(isOfficeDocument(p)).toBe(true);
    }
  });
  it('rejects images, PDF and SVG (handled by other paths)', () => {
    for (const p of ['a.pdf', 'b.svg', 'c.png', 'd.jpg', 'e.txt', 'noext']) {
      expect(isOfficeDocument(p)).toBe(false);
    }
  });
});
