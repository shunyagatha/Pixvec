/**
 * Lazy access to the two native addons, so that "optional" means optional.
 *
 * `sharp` and `@resvg/resvg-js` are declared in `optionalDependencies`, and the
 * install instructions offer `--omit=optional` as a supported way to take the
 * portable core alone. That combination did not work: both packages were
 * imported at module top level, so an install without them produced a **totally
 * dead tool** — `vecline --version` exited on a raw
 * `ERR_MODULE_NOT_FOUND` stack trace from Node's module reader, with no hint
 * that a codec was missing or which one.
 *
 * Loading them on first use fixes that, and costs nothing at the call sites:
 * every one of the six was already inside an `async` function.
 *
 * Two details make this work rather than merely look like it works:
 *
 * - **The specifier is typed `string`.** TypeScript will not statically resolve
 *   a non-literal specifier, so it does not emit a hard dependency on a package
 *   consumers are not required to install, and Node resolves it at runtime.
 *   This is the same trick `io/pdf.ts` already uses for `mupdf`.
 * - **Types stay static.** `import type` is erased entirely at compile time, so
 *   `Metadata`, `Sharp` and `ResvgRenderOptions` can still be imported normally
 *   without pulling either package in at runtime. Only the *values* are lazy.
 *
 * The promise is cached rather than the module, so concurrent first calls share
 * one load instead of racing several.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the loaded shape is asserted by the caller's own type-only import
type SharpModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResvgModule = any;

let sharpPromise: Promise<SharpModule> | null = null;
let resvgPromise: Promise<ResvgModule> | null = null;

/** Everything a missing-codec message needs to say, in one place. */
function missing(pkg: string, what: string, cause: unknown): Error {
  return new Error(
    `${what} needs the optional '${pkg}' package, which is not installed. ` +
      `Install it with:  npm i ${pkg}\n` +
      `(It ships prebuilt binaries for common platforms, so no compiler is ` +
      `needed. If you installed vecline with --omit=optional, this is why.)\n` +
      `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/**
 * The `sharp` module, loaded on first use.
 *
 * `sharp` is how every raster format is decoded and encoded, so almost anything
 * that touches pixels reaches this. It is the dependency whose absence used to
 * be fatal and silent.
 */
export async function loadSharp(): Promise<SharpModule> {
  sharpPromise ??= (async () => {
    const name: string = 'sharp';
    try {
      const mod = (await import(name)) as { default?: SharpModule };
      // sharp is CJS; under ESM the callable lands on `.default`, but a bundler
      // or a future ESM build may hand it back directly. Accept both rather
      // than depending on which interop path ran.
      return mod.default ?? mod;
    } catch (err) {
      throw missing('sharp', 'Reading and writing raster images', err);
    }
  })();
  return sharpPromise;
}

/**
 * The `@resvg/resvg-js` renderer, loaded on first use.
 *
 * Only the paths that turn an SVG back into pixels need this — rasterising, and
 * the verification that renders output and scores it. A plain
 * `vectorize(input, { mode: 'trace' })` never reaches it, which is the other
 * reason not to load it eagerly.
 */
export async function loadResvg(): Promise<ResvgModule> {
  resvgPromise ??= (async () => {
    const name: string = '@resvg/resvg-js';
    try {
      return await import(name);
    } catch (err) {
      throw missing('@resvg/resvg-js', 'Rendering SVG back to pixels', err);
    }
  })();
  return resvgPromise;
}
