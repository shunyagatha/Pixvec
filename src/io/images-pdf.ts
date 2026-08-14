/**
 * Images → one multi-page PDF.
 *
 * The complement of `pixvec doc` (PDF → images): stitch a stack of photos or
 * scans into a single PDF, one image per page. Each page embeds its image as a
 * JPEG stream (`DCTDecode`) sized to the page, so the file stays small and every
 * reader opens it. The PDF is assembled as raw bytes — a JPEG stream cannot
 * survive a round-trip through a JS string — with a correct cross-reference
 * table. Node-only: encoding the pages to JPEG uses the raster codec.
 */

import type { RasterImage } from '../types.js';
import { encodeRaster } from './encode.js';

export interface ImagePdfOptions {
  /** Pixels-per-inch used to size each page from its image. Default 96. */
  dpi?: number;
  /** JPEG quality for the embedded page images, 1–100. Default 85. */
  quality?: number;
  /** Background the pages are composited onto (images may have alpha). Default white. */
  background?: { r: number; g: number; b: number };
}

/** One already-encoded JPEG page and its pixel dimensions. */
export interface JpegPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** Encode images to JPEG and assemble them into a multi-page PDF. */
export async function imagesToPdf(images: RasterImage[], opts: ImagePdfOptions = {}): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('imagesToPdf needs at least one image.');
  const quality = opts.quality ?? 85;
  const bg = opts.background ?? { r: 255, g: 255, b: 255 };

  const pages: JpegPage[] = [];
  for (const img of images) {
    // JPEG has no alpha; composite over the background so transparency reads as
    // the page colour rather than the codec's default black.
    const opaque = flattenOver(img, bg);
    pages.push({ jpeg: await encodeRaster(opaque, { format: 'jpeg', quality }), width: img.width, height: img.height });
  }
  return assembleImagePdf(pages, { dpi: opts.dpi ?? 96 });
}

/** Assemble already-JPEG pages into a PDF (pure — no codec, exact byte offsets). */
export function assembleImagePdf(pages: JpegPage[], opts: { dpi?: number } = {}): Uint8Array {
  if (pages.length === 0) throw new Error('assembleImagePdf needs at least one page.');
  const dpi = opts.dpi ?? 96;
  // Guard against 0 / negative / NaN dpi, which would put Infinity or NaN in the
  // page MediaBox and produce a structurally-invalid PDF. (0 slips past `??`.)
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error(`dpi must be a positive finite number, got ${dpi}.`);
  const enc = new TextEncoder();

  const chunks: Uint8Array[] = [];
  let pos = 0;
  const put = (s: string | Uint8Array): void => {
    const b = typeof s === 'string' ? enc.encode(s) : s;
    chunks.push(b);
    pos += b.length;
  };

  // Object numbering: 1 catalog, 2 pages, then per page i: page=3+3i,
  // content=4+3i, image=5+3i.
  const pageObjNum = (i: number): number => 3 + i * 3;
  const offsets: number[] = []; // offsets[objNum-1] = byte offset
  const obj = (num: number, write: () => void): void => {
    offsets[num - 1] = pos;
    put(`${num} 0 obj\n`);
    write();
    put('\nendobj\n');
  };

  put('%PDF-1.7\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => {
    const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');
    put(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  });

  const ptPerPx = 72 / dpi;
  pages.forEach((page, i) => {
    const pw = round(page.width * ptPerPx);
    const ph = round(page.height * ptPerPx);
    const pageN = pageObjNum(i);
    const contentN = pageN + 1;
    const imageN = pageN + 2;

    obj(pageN, () => put(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`,
    ));

    // Draw the image to fill the page. The cm maps the unit image square onto
    // [0,0]-[pw,ph]; PDF images already run top-row-first, so it lands upright.
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(contentN, () => put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));

    obj(imageN, () => {
      put(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      put(page.jpeg);
      put('\nendstream');
    });
  });

  const total = 2 + pages.length * 3; // highest object number
  const xrefPos = pos;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) xref += `${String(offsets[i - 1] ?? 0).padStart(10, '0')} 00000 n \n`;
  put(xref);
  put(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  // Concatenate.
  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Composite a (possibly transparent) image over a solid background → opaque RGBA. */
function flattenOver(img: RasterImage, bg: { r: number; g: number; b: number }): RasterImage {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    out[o] = Math.round(data[o] * a + bg.r * (1 - a));
    out[o + 1] = Math.round(data[o + 1] * a + bg.g * (1 - a));
    out[o + 2] = Math.round(data[o + 2] * a + bg.b * (1 - a));
    out[o + 3] = 255;
  }
  return { width, height, data: out };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
