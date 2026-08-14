/**
 * Responsive image variant sets.
 *
 * One source image becomes a width ladder in modern formats (AVIF/WebP with a
 * JPEG/PNG fallback) plus ready-to-paste `<picture>` markup with `srcset`, so a
 * developer stops hand-writing the boilerplate that Core Web Vitals demands.
 * Node-only: it uses the resize + encode pipeline graver already ships.
 */

import { editImage } from '../ops.js';
import { encodeRaster } from '../io/encode.js';
import type { RasterFormat, RasterImage } from '../types.js';

export interface ResponsiveOptions {
  /** Target widths, largest also used as the `<img>` fallback. Default 320–1280. */
  widths?: number[];
  /** Formats, best-first. The last is the universal fallback. Default avif/webp/jpeg. */
  formats?: RasterFormat[];
  /** Base filename (no extension). Default `image`. */
  name?: string;
  /** Lossy quality. Default 74. */
  quality?: number;
  /** `alt` text for the `<img>`. */
  alt?: string;
  /** `sizes` attribute. Default `100vw`. */
  sizes?: string;
}

export interface ResponsiveVariant {
  name: string;
  width: number;
  format: RasterFormat;
  bytes: Uint8Array;
}

export interface ResponsiveSet {
  variants: ResponsiveVariant[];
  /** A `<picture>` element wiring every source and the fallback `<img>`. */
  html: string;
}

const EXT: Partial<Record<RasterFormat, string>> = {
  avif: 'avif', webp: 'webp', jpeg: 'jpg', png: 'png', tiff: 'tif', gif: 'gif',
};
const MIME: Partial<Record<RasterFormat, string>> = {
  avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
};

/** Generate a responsive variant set and its `<picture>` markup. */
export async function responsiveSet(image: RasterImage, opts: ResponsiveOptions = {}): Promise<ResponsiveSet> {
  const formats = opts.formats ?? ['avif', 'webp', 'jpeg'];
  const base = opts.name ?? 'image';
  const quality = opts.quality ?? 74;
  // Never upscale: cap the ladder at the source width.
  const widths = (opts.widths ?? [320, 640, 960, 1280])
    .filter((w) => w <= image.width)
    .sort((a, b) => a - b);
  if (widths.length === 0) widths.push(image.width);

  const variants: ResponsiveVariant[] = [];
  for (const w of widths) {
    const resized = w === image.width ? image : await editImage(image, { resize: { width: w } });
    for (const format of formats) {
      variants.push({
        name: `${base}-${w}.${EXT[format] ?? format}`,
        width: w,
        format,
        bytes: await encodeRaster(resized, { format, quality }),
      });
    }
  }

  const srcset = (format: RasterFormat): string =>
    widths.map((w) => `${base}-${w}.${EXT[format] ?? format} ${w}w`).join(', ');

  const fallback = formats[formats.length - 1];
  const sources = formats
    .slice(0, -1)
    .map((f) => `  <source type="${MIME[f] ?? `image/${f}`}" srcset="${srcset(f)}" sizes="${opts.sizes ?? '100vw'}">`)
    .join('\n');
  const largest = widths[widths.length - 1];
  const img =
    `  <img src="${base}-${largest}.${EXT[fallback] ?? fallback}" srcset="${srcset(fallback)}" ` +
    `sizes="${opts.sizes ?? '100vw'}" alt="${(opts.alt ?? '').replace(/"/g, '&quot;')}" loading="lazy" decoding="async">`;
  const html = `<picture>\n${sources}${sources ? '\n' : ''}${img}\n</picture>`;

  return { variants, html };
}
