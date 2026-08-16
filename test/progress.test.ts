import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { flatArtwork } from './fixtures.js';

/**
 * Progress and cancellation on the tracer.
 *
 * Four of six surfaces reported nothing at all while a conversion ran — the
 * CLI, the playground, the MCP server, and the Figma panel showed a status that
 * never even repainted. Each was free to invent its own vocabulary, and mostly
 * invented silence. These hooks exist so every surface says the same thing.
 *
 * Percentages describe position in the stage list, not work completed. Tracing
 * is one synchronous call that cannot be subdivided, so a bar that claimed to
 * know how much was left would be guessing — the stage names are the honest
 * signal, and the numbers only order them.
 */
describe('trace progress', () => {
  const image = flatArtwork(120, 90);

  it('reports named stages in ascending order', () => {
    const seen: [string, number][] = [];
    trace(image, { onProgress: (stage, pct) => seen.push([stage, pct]) });

    expect(seen.length).toBeGreaterThan(2);
    for (const [stage, pct] of seen) {
      expect(stage).not.toBe('');
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
    const pcts = seen.map(([, p]) => p);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
  });

  it('costs nothing when nobody is listening', () => {
    // The hooks are optional and must stay so: the engine is used from a
    // library, where a caller that does not want progress should not have to
    // pass a no-op to avoid one.
    expect(() => trace(image, {})).not.toThrow();
  });

  it('does not change the output', () => {
    // Reporting is observation, not participation.
    const quiet = trace(image, {});
    const watched = trace(image, { onProgress: () => {} });
    expect(watched.svg).toBe(quiet.svg);
  });
});

describe('trace cancellation', () => {
  const image = flatArtwork(120, 90);

  it('refuses to start when the signal is already aborted', () => {
    expect(() => trace(image, { signal: { aborted: true } })).toThrow(/abort/i);
  });

  it('stops at the next stage boundary once aborted mid-run', () => {
    // Aborting after a couple of stages proves the check is per-stage rather
    // than only at entry.
    let checks = 0;
    const signal = { get aborted(): boolean { return ++checks > 2; } };
    expect(() => trace(image, { signal })).toThrow(/abort/i);
    expect(checks).toBeGreaterThan(2);
  });

  it('throws rather than returning a partial trace', () => {
    // Half a trace is not a smaller trace, it is a wrong one — a caller must
    // not be able to mistake an abandoned run for a finished one.
    let result: unknown = 'unset';
    try {
      result = trace(image, { signal: { aborted: true } });
    } catch {
      result = 'threw';
    }
    expect(result).toBe('threw');
  });

  it('runs to completion when the signal never fires', () => {
    const r = trace(image, { signal: { aborted: false } });
    expect(r.svg).toContain('<svg');
  });
});
