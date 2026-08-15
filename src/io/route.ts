/**
 * Which conversion does `vecline convert in out` mean?
 *
 * This lives in its own module, rather than inline in the CLI, so the rule can
 * be tested without importing `cli.ts` — which parses `process.argv` on import.
 *
 * The rule used to be "output extension decides", and that was wrong in a way
 * nobody noticed for months: every output extension that was not `.svg`,
 * `.dxf`, `.eps` or `.pdf` fell through to the rasterizer, which accepts only
 * SVG input. So `vecline convert photo.png thumb.webp` — an ordinary raster
 * conversion the library API has always supported — failed with "does not look
 * like an SVG". Of the 121 cells in the format matrix this project advertises,
 * 100 were unreachable from the command named `convert`.
 *
 * The input matters as much as the output, so both are inputs to the decision.
 */

/** What `convert` should do with a given (input, output) pair. */
export type ConvertRoute =
  /** Raster → SVG: trace, pixel-exact, or embed. */
  | 'vectorize'
  /** Raster → DXF/EPS/PDF via structured trace geometry. */
  | 'vector-export'
  /** SVG → raster: render at a size. */
  | 'rasterize'
  /** Raster → raster: decode, re-encode. */
  | 'raster-convert';

/**
 * Decide the route.
 *
 * @param outputExt Lower-cased output extension, including the leading dot.
 * @param inputIsSvg Whether the *input bytes* sniff as SVG. Sniffed, never
 *   inferred from the extension — a `.txt` holding `<svg>` is still an SVG, and
 *   a `.svg` holding a PNG is not.
 */
export function chooseConvertRoute(outputExt: string, inputIsSvg: boolean): ConvertRoute {
  const ext = outputExt.toLowerCase();
  if (ext === '.svg') return 'vectorize';
  if (ext === '.dxf' || ext === '.eps' || ext === '.pdf') return 'vector-export';
  return inputIsSvg ? 'rasterize' : 'raster-convert';
}
