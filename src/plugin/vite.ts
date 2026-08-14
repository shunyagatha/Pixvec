/**
 * Vite / Rollup plugin — vectorise raster assets at build time.
 *
 * Import an image with a query suffix and get vector output back, no CLI step:
 *
 * ```ts
 * import logo from './logo.png?svg';         // the traced SVG string
 * import Logo from './logo.png?component';    // a framework component's source
 * ```
 *
 * Install volume for image tooling concentrates at build-time integration (the
 * sharp+SVGO wrappers pull hundreds of thousands of weekly downloads), and
 * graver's pure-TS core avoids the native-binary CI pain those carry. Returns the
 * plain Vite/Rollup plugin object — the two share this interface — so it needs no
 * `unplugin` dependency. Node-only (it reads files and runs the tracer).
 */

import { readFile } from 'node:fs/promises';
import { loadRaster, vectorize, type VectorizeOptions } from '../api.js';
import { toComponent, type Framework } from '../emit/component.js';
import { optimizeSvg } from '../svg/optimize.js';

export interface GraverPluginOptions {
  /** Framework for `?component` imports. Default `react`. */
  framework?: Framework;
  /** Minify the emitted SVG. Default true. */
  minify?: boolean;
  /** Options forwarded to `vectorize`. */
  vectorize?: VectorizeOptions;
}

interface RollupPlugin {
  name: string;
  load(id: string): Promise<string | null>;
}

const RASTER = /\.(png|jpe?g|webp|avif|tiff?|gif|bmp|ico)$/i;

/** A Vite/Rollup plugin that turns `image?svg` / `image?component` imports into vectors. */
export function graverPlugin(options: GraverPluginOptions = {}): RollupPlugin {
  const minify = options.minify !== false;
  return {
    name: 'graver',
    async load(id: string): Promise<string | null> {
      const q = id.indexOf('?');
      if (q < 0) return null;
      const path = id.slice(0, q);
      const params = new URLSearchParams(id.slice(q + 1));
      const wantComponent = params.has('component');
      const wantSvg = params.has('svg') || params.has('vectorize');
      if ((!wantSvg && !wantComponent) || !RASTER.test(path)) return null;

      const src = await loadRaster(await readFile(path));
      let svg = (await vectorize(src, { mode: 'auto', ...options.vectorize })).svg;
      if (minify) svg = optimizeSvg(svg);

      if (wantComponent) {
        // Component source; the host's JSX/framework pipeline compiles it further.
        return toComponent(svg, { framework: options.framework ?? 'react', name: 'Icon' });
      }
      return `export default ${JSON.stringify(svg)};`;
    },
  };
}

export default graverPlugin;
