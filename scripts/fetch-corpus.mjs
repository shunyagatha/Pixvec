#!/usr/bin/env node
/**
 * Download a real-world test corpus.
 *
 * The test suite runs on synthetic fixtures, deliberately: they are reviewable
 * in a diff and reproducible without licensing anyone's photographs. But
 * synthetic images share the blind spots of whoever wrote them, so quality work
 * needs real ones — camera noise, JPEG ringing, anti-aliased text, scanned line
 * art, alpha from a real design tool.
 *
 * Nothing here is committed. `corpus/` is gitignored; this script re-fetches it
 * on demand so the provenance and licence of every file stays explicit.
 *
 *   npm run corpus
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'corpus/src';

/**
 * Each entry records where the bytes came from and under what terms, because
 * "I found it online" is not a licence and a test corpus outlives the session
 * that assembled it.
 */
const SOURCES = [
  // --- Photographs: the Kodak set, the standard corpus for image compression
  // research, distributed for exactly this purpose.
  { name: 'photo-parrots.png', kind: 'photo',
    url: 'https://r0k.us/graphics/kodak/kodak/kodim23.png',
    note: 'Kodak PhotoCD kodim23 — saturated colour, feather detail' },
  { name: 'photo-lighthouse.png', kind: 'photo',
    url: 'https://r0k.us/graphics/kodak/kodak/kodim19.png',
    note: 'Kodak kodim19 — sky gradient, fine railings, hard edges' },
  { name: 'photo-motorcycles.png', kind: 'photo',
    url: 'https://r0k.us/graphics/kodak/kodak/kodim05.png',
    note: 'Kodak kodim05 — dense high-frequency detail' },
  { name: 'photo-portrait.png', kind: 'photo',
    url: 'https://r0k.us/graphics/kodak/kodak/kodim04.png',
    note: 'Kodak kodim04 — skin tones, smooth gradients' },

  // --- Real JPEG, with real JPEG artefacts rather than a re-encode of a PNG.
  { name: 'photo-jpeg-source.jpg', kind: 'photo',
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg',
    note: 'Wikimedia Commons, public domain' },

  // --- Transparency produced by a real tool, not a synthetic alpha ramp.
  { name: 'alpha-dice.png', kind: 'alpha',
    url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
    note: 'Wikimedia Commons PNG transparency demonstration, CC BY-SA' },

  // --- Flat artwork and logos: the case `pixel` mode claims to nail.
  { name: 'logo-tux.png', kind: 'flat',
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/af/Tux.png',
    note: 'Larry Ewing / Tux, freely distributable with attribution' },
  // --- A real photograph as a real JPEG, with genuine 8x8 block artefacts.
  { name: 'photo-cat.jpg', kind: 'photo',
    url: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg',
    note: 'Wikimedia Commons, CC BY-SA — fur detail, natural light' },
  { name: 'photo-jpeg-artifacts.jpg', kind: 'photo',
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/b4/JPEG_example_JPG_RIP_100.jpg',
    note: 'Wikimedia JPEG example — ringing around hard edges' },

  // --- Real vector art to rasterize: flat fills, gradients, many paths.
  { name: 'vector-tiger.svg', kind: 'svg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Ghostscript_Tiger.svg',
    note: 'Ghostscript Tiger — the classic vector torture test, public domain' },
  { name: 'vector-comparison.svg', kind: 'svg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/6b/Bitmap_VS_SVG.svg',
    note: 'Wikimedia Commons — text, curves, flat fills' },
];

// Wikimedia rejects requests without a descriptive User-Agent.
const HEADERS = {
  'User-Agent': 'vecline-test-corpus/1.0 (https://github.com/shunyagatha/Vecline)',
};

await mkdir(OUT, { recursive: true });

const manifest = [];
let ok = 0;
let failed = 0;

for (const source of SOURCES) {
  const target = join(OUT, source.name);
  try {
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size > 0) {
      console.log(`  cached  ${source.name.padEnd(26)} ${(existing.size / 1024).toFixed(1)} KB`);
      manifest.push({ ...source, bytes: existing.size });
      ok++;
      continue;
    }

    const response = await fetch(source.url, { headers: HEADERS, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('empty response');

    await writeFile(target, bytes);
    console.log(`  fetched ${source.name.padEnd(26)} ${(bytes.length / 1024).toFixed(1)} KB  ${source.kind}`);
    manifest.push({ ...source, bytes: bytes.length });
    ok++;
  } catch (err) {
    console.error(`  FAILED  ${source.name.padEnd(26)} ${err.message}`);
    failed++;
  }
}

await writeFile(
  join('corpus', 'MANIFEST.json'),
  `${JSON.stringify({ fetchedFor: 'vecline quality testing', sources: manifest }, null, 2)}\n`,
);

console.log(`\n${ok} fetched, ${failed} failed. Provenance written to corpus/MANIFEST.json`);
if (ok === 0) process.exit(1);
