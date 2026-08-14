/**
 * Office documents ⇄ PDF (and between Office formats).
 *
 * Faithfully rendering Word, Excel or PowerPoint needs a full office engine —
 * hundreds of megabytes. Bundling one would wreck vecline's lean install, so this
 * follows the same bring-your-own rule as the PDF and WASM-codec paths: it drives
 * the **user's own LibreOffice** through a plain child process, adding *zero*
 * dependencies. vecline stays tiny; the conversion stays local and private (no
 * cloud upload); and every format LibreOffice reads or writes is available in
 * both directions — `docx/xlsx/pptx/odt/ods/odp/rtf/html/csv/txt ⇄ pdf`.
 *
 * Node-only. If LibreOffice is not installed, the error says exactly how to get
 * it (or point `VECLINE_SOFFICE` at an existing binary).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** A representative set of formats LibreOffice converts among (for help/validation). */
export const OFFICE_FORMATS = [
  'pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html',
  'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp',
] as const;

/** Word/Excel/PowerPoint/ODF document extensions that render via LibreOffice. */
const OFFICE_DOC_EXTS = new Set(['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp']);

/** True when a path is an Office/ODF document (by extension) that needs LibreOffice to render. */
export function isOfficeDocument(path: string): boolean {
  return OFFICE_DOC_EXTS.has(extname(path).replace(/^\./, '').toLowerCase());
}

/** Locate a LibreOffice `soffice` binary, or `null` if none of the usual spots have one. */
export function findSoffice(): string | null {
  const env = process.env.VECLINE_SOFFICE || process.env.SOFFICE_PATH;
  if (env && existsSync(env)) return env;
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
      : process.platform === 'darwin'
        ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
        : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'];
  for (const c of candidates) if (existsSync(c)) return c;
  return null; // might still be on PATH; convertOffice falls back to bare 'soffice'
}

export interface OfficeConvertOptions {
  /** Explicit `soffice` binary. Defaults to {@link findSoffice} then PATH. */
  soffice?: string;
  /** Conversion timeout in ms. Default 120000. */
  timeoutMs?: number;
  /**
   * Test/advanced seam: perform the conversion given `(bin, args)`. Defaults to
   * spawning LibreOffice. Provided so the orchestration can be verified without
   * a real engine installed.
   */
  run?: (bin: string, args: string[]) => Promise<void>;
}

export interface OfficeConvertResult {
  output: string;
  /** The binary used, so callers can report how the conversion happened. */
  engine: string;
}

/** The LibreOffice conversion argv. Pure — testable without running anything. */
export function buildSofficeArgs(input: string, targetFilter: string, outDir: string): string[] {
  return ['--headless', '--norestore', '--convert-to', targetFilter, '--outdir', outDir, input];
}

/**
 * Convert `input` to `outPath` (target format inferred from its extension) using
 * LibreOffice. Works in both directions — `report.docx → report.pdf` and
 * `scan.pdf → scan.docx` — and between Office formats.
 */
export async function convertOffice(
  input: string,
  outPath: string,
  opts: OfficeConvertOptions = {},
): Promise<OfficeConvertResult> {
  const bin = opts.soffice ?? findSoffice() ?? 'soffice';
  const targetExt = extname(outPath).replace(/^\./, '').toLowerCase();
  if (!targetExt) throw new Error('The output path needs an extension, e.g. -o out.pdf');

  // Resolve to an absolute path so LibreOffice never mistakes a filename that
  // starts with '-' for an option, and so relative inputs work from any cwd.
  const absInput = resolve(input);
  if (!existsSync(absInput)) throw new Error(`Input not found: ${input}`);

  const tmp = await mkdtemp(join(tmpdir(), 'vecline-office-'));
  try {
    const args = buildSofficeArgs(absInput, targetExt, tmp);
    const run = opts.run ?? ((b, a) => spawnSoffice(b, a, opts.timeoutMs ?? 120_000));
    await run(bin, args);

    // LibreOffice writes `<inputStem>.<ext>` into the --outdir; move it to the
    // path the caller actually asked for.
    const produced = join(tmp, `${basename(absInput, extname(absInput))}.${targetExt}`);
    if (!existsSync(produced)) {
      throw new Error(
        `LibreOffice produced no ${targetExt.toUpperCase()} — the conversion from ` +
          `${extname(absInput) || 'that format'} to .${targetExt} may be unsupported.`,
      );
    }
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(outPath, await readFile(produced));
    return { output: outPath, engine: bin };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** One entry in a {@link convertOfficeBatch} run: an output path, or an error. */
export interface OfficeBatchResult {
  input: string;
  /** Written path on success. */
  output?: string;
  /** Failure message; the batch continues past a failed file. */
  error?: string;
}

/**
 * Convert many documents into `outDir`, one output each, named `<stem>.<ext>`.
 * A file that fails to convert is recorded and the batch continues — a 50-file
 * run never dies on file #30. Same-named inputs from different folders are
 * disambiguated so none is silently overwritten, *and* a real `<stem>-2` input
 * keeps its natural name (the suffix skips names another input already owns).
 * Sequential — LibreOffice serialises on one user profile anyway.
 */
export async function convertOfficeBatch(
  inputs: string[],
  outDir: string,
  targetExt: string,
  opts: OfficeConvertOptions = {},
): Promise<OfficeBatchResult[]> {
  const ext = targetExt.replace(/^\./, '').toLowerCase();
  if (!ext) throw new Error('A target format is required, e.g. --to pdf');
  await mkdir(outDir, { recursive: true });

  const natural = inputs.map((i) => `${basename(i, extname(i))}.${ext}`);
  const naturalSet = new Set(natural);
  const used = new Set<string>();
  const results: OfficeBatchResult[] = [];

  for (let idx = 0; idx < inputs.length; idx++) {
    let name = natural[idx];
    if (used.has(name)) {
      const stem = basename(inputs[idx], extname(inputs[idx]));
      // Skip a suffixed name that some *other* input claims as its natural name.
      let k = 2;
      let cand = `${stem}-${k}.${ext}`;
      while (used.has(cand) || (naturalSet.has(cand) && cand !== natural[idx])) cand = `${stem}-${++k}.${ext}`;
      name = cand;
    }
    used.add(name);
    const out = join(outDir, name);
    try {
      const res = await convertOffice(inputs[idx], out, opts);
      results.push({ input: inputs[idx], output: res.output });
    } catch (e) {
      results.push({ input: inputs[idx], error: (e as Error).message });
    }
  }
  return results;
}

function spawnSoffice(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (!err) return resolve();
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(new Error(
          'LibreOffice was not found. vecline drives your local LibreOffice for ' +
            'Office⇄PDF conversion — nothing is bundled, so the install stays tiny. ' +
            'Install it from https://www.libreoffice.org/ (or `brew install --cask libreoffice`, ' +
            '`apt install libreoffice`), or point VECLINE_SOFFICE at the soffice binary.',
        ));
      } else {
        reject(new Error(`LibreOffice conversion failed: ${(err as Error).message}`));
      }
    });
  });
}
