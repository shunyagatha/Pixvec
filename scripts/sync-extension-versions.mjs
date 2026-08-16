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

import { execSync } from 'node:child_process';
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

/*
 * The extension's OWN version, which nothing was bumping.
 *
 * publish-vscode.yml republishes on every `v*` tag, but this field had read
 * 0.1.0 since the extension was created, so every release after the first would
 * have been rejected by the Marketplace as a duplicate version. Tying it to the
 * engine also makes the listing state plainly which tracer a user is getting,
 * which is the thing that actually changes between releases.
 */
if (vscode.version !== engineVersion) {
  if (check) {
    problems.push(
      `extensions/vscode is version ${vscode.version}, but this repo is ${engineVersion}. ` +
      `A tag-triggered publish would try to republish ${vscode.version} and be rejected as a duplicate. ` +
      `Run: node scripts/sync-extension-versions.mjs`,
    );
  } else {
    vscode.version = engineVersion;
    writeFileSync(vscodePath, JSON.stringify(vscode, null, 2) + '\n');
    changes.push(`extensions/vscode → version ${engineVersion}`);
  }
}

/*
 * The lockfile has to move with the dependency range, or `npm ci` refuses.
 *
 * Bumping `dependencies.vecline` above leaves the extension's lockfile still
 * resolving the previous engine, and `npm ci` — which the publish workflow uses
 * precisely because it is reproducible — fails outright rather than adapting:
 *
 *   npm error Invalid: lock file's vecline@1.45.0 does not satisfy vecline@1.46.0
 *
 * That failed all eight platform jobs on the v1.46.0 tag, after a separate race
 * had already failed them once. Refreshing the lock is part of the same edit
 * that causes the drift, so it belongs here rather than in a release runbook
 * step somebody has to remember.
 */
const lockPath = join(ROOT, 'extensions/vscode/package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const locked = lock.packages?.['node_modules/vecline']?.version;
  if (locked !== engineVersion) {
    if (check) {
      problems.push(
        `extensions/vscode/package-lock.json resolves vecline ${locked}, but this repo is ${engineVersion}. ` +
        '`npm ci` refuses to install when the lock and the manifest disagree, so every packaging job would fail. ' +
        'Run: node scripts/sync-extension-versions.mjs',
      );
    } else {
      // --package-lock-only rewrites the lock without materialising node_modules,
      // which keeps this cheap and avoids pulling a platform's binaries here.
      //
      // A fixed command string rather than an argv array: on Windows `npm` is a
      // .cmd shim, which Node refuses to execFile without a shell, and passing
      // an args array *with* a shell is the pattern Node warns about as an
      // injection hazard (DEP0190). Nothing here is interpolated, so a literal
      // string is both safe and portable.
      execSync('npm install --package-lock-only --no-audit --no-fund', {
        cwd: join(ROOT, 'extensions/vscode'),
        stdio: 'inherit',
      });
      changes.push(`extensions/vscode/package-lock.json → vecline ${engineVersion}`);
    }
  }
}

/*
 * The MCPB bundle carries the version in three places, none of which were
 * guarded — they all still read 1.40.1 while the repo shipped 1.45.0. It is the
 * same drift this script exists to stop, in the one embedded copy it did not
 * cover.
 */
const mcpbSites = [
  { file: 'mcpb/manifest.json', json: true },
  { file: 'mcpb/package.json', json: true },
  { file: 'mcpb/server/index.js', json: false, re: /^(const VERSION = ')([^']+)(';)$/m },
];

for (const site of mcpbSites) {
  const path = join(ROOT, site.file);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  const current = site.json ? JSON.parse(text).version : (text.match(site.re) ?? [])[2];
  if (current === engineVersion) continue;

  if (check) {
    problems.push(
      `${site.file} declares ${current}, but this repo is ${engineVersion}. ` +
      `The bundle would launch an engine it was not tested against. ` +
      `Run: node scripts/sync-extension-versions.mjs`,
    );
    continue;
  }

  if (site.json) {
    const obj = JSON.parse(text);
    obj.version = engineVersion;
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  } else {
    writeFileSync(path, text.replace(site.re, `$1${engineVersion}$3`));
  }
  changes.push(`${site.file} → ${engineVersion}`);
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
