import { describe, expect, it } from 'vitest';
import { formatBatchSummary, type BatchRow } from '../src/io/batch-summary.js';

const rows: BatchRow[] = [
  { file: 'logo.png', target: 'logo.svg', inBytes: 8000, outBytes: 2000 }, // 75% smaller
  { file: 'hero.png', target: 'hero.svg', inBytes: 1000, outBytes: 1500 }, // 50% larger
];

describe('formatBatchSummary', () => {
  it('renders a Markdown table with a headline', () => {
    const md = formatBatchSummary(rows, 2, 0);
    expect(md).toContain('## graver');
    expect(md).toContain('| File | Output | In | Out | Change |');
    expect(md).toContain('| logo.png | logo.svg |');
    expect(md).toContain('| hero.png | hero.svg |');
    // Two data rows + header + separator.
    expect((md.match(/^\|/gm) ?? [])).toHaveLength(4);
  });

  it('reports savings as a signed percentage (− smaller, + larger)', () => {
    const md = formatBatchSummary(rows, 2, 0);
    expect(md).toContain('−75.0%'); // shrunk
    expect(md).toContain('+50.0%'); // grew
    // Totals: 9000 → 3500 = 61.1% smaller.
    expect(md).toContain('−61.1%');
  });

  it('surfaces failures in the headline', () => {
    expect(formatBatchSummary(rows, 1, 1)).toContain('**1 failed**');
    expect(formatBatchSummary(rows, 2, 0)).not.toContain('failed');
  });

  it('handles an empty run without dividing by zero', () => {
    const md = formatBatchSummary([], 0, 0);
    expect(md).toContain('## graver');
    expect(md).toContain('0 converted');
    expect(md).not.toContain('NaN');
  });

  it('formats byte sizes with units', () => {
    const md = formatBatchSummary([{ file: 'a', target: 'b', inBytes: 2 * 1024 * 1024, outBytes: 512 }], 1, 0);
    expect(md).toContain('2.0 MB');
    expect(md).toContain('512 B');
  });
});
