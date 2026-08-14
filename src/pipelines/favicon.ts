/**
 * Favicon / PWA icon-set generation.
 *
 * A single source image becomes the whole bundle a site needs — a multi-size
 * `favicon.ico`, Apple touch icon, 192/512 PWA icons (plus a maskable one), a
 * `manifest.webmanifest`, and the `<head>` HTML — so the tedious, error-prone
 * hand-assembly of an icon set collapses to one call. Node-only: it uses the
 * resize pipeline and the pure-TS ICO encoder vecline already ships.
 */

import { editImage } from '../ops.js';
import { encodeRaster } from '../io/encode.js';
import { encodeIco } from '../io/formats/index.js';
import { parseCssColor } from '../color.js';
import type { RasterImage } from '../types.js';

export interface FaviconOptions {
  /** App name for the manifest. Default `App`. */
  name?: string;
  /** Short name for the manifest. Defaults to `name`. */
  shortName?: string;
  /** Manifest `theme_color`. Default `#ffffff`. */
  themeColor?: string;
  /** Manifest `background_color`. Default `#ffffff`. */
  backgroundColor?: string;
}

export interface GeneratedFile {
  name: string;
  bytes: Uint8Array;
}

export interface FaviconSet {
  /** Every file to write (ico, PNGs, manifest). */
  files: GeneratedFile[];
  /** The web-app manifest as a plain object. */
  manifest: Record<string, unknown>;
  /** Ready-to-paste `<head>` markup. */
  html: string;
}

/** Sizes packed into `favicon.ico`. */
const ICO_SIZES = [16, 32, 48];

const PNG_ICONS: Array<{ name: string; size: number; maskable?: boolean }> = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
];

/** Build a complete favicon / PWA icon set from one source image. */
export async function faviconSet(image: RasterImage, opts: FaviconOptions = {}): Promise<FaviconSet> {
  const files: GeneratedFile[] = [];

  const square = async (size: number): Promise<RasterImage> =>
    editImage(image, { resize: { width: size, height: size, fit: 'cover' } });
  const png = (img: RasterImage): Promise<Uint8Array> => encodeRaster(img, { format: 'png' });

  // Multi-resolution .ico.
  const icoEntries = [];
  for (const s of ICO_SIZES) {
    icoEntries.push({ width: s, height: s, payload: await png(await square(s)) });
  }
  files.push({ name: 'favicon.ico', bytes: encodeIco(icoEntries) });

  const bg = parseCssColor(opts.backgroundColor ?? '#ffffff') ?? { r: 255, g: 255, b: 255, a: 255 };

  // Standalone PNG icons. The maskable one gets a real safe-zone: the icon at
  // 80% on a background-filled square, so a circular/rounded OS mask never clips
  // it (without this it was identical to the normal icon).
  for (const icon of PNG_ICONS) {
    let img: RasterImage;
    if (icon.maskable) {
      const inner = Math.round(icon.size * 0.8);
      const pad = Math.round((icon.size - inner) / 2);
      const scaled = await editImage(image, { resize: { width: inner, height: inner, fit: 'cover' } });
      img = await editImage(scaled, { extend: { top: pad, bottom: pad, left: pad, right: pad, background: bg } });
    } else {
      img = await square(icon.size);
    }
    files.push({ name: icon.name, bytes: await png(img) });
  }

  const name = opts.name ?? 'App';
  const manifest: Record<string, unknown> = {
    name,
    short_name: opts.shortName ?? name,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme_color: opts.themeColor ?? '#ffffff',
    background_color: opts.backgroundColor ?? '#ffffff',
    display: 'standalone',
  };
  files.push({
    name: 'manifest.webmanifest',
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const html = [
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" href="/icon-192.png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    `<meta name="theme-color" content="${manifest.theme_color}">`,
    '<link rel="manifest" href="/manifest.webmanifest">',
  ].join('\n');

  return { files, manifest, html };
}
