import type { Rgba } from '../types.js';
import { shortHex } from '../color.js';

export interface SvgDocOptions {
  width: number;
  height: number;
  /** Emitted as a comment at the top of the file. */
  generator?: string;
  /** `shape-rendering` on the root group. `crispEdges` disables antialiasing. */
  shapeRendering?: 'auto' | 'crispEdges' | 'optimizeSpeed' | 'geometricPrecision';
  /** Set on the root `<svg>`; omit for a document that scales freely. */
  emitDimensions?: boolean;
  /** Human-readable `<title>`. */
  title?: string;
}

/** Assembles an SVG 1.1 / SVG 2 compatible document from pre-serialised children. */
export class SvgDoc {
  private children: string[] = [];
  private defs: string[] = [];
  private idSeq = 0;
  private inkscapeNs = false;

  constructor(private readonly opts: SvgDocOptions) {}

  add(markup: string): this {
    this.children.push(markup);
    return this;
  }

  /**
   * Wrap markup in a named `<g>` that Inkscape and Illustrator recognise as an
   * editable **layer**, so a traced document opens as organised colour layers
   * rather than one flattened blob. Using this once declares the `inkscape`
   * namespace on the root; a document that never calls it is unchanged.
   */
  addLayer(label: string, id: string, markup: string): this {
    this.inkscapeNs = true;
    return this.add(
      `<g inkscape:groupmode="layer" inkscape:label="${escapeAttr(label)}" id="${escapeAttr(id)}">${markup}</g>`,
    );
  }

  /**
   * Register a `<defs>` entry — a gradient, a pattern — emitted once at the top
   * of the document and referenced by id from a `fill`. No `<defs>` element is
   * written unless something is added here, so a gradient-free document is
   * byte-for-byte what it was before.
   */
  addDef(markup: string): this {
    this.defs.push(markup);
    return this;
  }

  /** A document-unique id for a def, so two gradients never collide. */
  nextId(prefix = 'g'): string {
    return `${prefix}${this.idSeq++}`;
  }

  /** A full-canvas background rectangle. Cheaper than repeating the same fill. */
  addBackground(color: Rgba): this {
    const { width, height } = this.opts;
    return this.add(
      `<path d="M0 0h${width}v${height}H0z"${fillAttrs(color)}/>`,
    );
  }

  toString(): string {
    const { width, height, generator, shapeRendering, emitDimensions = true, title } = this.opts;

    const attrs = [
      'xmlns="http://www.w3.org/2000/svg"',
      `viewBox="0 0 ${width} ${height}"`,
    ];
    if (this.inkscapeNs) {
      attrs.push('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    }
    if (emitDimensions) {
      attrs.splice(1, 0, `width="${width}"`, `height="${height}"`);
    }
    if (shapeRendering && shapeRendering !== 'auto') {
      attrs.push(`shape-rendering="${shapeRendering}"`);
    }

    const head = generator ? `<!-- ${escapeComment(generator)} -->\n` : '';
    const titleEl = title ? `<title>${escapeText(title)}</title>` : '';
    const defsEl = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';

    return `${head}<svg ${attrs.join(' ')}>${titleEl}${defsEl}${this.children.join('')}</svg>\n`;
  }

  get childCount(): number {
    return this.children.length;
  }
}

/**
 * `fill` plus, when needed, `fill-opacity`.
 *
 * `fill="rgba(...)"` is CSS Color 4 and not every SVG 1.1 renderer accepts it,
 * so alpha goes through `fill-opacity` — which every renderer has supported
 * since 2001.
 */
/**
 * The opacity attribute value for an alpha, or null when it is fully opaque and
 * the attribute should be omitted.
 */
function opacityValue(a: number): string | null {
  if (a >= 255) return null;
  // Three decimals resolves all 256 alpha steps unambiguously (1/255 ≈ 0.0039).
  const o = (a / 255).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return o.startsWith('0.') ? o.slice(1) : o;
}

export function fillAttrs(c: Rgba): string {
  const fill = ` fill="${shortHex(c.r, c.g, c.b)}"`;
  const o = opacityValue(c.a);
  return o === null ? fill : `${fill} fill-opacity="${o}"`;
}

/**
 * Stroke attributes for the boundary hairline, carrying the same alpha the fill
 * does.
 *
 * Called "seam-hiding" here for years on the strength of where it came from
 * rather than any measurement. Measured, it is an accuracy gain — positive on 6
 * of 6 corpus subjects at width 0.5, for under 3% more bytes — because it repaints
 * the half-covered pixels along a region's boundary. It also paints outside the
 * silhouette, which is why no preset enables it. Numbers on `strokeWidth` in
 * `vectorize/trace.ts`.
 *
 * `fill-opacity` does not apply to strokes. Emitting the colour without
 * `stroke-opacity` therefore drew a fully opaque outline around a translucent
 * region — a hard ring at the region's own hue, most visible exactly where the
 * stroke was meant to be invisible. It lives beside {@link fillAttrs} so the
 * two cannot drift apart again.
 */
export function strokeAttrs(c: Rgba, width: number): string {
  if (!(width > 0)) return '';
  const base = ` stroke="${shortHex(c.r, c.g, c.b)}" stroke-width="${width}"`;
  const o = opacityValue(c.a);
  return o === null ? base : `${base} stroke-opacity="${o}"`;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** XML comments may not contain `--`. */
export function escapeComment(s: string): string {
  return s.replace(/--+/g, '-').replace(/-$/, '');
}
