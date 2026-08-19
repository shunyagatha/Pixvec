/**
 * The blur control: is a fidelity gain real, or is SSIM rewarding a low-pass?
 *
 * WHY THIS EXISTS. A ~150-byte `<feGaussianBlur>` wrapped around our own output
 * gains more SSIM than any change this project has shipped, on 8 of 9 corpus
 * subjects, for 1.00-1.02x gzip:
 *
 *   subject               shipped   +blur 0.5   rival
 *   photo-jpeg-artifacts   0.5319     0.6459    0.7642
 *   photo-motorcycles      0.5728     0.6734    0.8498
 *   photo-portrait         0.6552     0.7470    0.8173
 *   photo-lighthouse       0.6633     0.7456    0.8196
 *   photo-parrots          0.7500     0.8199    0.8669
 *   photo-cat              0.8234     0.8757    0.9073
 *   photo-jpeg-source      0.9276     0.9505    0.9858
 *   alpha-dice             0.8971     0.9117    0.9126
 *   logo-tux               0.9174     0.8825    0.9483   <- the only one blur hurts
 *
 * Rendered side by side the blurred version is visibly WORSE — the whole image is
 * smeared — so this is not a real improvement being missed. It is the metric
 * paying for a low-pass at this operating point, and on photographs it pays more
 * than it pays for anything we can actually do.
 *
 * WHAT FOLLOWS, and it is a constraint on every measurement here:
 *
 *   - A photographic SSIM gain smaller than the blur delta for that subject is
 *     not evidence of a visible improvement. Report it as inside the noise floor.
 *   - Flat art is different: on logo-tux blur LOSES 0.035, so an SSIM gain there
 *     is meaningful. That asymmetry is why `clean` is a flat-art preset and why
 *     its claims are scoped to flat art.
 *   - It applies to the rival too. Their advantage on photographs is measured in
 *     the same regime, so "their pass is worth +0.2223 on motorcycles" is partly
 *     this effect and must not be quoted as recovered detail.
 *
 * Run it against any candidate: if a change does not beat the blur row for a
 * subject, it has not been shown to improve that subject.
 *
 * Usage: node scripts/blur-control.mjs [--preset clean] [--trace '{"interpolate":true}']
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadRaster, vectorize } from '../dist/esm/api.js';
import { rasterizeSvg } from '../dist/esm/io/rasterize.js';
import { compareImages } from '../dist/esm/metrics/index.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const preset = arg('--preset', 'clean');
const trace = JSON.parse(arg('--trace', '{}'));
const SIGMAS = [0.25, 0.5, 0.7];

/** Wrap a whole document in one Gaussian blur. Cheap, and renderer-native. */
function blurred(svg, sigma) {
  const open = svg.match(/<svg[^>]*>/)[0];
  const body = svg.slice(open.length, svg.lastIndexOf('</svg>'));
  return `${open}<defs><filter id="__blurctl" x="-10%" y="-10%" width="120%" height="120%">`
    + `<feGaussianBlur stdDeviation="${sigma}"/></filter></defs>`
    + `<g filter="url(#__blurctl)">${body}</g></svg>`;
}

const DIR = 'corpus/src';
if (!existsSync(DIR)) {
  console.error(`${DIR} is missing. Run \`npm run corpus\` first.`);
  process.exit(1);
}

console.log(`preset ${preset}  trace ${JSON.stringify(trace)}\n`);
console.log('subject               candidate   best blur   delta    blur gzip   verdict');
console.log('-'.repeat(78));
let beaten = 0;
let total = 0;
for (const f of readdirSync(DIR).filter((x) => /\.(png|jpg|jpeg)$/i.test(x))) {
  const name = f.replace(/\.[^.]+$/, '');
  const input = await loadRaster(`${DIR}/${f}`);
  const svg = (await vectorize(input, { mode: 'trace', preset, trace })).svg;
  const score = async (s) => {
    const { image } = await rasterizeSvg(s, { width: input.image.width });
    return (await compareImages(input.image, image)).ssim;
  };
  const base = await score(svg);
  let best = -1;
  for (const sigma of SIGMAS) best = Math.max(best, await score(blurred(svg, sigma)));
  const cost = gzipSync(blurred(svg, SIGMAS[1])).length / gzipSync(svg).length;
  const wins = base > best;
  if (!wins) beaten++;
  total++;
  console.log(
    `${name.padEnd(21)} ${base.toFixed(4)}      ${best.toFixed(4)}   `
    + `${(base - best >= 0 ? '+' : '') + (base - best).toFixed(4)}    ${cost.toFixed(3)}x     `
    + `${wins ? 'beats blur' : 'BLUR WINS — gain not shown to be visible'}`,
  );
}
console.log('-'.repeat(78));
console.log(`blur beats the candidate on ${beaten} of ${total} subjects.`);
console.log('A subject where blur wins has NOT been shown to improve; look at the render.');
