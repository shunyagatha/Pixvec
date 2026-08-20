/**
 * The interior alpha hairline, counted per subject and per configuration.
 *
 * WHAT IS COUNTED. A leak is a pixel the SOURCE calls fully opaque that the
 * rendered SVG returns below alpha 250. `interior` restricts that to pixels
 * whose every neighbour within one step is also source-opaque, so the artwork's
 * own antialiased edge cannot explain them. See scripts/lib/hairline.mjs.
 *
 * WHY IT IS NOT SSIM. The defect is a count, so it is measured as a count. A
 * similarity score answers a different question and — as this project has paid
 * to learn twice — can be moved by things that make the picture worse.
 *
 * MAGNIFICATION, AND WHY THE ODD NUMBER. `--scale 3.902` renders at a
 * non-integer scale. At an integer scale every lattice edge lands on a pixel
 * boundary and the rasteriser antialiases nothing, so a document can look
 * seam-free purely because the sampling grid agreed with it; 3.902 does not let
 * that happen. Each source pixel is scored by the WORST alpha in the block it
 * became.
 *
 * Usage:
 *   node scripts/hairline-report.mjs [--preset clean] [--scale 1]
 *                                    [--cells '{"name":{"trace":{...}},...}']
 *                                    [--rival]
 */
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { hairline, silhouetteDistance } from './lib/hairline.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const preset = arg('--preset', 'clean');
const scale = Number(arg('--scale', '1'));
const alpha = Number(arg('--alpha', '250'));
const outDir = arg('--out', '');
const cells = JSON.parse(arg('--cells', '{"as shipped":{}}'));
const withRival = argv.includes('--rival');

const DIR = 'corpus/src';
const RIVAL = 'corpus/src/Vectorizer.AI';
if (!existsSync(DIR)) {
  console.error(`${DIR} is missing. Run \`npm run corpus\` first.`);
  process.exit(1);
}
if (outDir) mkdirSync(outDir, { recursive: true });

const subjects = readdirSync(DIR).filter((x) => /\.(png|jpg|jpeg)$/i.test(x));
const names = Object.keys(cells);

console.log(`preset ${preset}  alpha<${alpha}  scale ${scale}x  N=${subjects.length}`);
console.log('');
const head = ['subject'.padEnd(21), ...names.map((n) => n.padEnd(26))].join('');
console.log(head + (withRival ? 'rival' : ''));
console.log('-'.repeat(head.length + (withRival ? 22 : 0)));

const rows = [];
for (const f of subjects) {
  const name = f.replace(/\.[^.]+$/, '');
  const input = await loadRaster(`${DIR}/${f}`);
  const src = input.image;
  const dist = silhouetteDistance(src);
  const row = { subject: name, cells: {} };
  const cols = [];
  for (const key of names) {
    const svg = (await vectorize(input, { mode: 'trace', preset, trace: cells[key].trace ?? {} })).svg;
    const { image } = await rasterizeSvg(svg, { width: Math.round(src.width * scale) });
    const h = hairline(src, image, { alpha, scale, dist });
    row.cells[key] = {
      total: h.total, interior: h.interior, worst: h.worst, deficit: h.deficit,
      gzip: gzipSync(svg).length, bytes: svg.length,
    };
    cols.push(`${String(h.total).padStart(6)}/${String(h.interior).padStart(6)} w${String(h.worst).padStart(3)}`.padEnd(26));
    if (outDir) writeFileSync(`${outDir}/${name}.${key.replace(/\W+/g, '-')}.svg`, svg);
  }
  if (withRival) {
    const p = `${RIVAL}/${name}.svg`;
    if (existsSync(p)) {
      const svg = await readFile(p, 'utf8');
      const { image } = await rasterizeSvg(svg, { width: Math.round(src.width * scale) });
      const h = hairline(src, image, { alpha, scale, dist });
      row.rival = { total: h.total, interior: h.interior, worst: h.worst, deficit: h.deficit };
      cols.push(`${String(h.total).padStart(6)}/${String(h.interior).padStart(6)} w${String(h.worst).padStart(3)}`);
    }
  }
  rows.push(row);
  console.log(name.padEnd(21) + cols.join(''));
}
console.log('-'.repeat(head.length + (withRival ? 22 : 0)));
console.log('columns are  total/interior  worst-alpha   (leak = source-opaque pixel rendered below alpha)');
for (const key of names) {
  const t = rows.reduce((s, r) => s + r.cells[key].total, 0);
  const i = rows.reduce((s, r) => s + r.cells[key].interior, 0);
  const g = rows.reduce((s, r) => s + r.cells[key].gzip, 0);
  console.log(`${key.padEnd(21)} total ${t}  interior ${i}  gzip ${g}`);
}
if (outDir) writeFileSync(`${outDir}/hairline.json`, JSON.stringify(rows, null, 1));
