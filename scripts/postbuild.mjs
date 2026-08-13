#!/usr/bin/env node
/**
 * Mark each build output with its module system.
 *
 * The package is `"type": "module"`, so Node treats every `.js` file under it as
 * ESM — including the CommonJS build, which would then fail on its first
 * `require`. Dropping a one-line `package.json` into each output directory
 * overrides that per-directory, which is the standard way to ship both formats
 * without renaming every file to `.mjs`/`.cjs`.
 */
import { writeFile, chmod, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const markers = [
  ['dist/esm', { type: 'module' }],
  ['dist/cjs', { type: 'commonjs' }],
];

for (const [dir, contents] of markers) {
  const target = join(root, dir);
  try {
    await access(target);
  } catch {
    console.error(`postbuild: ${dir} is missing — did the build run?`);
    process.exit(1);
  }
  await writeFile(join(target, 'package.json'), `${JSON.stringify(contents, null, 2)}\n`);
}

// npm sets the executable bit from the archive, but a local `npm link` or a
// direct clone-and-run relies on the file itself being executable.
const cli = join(root, 'dist/esm/cli.js');
try {
  await chmod(cli, 0o755);
} catch {
  // Windows has no executable bit; the shebang plus the `bin` entry is enough.
}

console.log('postbuild: wrote module-type markers for dist/esm and dist/cjs');
