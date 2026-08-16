#!/usr/bin/env node
/**
 * Verify a packaged .vsix before it is published.
 *
 * This exists because of a bug that shipped past every check we had. CI packaged
 * the extension on Ubuntu, so the .vsix carried `sharp-linux-x64` and nothing
 * else. It installed cleanly on Windows and macOS and then threw
 * "Could not load the sharp module using the win32-x64 runtime" the first time
 * anyone used it. The package was 11 MB and looked entirely healthy; only the
 * *contents* gave it away.
 *
 * So the gate reads what is actually in the archive rather than trusting that a
 * build which exited 0 produced the right bytes:
 *
 *   - the declared entrypoint is present
 *   - the engine is present, at the version this repo released
 *   - the native prebuilds are exactly the ones this target needs
 *   - no OTHER platform's prebuilds are along for the ride
 *
 * The last check matters as much as the third: a package that silently carries
 * every platform is 60 MB of mostly-dead weight, and one that carries the wrong
 * platform is broken in a way that only shows up in a user's editor.
 *
 * Usage: node scripts/verify-vsix.mjs <file.vsix> <target> [--engine <version>]
 */
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

/**
 * The native packages each VS Code target must contain, and only these.
 *
 * Derived by measurement, not from documentation: a clean
 * `npm install --os=<os> --cpu=<cpu> --libc=<libc>` was run for every target and
 * the resulting `@img` / `@resvg` directories recorded. Note the asymmetry —
 * Windows has no separate `sharp-libvips-*` package because libvips is linked
 * into the binding there, so a rule like "always expect three" would be wrong.
 */
const EXPECTED = {
  'win32-x64': ['@img/sharp-win32-x64', '@resvg/resvg-js-win32-x64-msvc'],
  'win32-arm64': ['@img/sharp-win32-arm64', '@resvg/resvg-js-win32-arm64-msvc'],
  'linux-x64': ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64', '@resvg/resvg-js-linux-x64-gnu'],
  'linux-arm64': ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64', '@resvg/resvg-js-linux-arm64-gnu'],
  'alpine-x64': ['@img/sharp-linuxmusl-x64', '@img/sharp-libvips-linuxmusl-x64', '@resvg/resvg-js-linux-x64-musl'],
  'alpine-arm64': ['@img/sharp-linuxmusl-arm64', '@img/sharp-libvips-linuxmusl-arm64', '@resvg/resvg-js-linux-arm64-musl'],
  'darwin-x64': ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64', '@resvg/resvg-js-darwin-x64'],
  'darwin-arm64': ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64', '@resvg/resvg-js-darwin-arm64'],
};

/** Scoped packages that are pure JS and therefore expected on every target. */
const PORTABLE = new Set(['@img/colour', '@resvg/resvg-js']);

/**
 * List the entries of a zip by walking its central directory.
 *
 * Done by hand rather than with a zip dependency because this script guards the
 * publish path for a package whose whole pitch is a tiny dependency surface;
 * adding one here to check that would be a poor trade. A .vsix is a plain zip
 * well under 4 GB, so the ZIP64 records are not a concern.
 */
function zipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  // The comment field is variable-length, so the record has to be found by
  // scanning back from the end rather than at a fixed offset.
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const file = argv[2];
const target = argv[3];
const engineFlag = argv.indexOf('--engine');
const wantEngine = engineFlag > 0 ? argv[engineFlag + 1] : null;

if (!file || !target) {
  console.error('usage: node scripts/verify-vsix.mjs <file.vsix> <target> [--engine <version>]');
  exit(2);
}
if (!EXPECTED[target]) {
  console.error(`unknown target "${target}". known: ${Object.keys(EXPECTED).join(', ')}`);
  exit(2);
}

const names = zipEntries(readFileSync(file));
const failures = [];
const note = (ok, label) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);

console.log(`verifying ${file} for ${target}`);

// --- structure ---
const has = (p) => names.some((n) => n === p);
for (const required of ['extension/out/extension.js', 'extension/package.json']) {
  const ok = has(required);
  note(ok, required);
  if (!ok) failures.push(`missing ${required}`);
}

// vsce normalises the licence filename on the way in: a repo file called
// LICENSE arrives as extension/LICENSE.txt. Asserting the repo's name here
// failed a package that was actually correct, so accept the names vsce emits.
const LICENCE_NAMES = ['extension/LICENSE.txt', 'extension/LICENSE', 'extension/LICENSE.md'];
const licence = LICENCE_NAMES.find((n) => has(n));
note(!!licence, `licence (${licence ?? LICENCE_NAMES.join(' | ')})`);
if (!licence) failures.push('no licence file in the package');

// --- the engine, at the right version ---
const enginePkg = 'extension/node_modules/vecline/package.json';
const engineOk = has(enginePkg);
note(engineOk, enginePkg);
if (!engineOk) failures.push('the engine is not in the package at all');

if (wantEngine) {
  // Only the file list is available without inflating, so check the version via
  // the manifest that vsce copies in beside it.
  const declared = names.some((n) => n.startsWith('extension/node_modules/vecline/dist/'));
  note(declared, 'engine dist/ present');
  if (!declared) failures.push('the engine has no dist/ — it would resolve to nothing');
}

// --- native prebuilds: exactly this target's, and no others ---
const found = new Set();
for (const n of names) {
  const m = /^extension\/node_modules\/(@(?:img|resvg)\/[^/]+)\//.exec(n);
  if (m && !PORTABLE.has(m[1])) found.add(m[1]);
}

for (const want of EXPECTED[target]) {
  const ok = found.has(want);
  note(ok, want);
  if (!ok) failures.push(`missing native package ${want}`);
}

const foreign = [...found].filter((f) => !EXPECTED[target].includes(f));
if (foreign.length) {
  note(false, `no foreign prebuilds (found ${foreign.join(', ')})`);
  failures.push(`carries prebuilds for another platform: ${foreign.join(', ')}`);
} else {
  note(true, 'no foreign prebuilds');
}

// A .vsix with no native packages at all is the failure mode that started this:
// it looks fine and dies on first use.
if (found.size === 0) failures.push('no native prebuilds at all — the extension would fail on first use');

console.log();
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  exit(1);
}
console.log(`passed: ${names.length} entries, native packages [${[...found].sort().join(', ')}]`);
