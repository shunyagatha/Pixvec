#!/usr/bin/env node
/**
 * Bundle pixvec/core into a single browser ESM file for the docs playground.
 *
 * The playground (docs/index.html) is a zero-install, client-side demo: it runs
 * the real pixvec/core in the browser and shows live SSIM/PSNR/CIEDE2000. Because
 * pixvec/core is pure TypeScript with no Node built-ins (enforced by
 * test/portability.test.ts), it bundles straight to the browser with esbuild.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/core.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: 'docs/pixvec-core.js',
  logLevel: 'info',
});

console.log('playground bundle → docs/pixvec-core.js');
