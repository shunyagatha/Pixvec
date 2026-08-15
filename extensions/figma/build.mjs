/**
 * Build the plugin.
 *
 * Two bundles, because Figma runs the halves in different places:
 *
 *   code.js — the sandbox half. No DOM, so nothing from the engine goes here.
 *   ui.html — the iframe half, with `vecline/core` bundled in and the script
 *             inlined, because Figma loads the UI from a single HTML file and
 *             will not fetch a sibling `.js`.
 *
 * The iframe bundle is the reason `vecline/core` exists as a separate entry
 * point: it is dependency-free and free of Node built-ins, so it survives being
 * bundled for a browser sandbox. `test/portability.test.ts` in the main repo
 * asserts exactly that, which is what makes this build safe rather than lucky.
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Bundle the engine from the repo's OWN build, not from a published copy in
 * node_modules.
 *
 * `extensions/figma/node_modules/vecline` is whatever version `npm install`
 * fetched — 1.44.0 at the time of writing — and esbuild resolved `vecline/core`
 * there, which meant the plugin silently shipped the published engine while the
 * repo's src/ moved ahead. A whole round of centreline fixes lived in the repo,
 * passed its tests, and never reached the bundle; the plugin was verified in
 * Figma against an engine it was not actually running. Aliasing to ../../dist
 * makes `npm run build` at the repo root the single source of truth, so the
 * plugin can never again bundle an engine that differs from the one under test.
 */
const CORE = resolve(here, '../../dist/esm/core.js');
const veclineAlias = { name: 'vecline-local', setup(b) {
  b.onResolve({ filter: /^vecline\/core$/ }, () => ({ path: CORE }));
} };

/**
 * Typecheck first, here rather than only in the npm script.
 *
 * esbuild strips types without checking them, so a bundle can be produced from
 * source that does not typecheck. That is not theoretical: the Mode control
 * shipped dead because `trace(image, { colors, gradients, mode })` was cast
 * through `never` to silence the error that `trace` has no `mode` option — and
 * `node build.mjs` run directly, skipping `npm run build`, was happy to bundle
 * it. Making the check part of the build removes the way round it.
 */
execSync('npx tsc --noEmit', { stdio: 'inherit' });

await mkdir('dist', { recursive: true });

// The sandbox half.
await build({
  entryPoints: ['src/code.ts'],
  outfile: 'dist/code.js',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  logLevel: 'warning',
});

// The iframe half, bundled to a string so it can be inlined. The engine is
// aliased to the repo's local build (see veclineAlias) so it is always the code
// under test, never a stale published copy.
const ui = await build({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  logLevel: 'warning',
  plugins: [veclineAlias],
});
const js = ui.outputFiles[0].text;

// The replacement is a FUNCTION, not a string, and that is load-bearing.
// `String.replace` treats `$&`, `$'` and `` $` `` in a string replacement as
// substitution patterns, and minified engine code contains `$&` (from
// `w===$&&y===E`). Passing the bundle as a string therefore spliced the original
// `<script src="ui.js">` tag back into the middle of it, closing the script early
// and corrupting the plugin — while the build still reported success. A function
// replacement is returned verbatim, with no pattern interpretation.
//
// Separately, `</script>` appearing inside the bundle would also end the block
// early, so it is escaped. Neither of these is hypothetical: the first one
// actually happened here and was caught by loading the built file in a browser.
const html = (await readFile('src/ui.html', 'utf8'))
  .replace('<script src="ui.js"></script>', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>`);
await writeFile('dist/ui.html', html);

// A corrupted inline bundle is invisible until the plugin fails to load, so the
// structure is asserted here rather than trusted.
const opens = (html.match(/<script/gi) ?? []).length;
const closes = (html.match(/<\/script>/gi) ?? []).length;
if (opens !== closes) throw new Error(`inlined script is unbalanced: ${opens} open, ${closes} close`);
if (html.includes('src="ui.js"')) throw new Error('the ui.js placeholder survived into the output');

// A plugin that silently exceeded what the iframe can carry would be a bad
// surprise at load time, so the size is reported rather than assumed.
console.log(`  dist/code.js  ${(await readFile('dist/code.js')).length.toLocaleString()} bytes`);
console.log(`  dist/ui.html  ${html.length.toLocaleString()} bytes (engine inlined)`);
