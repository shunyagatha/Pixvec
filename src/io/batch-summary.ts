/**
 * Markdown report for a `pixvec batch` run — designed to drop straight into a
 * GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`). Pure string formatting,
 * kept out of `cli.ts` so it can be tested without running the program.
 */

export interface BatchRow {
  file: string;
  target: string;
  inBytes: number;
  outBytes: number;
}

/** Render a batch run as a Markdown report: a headline plus a per-file table. */
export function formatBatchSummary(rows: BatchRow[], done: number, failed: number): string {
  const totalIn = rows.reduce((s, r) => s + r.inBytes, 0);
  const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);

  const lines = [
    '## pixvec',
    '',
    `${done} converted${failed ? `, **${failed} failed**` : ''}. ` +
      `Total ${fmtBytes(totalIn)} → ${fmtBytes(totalOut)} (${change(totalOut, totalIn)}).`,
    '',
    '| File | Output | In | Out | Change |',
    '|---|---|--:|--:|--:|',
    ...rows.map((r) => `| ${r.file} | ${r.target} | ${fmtBytes(r.inBytes)} | ${fmtBytes(r.outBytes)} | ${change(r.outBytes, r.inBytes)} |`),
    '',
  ];
  return lines.join('\n');
}

/** Signed size change as a percentage — positive means smaller. */
function change(out: number, inp: number): string {
  if (inp === 0) return '—';
  const pct = ((inp - out) / inp) * 100;
  return `${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
