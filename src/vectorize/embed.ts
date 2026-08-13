import sharp from 'sharp';
import { SvgDoc, escapeAttr } from '../svg/build.js';
import type { RasterImage, SourceMeta } from '../types.js';

/**
 * Lossless embedding: wrap the original encoded bytes in an `<image>` element.
 *
 * This is the only mode that is lossless in the strongest sense — the *file*
 * survives, not just the 8-bit rendering of it. A 16-bit PNG keeps its 16 bits;
 * an ICC profile keeps its profile; a JPEG is not re-encoded, so it does not
 * pick up a second generation of artefacts.
 *
 * The trade-off is honest and worth stating plainly: the result is an SVG
 * container around a bitmap. It scales by interpolation, not by geometry, and
 * you cannot edit the shapes in a vector editor. When someone needs "a real
 * SVG" they want `trace` or `pixel`; when they need "this exact image, in an
 * SVG", this is the correct answer and the other modes are not.
 */

export interface EmbedOptions {
  /**
   * `preserve` keeps the original bytes when the format is one every renderer
   * decodes. `png` re-encodes losslessly, which is often smaller for flat
   * artwork. `webp` is smaller again but browser-only (see below). `auto` picks
   * the smallest of the universally safe options.
   */
  strategy?: 'preserve' | 'png' | 'webp' | 'auto';
  /** Emit `xlink:href` for SVG 1.1 consumers instead of the SVG 2 `href`. */
  xlink?: boolean;
  /** `optimizeSpeed` asks renderers for nearest-neighbour scaling. */
  imageRendering?: 'auto' | 'optimizeQuality' | 'optimizeSpeed' | 'pixelated';
  title?: string;
  generator?: string;
}

export interface EmbedOutput {
  svg: string;
  /** Media type of the embedded payload. */
  mime: string;
  /** Bytes of the payload before base64 expansion. */
  payloadBytes: number;
  /** True when the original file bytes were carried through untouched. */
  bytesPreserved: boolean;
  notes: string[];
}

/**
 * Formats that every SVG renderer decodes from a data URI.
 *
 * WebP is deliberately absent. Browsers handle it, but resvg — and any librsvg
 * built without WebP — render a WebP `<image>` as nothing at all: no warning, no
 * fallback, just a blank document. A "lossless" file that silently disappears in
 * half the world's renderers is worse than a larger PNG, so WebP is opt-in only.
 */
const UNIVERSALLY_DECODABLE: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif']);

const WEBP_WARNING =
  'WebP payloads render in browsers but not in resvg or librsvg builds without ' +
  'WebP support, where the image silently renders as blank. Use --embed-strategy png ' +
  'for a payload that works everywhere.';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export async function vectorizeEmbed(
  img: RasterImage,
  original: Buffer,
  meta: SourceMeta,
  opts: EmbedOptions = {},
): Promise<EmbedOutput> {
  const strategy = opts.strategy ?? 'auto';
  const notes: string[] = [];

  const canPreserve =
    UNIVERSALLY_DECODABLE.has(meta.format) &&
    // A rotated EXIF orientation means the stored pixels are not what a viewer
    // shows. Re-encoding bakes the rotation in; preserving would render sideways
    // in any renderer that ignores EXIF, which includes resvg.
    (meta.orientation === undefined || meta.orientation <= 1) &&
    meta.frames <= 1;

  const candidates: Array<{ mime: string; bytes: Buffer; preserved: boolean }> = [];

  if (strategy === 'webp') {
    // Explicitly requested, so honour it — but say what it costs.
    notes.push(WEBP_WARNING);
    candidates.push({ mime: 'image/webp', bytes: await reencodeWebpLossless(img), preserved: false });
  } else {
    if (canPreserve && (strategy === 'preserve' || strategy === 'auto')) {
      candidates.push({ mime: MIME[meta.format], bytes: original, preserved: true });
    } else if (strategy === 'preserve' && meta.format === 'webp') {
      // The source really is WebP and the caller asked to keep its bytes.
      notes.push(WEBP_WARNING);
      candidates.push({ mime: 'image/webp', bytes: original, preserved: true });
    } else if (strategy === 'preserve' || strategy === 'auto') {
      if (meta.format === 'webp') {
        notes.push(`WebP source re-encoded as PNG for renderer compatibility. ${WEBP_WARNING}`);
      } else if (!UNIVERSALLY_DECODABLE.has(meta.format)) {
        notes.push(`${meta.format} is not decodable from a data URI everywhere; re-encoded as PNG.`);
      } else if (meta.orientation && meta.orientation > 1) {
        notes.push(`EXIF orientation ${meta.orientation} baked into the pixels; re-encoded as PNG.`);
      } else if (meta.frames > 1) {
        notes.push('Multi-frame source; only the first frame is embedded.');
      }
    }

    if (strategy === 'png' || strategy === 'auto' || candidates.length === 0) {
      candidates.push({ mime: 'image/png', bytes: await reencodePng(img), preserved: false });
    }
  }

  // `auto` picks the smallest; a tie breaks toward keeping the original bytes.
  candidates.sort((a, b) => a.bytes.length - b.bytes.length || (a.preserved ? -1 : 1));
  const chosen = candidates[0];

  if (chosen.mime === 'image/jpeg' && chosen.preserved) {
    notes.push(
      'JPEG payload kept verbatim — no re-encoding, so no second generation of ' +
        'artefacts. A verification pass may still show a difference of 1–3 levels ' +
        'per channel: that is the SVG renderer\'s JPEG decoder rounding its inverse ' +
        'DCT differently from the reference decoder, not data loss.',
    );
  }

  if (!chosen.preserved && meta.depth !== 'uchar') {
    notes.push(
      `Source is ${meta.depth}; the re-encoded payload is 8 bit per channel. ` +
        `Use --embed-strategy preserve to keep the original bit depth.`,
    );
  }

  const hrefAttr = opts.xlink ? 'xlink:href' : 'href';
  const rendering = opts.imageRendering && opts.imageRendering !== 'auto'
    ? ` image-rendering="${opts.imageRendering}"`
    : '';

  const doc = new SvgDoc({
    width: img.width,
    height: img.height,
    generator: opts.generator,
    title: opts.title,
  });

  const dataUri = `data:${chosen.mime};base64,${chosen.bytes.toString('base64')}`;
  doc.add(
    `<image width="${img.width}" height="${img.height}"${rendering} ` +
      `${hrefAttr}="${escapeAttr(dataUri)}"/>`,
  );

  let svg = doc.toString();
  if (opts.xlink) {
    svg = svg.replace(
      '<svg xmlns="http://www.w3.org/2000/svg"',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
    );
  }

  return {
    svg,
    mime: chosen.mime,
    payloadBytes: chosen.bytes.length,
    bytesPreserved: chosen.preserved,
    notes,
  };
}

function rawPipeline(img: RasterImage): sharp.Sharp {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  });
}

function reencodePng(img: RasterImage): Promise<Buffer> {
  return rawPipeline(img).png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();
}

function reencodeWebpLossless(img: RasterImage): Promise<Buffer> {
  return rawPipeline(img).webp({ lossless: true, effort: 6, quality: 100 }).toBuffer();
}
