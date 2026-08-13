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
export function fillAttrs(c: Rgba): string {
  const fill = ` fill="${shortHex(c.r, c.g, c.b)}"`;
  if (c.a >= 255) return fill;
  // Three decimals resolves all 256 alpha steps unambiguously (1/255 ≈ 0.0039).
  const o = (c.a / 255).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${fill} fill-opacity="${o.startsWith('0.') ? o.slice(1) : o}"`;
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
