/**
 * Keep the extensions pinned to THIS repo's engine version.
 *
 * Both extensions embed the engine rather than resolving it at the user's
 * runtime — the VS Code extension bundles `node_modules/vecline` into its .vsix,
 * and the Figma plugin inlines the core into a single HTML file. So whatever
 * version is in place when they are packaged is the version their users get,
 * forever, until the extension itself is republished. Neither marketplace
 * refreshes a dependency on its own.
 *
 * That is exactly how a whole release of centreline fixes shipped to npm while
 * the Figma plugin carried on bundling the previous published engine: nothing
 * connected the two, so nothing complained. This script is the connection.
 *
 *   node scripts/sync-extension-versions.mjs           # write
 *   node scripts/sync-extension-versions.mjs --check   # fail if out of sync (CI)
 *
 * The Figma plugin needs no dependency edit — its build aliases `vecline/core`
 * straight to ../../dist — but it is still checked here so that a stale alias
 * would surface rather than pass silently.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const engineVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const problems = [];
const changes = [];

/* -- VS Code: its dependency range must admit the engine version we ship ---- */
const vscodePath = join(ROOT, 'extensions/vscode/package.json');
const vscode = JSON.parse(readFileSync(vscodePath, 'utf8'));
const want = `^${engineVersion}`;
if (vscode.dependencies?.vecline !== want) {
  if (check) {
    problems.push(
      `extensions/vscode depends on vecline ${vscode.dependencies?.vecline}, but this repo is ${engineVersion}. ` +
      `Packaging it now would ship an older engine than the one released. Run: node scripts/sync-extension-versions.mjs`,
    );
  } else {
    vscode.dependencies.vecline = want;
    writeFileSync(vscodePath, JSON.stringify(vscode, null, 2) + '\n');
    changes.push(`extensions/vscode → vecline ${want}`);
  }
}

/* -- Figma: assert the build really does alias to the local dist ------------ */
const figmaBuild = readFileSync(join(ROOT, 'extensions/figma/build.mjs'), 'utf8');
if (!figmaBuild.includes("../../dist/esm/core.js")) {
  problems.push(
    'extensions/figma/build.mjs no longer aliases vecline/core to ../../dist — ' +
    'it would bundle whatever is in node_modules, which is how a stale engine shipped once already.',
  );
}

/* -- Both: the engine must actually be built, or a package would be empty --- */
if (!existsSync(join(ROOT, 'dist/esm/core.js'))) {
  problems.push('dist/esm/core.js is missing — run `npm run build` before packaging an extension.');
}

if (problems.length > 0) {
  for (const p of problems) console.error('✗ ' + p);
  process.exit(1);
}
if (changes.length > 0) for (const c of changes) console.log('✓ ' + c);
console.log(`extensions are in sync with engine ${engineVersion}`);
