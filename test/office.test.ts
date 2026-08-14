import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { convertOffice, findSoffice, buildSofficeArgs, OFFICE_FORMATS } from '../src/io/office.js';

/**
 * Faithful Office⇄PDF needs LibreOffice, which is not bundled and not present in
 * CI. The conversion is driven through an injectable runner so the whole
 * orchestration — arg building, picking up LibreOffice's output file, moving it
 * to the requested path — is verified deterministically with a stand-in for the
 * engine. The real spawn path is exercised only for its error handling.
 */

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'pixvec-office-test-')); });
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
  it('honours PIXVEC_SOFFICE when it points at a real file', async () => {
    const fake = join(dir, 'soffice-marker');
    await writeFile(fake, '');
    const prev = process.env.PIXVEC_SOFFICE;
    process.env.PIXVEC_SOFFICE = fake;
    try {
      expect(findSoffice()).toBe(fake);
    } finally {
      if (prev === undefined) delete process.env.PIXVEC_SOFFICE; else process.env.PIXVEC_SOFFICE = prev;
    }
  });

  it('returns null or a real path, never throws', () => {
    const prev = process.env.PIXVEC_SOFFICE;
    delete process.env.PIXVEC_SOFFICE;
    try {
      const r = findSoffice();
      expect(r === null || typeof r === 'string').toBe(true);
    } finally {
      if (prev !== undefined) process.env.PIXVEC_SOFFICE = prev;
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
    await expect(convertOffice('a.docx', join(dir, 'noext'), { run: fakeSoffice })).rejects.toThrow(/extension/);
  });

  it('reports an unsupported conversion when the engine produces nothing', async () => {
    const noop = async () => { /* engine wrote no file */ };
    await expect(convertOffice('a.docx', join(dir, 'x.pdf'), { run: noop })).rejects.toThrow(/no PDF|unsupported/i);
  });

  it('gives an actionable error when LibreOffice is not installed', async () => {
    // A bogus binary → ENOENT → the install-guidance message.
    await expect(
      convertOffice('a.docx', join(dir, 'y.pdf'), { soffice: join(dir, 'definitely-not-soffice') }),
    ).rejects.toThrow(/LibreOffice was not found/);
  });

  it('lists the common formats it bridges', () => {
    for (const f of ['pdf', 'docx', 'xlsx', 'pptx', 'odt']) expect(OFFICE_FORMATS).toContain(f);
  });
});
