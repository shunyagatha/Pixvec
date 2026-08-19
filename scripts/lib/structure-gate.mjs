/**
 * The comparison half of the structure gate: measured rows against committed
 * baseline rows.
 *
 * SEPARATE FROM scripts/structure-report.mjs ON PURPOSE. The script's last line
 * is `process.exitCode = await main()`, which runs the whole tracer on import —
 * so a test that wanted to reach this logic would have to be guarded off from
 * the entrypoint, and a guard that silently stopped matching would turn
 * `npm run structure:check` into a command that prints nothing and exits 0. That
 * is the precise failure this project keeps rediscovering. Pure functions here,
 * no entrypoint, nothing to guard.
 */

/**
 * How far each figure may move before the gate calls it a change.
 *
 * `abs` is in the metric's own units (percentage points for the percentages,
 * SSIM points for SSIM, bytes for the sizes); `rel` is a fraction of the
 * baseline. A metric passes if it is inside EITHER allowance, so a count of 7 is
 * not held to 2% of 7.
 *
 * These are tight because the pipeline is deterministic — the same subject run
 * twice returns byte-identical SVG, and structure-report.mjs re-runs one and
 * reports `determinism` rather than assuming it. The allowances exist for benign
 * refactors, not for run-to-run noise.
 *
 * gzip is the loosest: it is the only figure produced by a library outside this
 * repo, and zlib's output moves between versions.
 */
export const TOLERANCE = {
  curvePct:    { abs: 0.5,   rel: 0,    unit: 'pp' },
  twinPct:     { abs: 0.5,   rel: 0,    unit: 'pp' },
  pxPerAnchor: { abs: 0.05,  rel: 0.02, unit: '' },
  segments:    { abs: 2,     rel: 0.02, unit: '' },
  subpaths:    { abs: 1,     rel: 0.02, unit: '' },
  fills:       { abs: 0,     rel: 0,    unit: '' },
  bytes:       { abs: 24,    rel: 0.02, unit: 'B' },
  gzip:        { abs: 24,    rel: 0.05, unit: 'B' },
  ssim:        { abs: 0.002, rel: 0,    unit: '' },
};

/**
 * Where a move is unambiguously good or bad, say which.
 *
 * `curvePct` is deliberately absent, and that absence is the whole argument for
 * a two-sided gate: more curves is the goal on smooth artwork and a defect on
 * the `keycap` subject, which is rectangles and belongs at 0%. `segments`,
 * `subpaths`, `pxPerAnchor` and `fills` are likewise costs whose right value is
 * a property of the subject, not of the direction of travel.
 */
export const DIRECTION = {
  twinPct: 'up-is-better',
  ssim: 'up-is-better',
  bytes: 'down-is-better',
  gzip: 'down-is-better',
};

export const fmt = (v) => (
  Number.isInteger(v) ? String(v) : Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
);

export const within = (measured, baseline, tol) => {
  const delta = Math.abs(measured - baseline);
  return delta <= tol.abs || delta <= Math.abs(baseline) * tol.rel;
};

/**
 * Every figure that moved, in either direction.
 *
 * Failing on movement rather than on movement-that-looks-bad is the design, and
 * it buys two things. "Better" is not a property of a number — see DIRECTION
 * above. And a one-sided gate whose baseline is never refreshed slowly loses the
 * ability to fail at all, because the real output drifts far above a floor
 * nobody updated; the committed baseline is data a change is expected to update
 * deliberately.
 */
export function diff(rows, baseline) {
  const problems = [];
  const byKey = new Map((baseline.rows ?? []).map((r) => [`${r.subject}|${r.producer}`, r]));
  const seen = new Set();

  for (const row of rows) {
    if (!row.gated) continue;
    const key = `${row.subject}|${row.producer}`;
    seen.add(key);
    const base = byKey.get(key);
    if (!base) {
      problems.push({ key, metric: '-', kind: 'new', message: `${key}  measured, but the baseline has no such row` });
      continue;
    }
    for (const [metric, tol] of Object.entries(TOLERANCE)) {
      const now = row[metric];
      const was = base[metric];

      // A figure the baseline has and this run does not is the most dangerous
      // shape of failure available: it is how a gate stops being able to fail
      // without saying so. SSIM is the one at risk — it needs the optional
      // renderer, and `quality` is simply absent when that is missing — and it
      // is the floor the whole structural side rests on, because without it
      // every structural axis is won outright by emitting a single ellipse.
      if (was != null && now == null) {
        problems.push({
          key, metric, kind: 'unmeasured',
          message: `${key}  ${metric}  baseline has ${fmt(was)}, this run measured nothing`
            + (metric === 'ssim'
              ? '. SSIM needs the optional renderer (@resvg/resvg-js); without it this gate has no fidelity floor.'
              : '.'),
        });
        continue;
      }
      if (now == null || was == null) continue;
      if (within(now, was, tol)) continue;

      const rose = now > was;
      const dir = DIRECTION[metric];
      const verdict = dir === undefined ? 'changed' : (dir === 'up-is-better') === rose ? 'better' : 'WORSE';
      problems.push({
        key, metric, kind: 'moved', verdict, was, now,
        message: `${key}  ${metric}  ${fmt(was)} -> ${fmt(now)}`
          + `  (${rose ? '+' : ''}${fmt(now - was)}${tol.unit ? ' ' + tol.unit : ''}, ${verdict})`,
      });
    }
  }

  for (const key of byKey.keys()) {
    if (!seen.has(key)) {
      problems.push({ key, metric: '-', kind: 'missing', message: `${key}  is in the baseline but this run did not produce it` });
    }
  }
  return problems;
}
