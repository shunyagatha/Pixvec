/**
 * G-code / toolpath export — the end of the image→machine pipeline.
 *
 * Paired with centreline tracing, this turns a drawing into ready-to-run G-code
 * for a GRBL-style laser engraver or pen plotter: rapid travel with the tool up,
 * tool down, cut/draw along each stroke at a feed rate, tool up, repeat. A rare
 * end-to-end capability in JS — most tools stop at SVG and leave the user to
 * find a separate svg2gcode. Y is flipped to machine bed space (origin
 * bottom-left) and pixels scale to real units. Pure text.
 */

import type { Point } from '../../types.js';
import { n } from './shared.js';

export interface GcodeOptions {
  /** `mm` (G21) or `in` (G20). Default `mm`. */
  units?: 'mm' | 'in';
  /** `laser` toggles M3/M5; `pen` raises/lowers Z. Default `laser`. */
  mode?: 'laser' | 'pen';
  /** Cutting/drawing feed rate. Default 1000. */
  feed?: number;
  /** Travel (rapid) feed rate. Default 3000. */
  travelFeed?: number;
  /** Laser power `S` value. Default 1000. */
  power?: number;
  /** Units per pixel. Default 1. */
  scale?: number;
  /**
   * Source image height, for the Y flip to bed coordinates. Required — without
   * it every Y comes out negative and the job sits below the origin.
   */
  height: number;
  /** Pen-up Z height. Default 5. */
  penUp?: number;
  /** Pen-down Z height. Default 0. */
  penDown?: number;
}

/**
 * Serialise polylines (e.g. from `centerlinePolylines`) to G-code.
 *
 * `opts` is no longer optional: `height` is required, because it is what turns
 * image coordinates into bed coordinates.
 */
export function toGcode(polylines: Point[][], opts: GcodeOptions): string {
  const mode = opts.mode ?? 'laser';
  const feed = opts.feed ?? 1000;
  const travelFeed = opts.travelFeed ?? 3000;
  const power = opts.power ?? 1000;
  const s = opts.scale ?? 1;

  // Y is flipped into bed space as `height - y`, so without a height every
  // coordinate becomes negative: measured, a 64px drawing emitted Y from -62
  // to 0, which is the entire job off the bed. The old default of 0 made that
  // silent, and the first sign of it is a machine driving into its own limit.
  if (opts.height === undefined) {
    throw new Error(
      'toGcode: `height` is required — it is the source image height, used to flip Y into bed ' +
        'space. Without it every Y coordinate comes out negative and the whole job sits below ' +
        'the origin. Pass the height of the image the polylines came from.',
    );
  }
  const H = opts.height;

  // A program with no cutting moves is valid G-code and does nothing: header,
  // one rapid to origin, tool off, end. It happens whenever centreline found no
  // ink — a blank input, a threshold that caught everything, `--white-on-black`
  // the wrong way round — and the user discovers it at the machine.
  const cutting = polylines.filter((p) => p.length >= 2);
  if (cutting.length === 0) {
    throw new Error(
      'toGcode: there are no polylines to cut, so this would emit a valid program that does ' +
        'nothing. Centreline usually returns nothing because the image is blank, because the ' +
        'threshold caught the whole frame, or because the ink is light on dark and needs ' +
        '`blackOnWhite: false`.',
    );
  }

  const coord = (p: Point): string => `X${n(p.x * s)} Y${n((H - p.y) * s)}`;
  const toolOff = mode === 'laser' ? 'M5' : `G0 Z${n(opts.penUp ?? 5)}`;
  const toolOn = mode === 'laser' ? `M3 S${power}` : `G1 Z${n(opts.penDown ?? 0)} F${feed}`;

  const lines: string[] = [
    '; vecline G-code',
    `; mode=${mode} feed=${feed} ${opts.units ?? 'mm'}`,
    opts.units === 'in' ? 'G20' : 'G21',
    'G90',
    'G0 F' + travelFeed,
    toolOff,
  ];

  for (const poly of polylines) {
    if (poly.length < 2) continue;
    lines.push(`G0 ${coord(poly[0])}`);
    lines.push(toolOn);
    lines.push(`G1 ${coord(poly[1])} F${feed}`);
    for (let i = 2; i < poly.length; i++) lines.push(`G1 ${coord(poly[i])}`);
    lines.push(toolOff);
  }

  lines.push('G0 X0 Y0', mode === 'laser' ? 'M5' : `G0 Z${n(opts.penUp ?? 5)}`, 'M2');
  return lines.join('\n') + '\n';
}
