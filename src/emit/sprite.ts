/**
 * SVG sprite / symbol-sheet generation.
 *
 * An icon system ships as one file: a `<svg>` full of `<symbol>`s, referenced
 * from the page with `<use href="#id">`. This packs many SVGs (traced icons, or
 * ones handed in) into that single sheet, deduplicating the boilerplate and
 * giving each a stable id. Pure string transformation.
 */

import { escapeAttr } from '../svg/build.js';

export interface SpriteItem {
  /** Symbol id, referenced as `<use href="#id">`. */
  id: string;
  /** The SVG source for this icon. */
  svg: string;
}

export interface SpriteOptions {
  /** Hide the sheet element itself (icons are only shown via `<use>`). Default true. */
  hidden?: boolean;
}

/** Pack SVGs into one `<symbol>` sprite sheet. */
export function svgSprite(items: SpriteItem[], opts: SpriteOptions = {}): string {
  const symbols = items.map(({ id, svg }) => {
    const viewBox = svg.match(/viewBox="([^"]*)"/)?.[1]
      ?? sizeToViewBox(svg)
      ?? '0 0 24 24';
    // The inner markup between the outer <svg …> and </svg>.
    const inner = svg
      .replace(/^[\s\S]*?<svg\b[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/<\?xml[\s\S]*?\?>/g, '')
      .trim();
    return `<symbol id="${escapeAttr(id)}" viewBox="${viewBox}">${inner}</symbol>`;
  });
  const hide = opts.hidden === false ? '' : ' aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"';
  return `<svg xmlns="http://www.w3.org/2000/svg"${hide}>${symbols.join('')}</svg>\n`;
}

/** Derive a viewBox from width/height when the SVG has no explicit one. */
function sizeToViewBox(svg: string): string | undefined {
  // Read only the opening <svg …> tag, and require a real delimiter before the
  // attribute so `stroke-width="2"` cannot be mistaken for `width`. A trailing
  // CSS unit (px) is tolerated; percentages have no absolute size, so skip them.
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? svg;
  const attr = (name: string): string | undefined =>
    openTag.match(new RegExp(`[\\s"']${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, 'i'))?.[1];
  const w = attr('width');
  const h = attr('height');
  return w && h ? `0 0 ${w} ${h}` : undefined;
}
