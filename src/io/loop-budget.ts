import { getHeapStatistics } from 'node:v8';
import type { LoopBudgetGuard } from '../vectorize/contour.js';

/**
 * Refuse a trace the machine cannot finish, instead of letting V8 die.
 *
 * An image large enough used to end with `FATAL ERROR: Ineffective mark-compacts
 * near heap limit`, a V8 stack dump and exit 134 — no message, nothing written,
 * and no hint that the flag which would have made it work was one word away.
 *
 * The cause is not a leak. `TRACE_DEFAULTS.minArea` is 0 and is spread into
 * every call, so the adaptive despeckle floor never applies and a photograph
 * shatters into roughly one region per 3.45 px. That is deliberate: restoring
 * the floor costs 0.19–0.44 SSIM on the corpus and 0.445 at 24 MP, so the
 * detail is worth its memory. This does not second-guess that — it only
 * replaces the way the limit is reached.
 *
 * **Why a projection is acceptable here.** Predicting sizes to *choose* between
 * outputs was rejected for this codebase, because being wrong there silently
 * returns the worse file. This predicts in order to *refuse*, where being wrong
 * yields a clear error instead of a crash — and the estimate is measured, not
 * guessed: 70.8 B/edge at 24.1 MP and 73.5 B/edge at 0.4 MP.
 *
 * **Why it reads the heap rather than capping pixels.** The constraint is a
 * property of the process, not the image. A fixed cap refuses on a laptop what
 * a build server completes; the same code here adapts to both.
 */
export function heapLoopBudget(): LoopBudgetGuard {
  return (projectedBytes) => {
    const { heap_size_limit: limit, used_heap_size: used } = getHeapStatistics();
    if (limit <= 0) return null;

    const free = limit - used;
    if (projectedBytes <= free) return null;

    const mb = (n: number): string => `${Math.round(n / 1048576).toLocaleString('en-US')} MB`;
    return (
      `This image needs about ${mb(projectedBytes)} to trace its region outlines and only ` +
      `${mb(free)} of the ${mb(limit)} heap is free, so it was refused rather than run out ` +
      `of memory part-way. Nothing was written. Give it more room with ` +
      `NODE_OPTIONS=--max-old-space-size=8192, or use --min-area 16 to merge the specks a ` +
      `photograph shatters into (smaller and faster, at a real cost in detail), or ` +
      `--mode embed for a lossless result with no tracing at all.`
    );
  };
}
