import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import type { RasterImage, Rgba } from '../types.js';

export interface RasterizeOptions {
  /** Directory used to resolve relative `<image href>` references. */
  baseDir?: string;
  /** Output width in pixels. Mutually exclusive with `height` / `scale`. */
  width?: number;
  /** Output height in pixels. */
  height?: number;
  /** Uniform zoom factor applied to the SVG's intrinsic size. */
  scale?: number;
  /** Resolution used to resolve physical units (`mm`, `pt`, `in`). Default 96. */
  dpi?: number;
  /** Painted underneath everything; leave undefined for a transparent result. */
  background?: Rgba;
  /** `geometricPrecision` (default) antialiases; `crispEdges` does not. */
  shapeRendering?: 'optimizeSpeed' | 'crispEdges' | 'geometricPrecision';
  textRendering?: 'optimizeSpeed' | 'optimizeLegibility' | 'geometricPrecision';
  /** `optimizeQuality` (default) filters when scaling embedded rasters. */
  imageRendering?: 'optimizeQuality' | 'optimizeSpeed';
  /** Extra directories to scan for fonts. */
  fontDirs?: string[];
  defaultFontFamily?: string;
  /** Resolve external `<image>` references into data URIs before rendering. */
  inlineImages?: boolean;
}

export interface RasterizeResult {
  image: RasterImage;
  /** The SVG's own width/height before any scaling was applied. */
  intrinsic: { width: number; height: number };
  /** Files pulled in to satisfy `<image href>` references. */
  inlined: string[];
}

const SHAPE_RENDERING = { optimizeSpeed: 0, crispEdges: 1, geometricPrecision: 2 } as const;
const TEXT_RENDERING = { optimizeSpeed: 0, optimizeLegibility: 1, geometricPrecision: 2 } as const;
const IMAGE_RENDERING = { optimizeQuality: 0, optimizeSpeed: 1 } as const;

/**
 * Render an SVG document to straight RGBA8.
 *
 * resvg hands back a *premultiplied* buffer. Un-premultiplying with
 * `round(c * 255 / a)` reproduces resvg's own PNG export bit for bit (verified
 * across every alpha level in the test suite), so this avoids a PNG
 * encode/decode round trip without giving up exactness.
 */
export async function rasterizeSvg(
  svg: string | Uint8Array,
  opts: RasterizeOptions = {},
): Promise<RasterizeResult> {
  let source = typeof svg === 'string' ? svg : new TextDecoder().decode(svg);
  const inlined: string[] = [];

  if (opts.inlineImages !== false && opts.baseDir) {
    source = await inlineExternalImages(source, opts.baseDir, inlined);
  }

  const render: ResvgRenderOptions = {
    dpi: opts.dpi ?? 96,
    shapeRendering: SHAPE_RENDERING[opts.shapeRendering ?? 'geometricPrecision'],
    textRendering: TEXT_RENDERING[opts.textRendering ?? 'optimizeLegibility'],
    imageRendering: IMAGE_RENDERING[opts.imageRendering ?? 'optimizeQuality'],
    logLevel: 'error',
    fitTo: resolveFit(opts),
    font: {
      loadSystemFonts: true,
      ...(opts.fontDirs?.length ? { fontDirs: opts.fontDirs } : {}),
      ...(opts.defaultFontFamily ? { defaultFontFamily: opts.defaultFontFamily } : {}),
    },
  };

  if (opts.background) {
    // Validate rather than trust. A caller passing something that is not an RGBA
    // object would otherwise stringify to `rgba(undefined,undefined,undefined,NaN)`
    // and surface as an opaque "invalid number at position 6" from the parser,
    // miles from the actual mistake.
    const { r, g, b, a } = opts.background;
    if (![r, g, b, a].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(
        `background must be an {r, g, b, a} object with numeric channels, got ` +
          `${JSON.stringify(opts.background)}`,
      );
    }
    render.background = a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`;
  }

  let resvg: Resvg;
  try {
    resvg = new Resvg(source, render);
  } catch (err) {
    throw new Error(`Failed to parse SVG: ${(err as Error).message}`);
  }

  const intrinsic = { width: resvg.width, height: resvg.height };
  const rendered = resvg.render();
  const premultiplied = rendered.pixels;

  const data = new Uint8ClampedArray(premultiplied.length);
  for (let i = 0; i < premultiplied.length; i += 4) {
    const a = premultiplied[i + 3];
    data[i + 3] = a;
    if (a === 255) {
      data[i] = premultiplied[i];
      data[i + 1] = premultiplied[i + 1];
      data[i + 2] = premultiplied[i + 2];
    } else if (a !== 0) {
      const f = 255 / a;
      data[i] = Math.round(premultiplied[i] * f);
      data[i + 1] = Math.round(premultiplied[i + 1] * f);
      data[i + 2] = Math.round(premultiplied[i + 2] * f);
    }
    // a === 0 leaves the zero-initialised transparent black in place.
  }

  return {
    image: { width: rendered.width, height: rendered.height, data },
    intrinsic,
    inlined,
  };
}

function resolveFit(opts: RasterizeOptions): ResvgRenderOptions['fitTo'] {
  if (opts.width !== undefined && opts.height !== undefined) {
    // resvg fits one axis at a time; width wins and the aspect ratio is kept.
    return { mode: 'width', value: Math.max(1, Math.round(opts.width)) };
  }
  if (opts.width !== undefined) return { mode: 'width', value: Math.max(1, Math.round(opts.width)) };
  if (opts.height !== undefined) return { mode: 'height', value: Math.max(1, Math.round(opts.height)) };
  if (opts.scale !== undefined && opts.scale !== 1) return { mode: 'zoom', value: opts.scale };
  return { mode: 'original' };
}

const IMAGE_TAG = /<image\b[^>]*?\/?>/gi;
const HREF_ATTR = /\b(?:xlink:href|href)\s*=\s*(["'])(.*?)\1/i;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Replace external `<image href="...">` targets with data URIs.
 *
 * resvg will not read sibling files on its own, so an SVG that references
 * `logo.png` renders as a hole. Inlining first is the difference between a
 * faithful render and a silently missing layer.
 */
async function inlineExternalImages(
  svg: string,
  baseDir: string,
  inlined: string[],
): Promise<string> {
  const tags = svg.match(IMAGE_TAG);
  if (!tags) return svg;

  const replacements = new Map<string, string>();

  for (const tag of tags) {
    const m = HREF_ATTR.exec(tag);
    if (!m) continue;
    const href = m[2].trim();
    if (!href || href.startsWith('data:') || href.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) continue; // http(s), etc.
    if (replacements.has(href)) continue;

    const rel = href.startsWith('file:') ? new URL(href).pathname.replace(/^\/([A-Za-z]:)/, '$1') : href;
    const decoded = safeDecode(rel);
    const abs = isAbsolute(decoded) ? decoded : resolve(baseDir, decoded);
    const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
    if (!mime) continue;

    try {
      const bytes = await readFile(abs);
      replacements.set(href, `data:${mime};base64,${bytes.toString('base64')}`);
      inlined.push(abs);
    } catch {
      // A missing reference is the SVG author's problem, not ours — render the
      // rest rather than failing the whole document.
    }
  }

  if (replacements.size === 0) return svg;

  return svg.replace(IMAGE_TAG, (tag) => {
    const m = HREF_ATTR.exec(tag);
    if (!m) return tag;
    const dataUri = replacements.get(m[2].trim());
    if (!dataUri) return tag;
    const attrName = m[0].slice(0, m[0].indexOf('=')).trim();
    return tag.replace(HREF_ATTR, () => `${attrName}="${dataUri}"`);
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Directory to resolve relative references against, given the SVG's own path. */
export function baseDirFor(svgPath: string | undefined): string | undefined {
  return svgPath ? dirname(resolve(svgPath)) : undefined;
}
