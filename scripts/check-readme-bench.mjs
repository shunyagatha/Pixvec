#!/usr/bin/env node
/**
 * Every number in the README's accuracy table must still be reproducible.
 *
 * The table is the project's central claim, and it has been wrong twice. Both
 * corrections are recorded in the README itself: v1.33.1 moved a row downwards
 * after `npm run compare` showed the `photo` preset scoring below plain `auto`
 * on real photographs, and v1.38.1 restated the vtracer rows after they turned
 * out to have been measured through a third-party binding rather than vtracer's
 * own binary — the README says plainly that the earlier claim was false.
 *
 * Both were found by a person deciding to re-run the harness. Nothing forced
 * it. A table that is only checked when someone remembers is a table that is
 * wrong for an unknown length of time.
 *
 * This compares the *published* rows against a fresh run rather than against a
 * committed snapshot, deliberately. A snapshot would let the README and the
 * measurements drift apart together while the check stayed green — it would
 * verify that we still agree with ourselves, not that the claim is true.
 *
 * Only `bench` is checked here. `compare` needs the corpus and a vtracer binary
 * and cannot run on a clean machine; those rows stay a manual re-run, and this
 * script says so rather than implying the whole README is covered.
 *
 *   node scripts/check-readme-bench.mjs
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bench's own formatting, so a row is compared exactly as it is published.
 *
 * Always KB, matching scripts/bench.mjs:146 — deliberately not the CLI's
 * B/KB/MB helper, which renders the 473-byte sprite as "473 B" where the table
 * says "0.5 KB". Two formatters would make this script fail on presentation and
 * call it drift, which is the one thing a guard like this must never do.
 */
const fmtBytes = (n) => `${(n / 1024).toFixed(1)} KB`;
const fmtPct = (r) => `${(r * 100).toFixed(2)}%`;
const fmtPsnr = (p) => (p === 'Infinity' ? '∞' : `${Number(p).toFixed(2)} dB`);

/** Strip markdown emphasis and surrounding space from a table cell. */
const cell = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

async function main() {
  const { stdout } = await run(process.execPath, [join(root, 'scripts', 'bench.mjs'), '--json'], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  const measured = JSON.parse(stdout);

  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const lines = readme.split('\n');
  const header = lines.findIndex((l) => l.includes('| Input | Mode | In | Out | Pixels exact |'));
  if (header === -1) {
    console.error('Could not find the accuracy table in README.md. If it was renamed, update this script.');
    process.exit(1);
  }

  // Rows run from the separator to the first blank line.
  const rows = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split('|').slice(1, -1).map(cell);
    if (cells.length >= 8) rows.push({ line: i + 1, cells });
  }
  if (rows.length === 0) {
    console.error('The accuracy table has no rows. That is either a formatting change or a mistake.');
    process.exit(1);
  }

  const problems = [];
  for (const { line, cells } of rows) {
    const [input, , inBytes, outBytes, exact, psnr, ssim, deltaE] = cells;

    // A published row is satisfied when SOME measured row for the same input
    // reproduces every number in it. The README merges `auto` and
    // `--preset photo` into one row because they resolve identically, so
    // matching on the input plus the values is the honest comparison — it does
    // not care how the modes are labelled, only that the claim holds.
    const candidates = measured.filter((m) => m.input === input);
    if (candidates.length === 0) {
      problems.push(`README:${line} — no measured row for input "${input}"`);
      continue;
    }
    const ok = candidates.some((m) =>
      fmtBytes(m.inputBytes) === inBytes &&
      fmtBytes(m.outputBytes) === outBytes &&
      fmtPct(m.exactRatio) === exact &&
      fmtPsnr(m.psnr) === psnr &&
      m.ssim.toFixed(4) === ssim &&
      m.deltaEMean.toFixed(3) === deltaE);

    if (!ok) {
      const near = candidates
        .map((m) => `      ${m.mode}→${m.resolvedMode}: ${fmtBytes(m.inputBytes)} | ${fmtBytes(m.outputBytes)} | ` +
          `${fmtPct(m.exactRatio)} | ${fmtPsnr(m.psnr)} | ${m.ssim.toFixed(4)} | ${m.deltaEMean.toFixed(3)}`)
        .join('\n');
      problems.push(
        `README:${line} — "${input}" no longer reproduces\n` +
        `    published: ${inBytes} | ${outBytes} | ${exact} | ${psnr} | ${ssim} | ${deltaE}\n` +
        `    measured:\n${near}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`\nThe README publishes ${problems.length} figure(s) this build does not reproduce:\n`);
    for (const p of problems) console.error(`  ${p}\n`);
    console.error("Re-run 'npm run bench' and update README.md, or explain the move in the table's note.");
    console.error('Numbers moving is not itself a bug — publishing them after they moved is.\n');
    process.exit(1);
  }

  console.log(`README accuracy table: ${rows.length} published rows all reproduce.`);
  console.log('Note: the comparison tables (npm run compare) need the corpus and a vtracer binary, so they are not covered here.');
}

await main();
