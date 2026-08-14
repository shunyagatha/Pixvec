/**
 * PDF → raster pages.
 *
 * Rendering a PDF needs a full PDF engine, which vecline does not bundle — the
 * zero-dependency promise would not survive it. Instead this follows the same
 * bring-your-own pattern as the WASM codec registry: it dynamically loads the
 * optional [`mupdf`](https://www.npmjs.com/package/mupdf) package (pure WASM, no
 * native binary to compile) when — and only when — a PDF is actually rendered,
 * and gives a clear, actionable error if it is not installed. Node-only.
 */

import type { RasterImage } from '../types.js';

export interface PdfRenderOptions {
  /** Output scale relative to the PDF's native 72-dpi points. Default 2 (≈144 dpi). */
  scale?: number;
  /** Target resolution in dots-per-inch; overrides {@link scale} (dpi / 72). */
  dpi?: number;
  /** 0-based page indices to render. Default: every page. */
  pages?: number[];
}

/** True when the bytes look like a PDF (`%PDF-` within the first kilobyte). */
export function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true; // %PDF-
    }
  }
  return false;
}

/**
 * Which 0-based page indices a request resolves to: the given `pages` deduped,
 * range-clamped to `count` and sorted, or every page when none are named.
 * Exported so callers can label rendered pages by their real page number.
 */
export function resolvePageIndices(count: number, pages?: number[]): number[] {
  return pages && pages.length
    ? [...new Set(pages)].filter((p) => p >= 0 && p < count).sort((a, b) => a - b)
    : Array.from({ length: count }, (_, i) => i);
}

/** Render selected PDF pages to straight-RGBA {@link RasterImage}s. */
export async function renderPdfPages(bytes: Uint8Array, opts: PdfRenderOptions = {}): Promise<RasterImage[]> {
  const mupdf = await loadMupdf();
  const scale = opts.dpi && opts.dpi > 0 ? opts.dpi / 72 : (opts.scale ?? 2);

  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const wanted = resolvePageIndices(doc.countPages(), opts.pages);
    const out: RasterImage[] = [];
    for (const p of wanted) {
      // Own each page/pixmap in its own scope so a mid-loop render failure on one
      // page still frees that page's native (WASM) memory instead of leaking it.
      let page: MupdfPage | undefined;
      let pix: MupdfPixmap | undefined;
      try {
        page = doc.loadPage(p);
        pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
        out.push({
          width: pix.getWidth(),
          height: pix.getHeight(),
          // getPixels() is RGBA (alpha requested); copy into the owned buffer type.
          data: new Uint8ClampedArray(pix.getPixels()),
        });
      } finally {
        pix?.destroy?.();
        page?.destroy?.();
      }
    }
    return out;
  } finally {
    doc.destroy?.();
  }
}

/** How many pages a PDF has, without rendering any. */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    return doc.countPages();
  } finally {
    doc.destroy?.();
  }
}

/** Minimal shape of the parts of `mupdf` we use, so we need no dependency on its types. */
interface MupdfLike {
  Document: { openDocument(data: Uint8Array, magic: string): MupdfDoc };
  Matrix: { scale(sx: number, sy: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
}
interface MupdfDoc {
  countPages(): number;
  loadPage(n: number): MupdfPage;
  destroy?(): void;
}
interface MupdfPage {
  toPixmap(matrix: unknown, cs: unknown, alpha: boolean): MupdfPixmap;
  destroy?(): void;
}
interface MupdfPixmap {
  getWidth(): number;
  getHeight(): number;
  getPixels(): Uint8Array;
  destroy?(): void;
}

async function loadMupdf(): Promise<MupdfLike> {
  // A `string`-typed specifier keeps TypeScript from statically resolving an
  // optional dependency that consumers are not required to install; Node
  // resolves it at runtime, and a missing module becomes a clear message.
  const name: string = 'mupdf';
  try {
    return (await import(name)) as unknown as MupdfLike;
  } catch {
    throw new Error(
      "PDF rendering needs the optional 'mupdf' package (pure WASM, no native binary). " +
        'Install it with:  npm i mupdf',
    );
  }
}
