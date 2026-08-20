/**
 * The blur control: does a claimed fidelity gain beat simply smoothing the output?
 *
 * WHAT THIS ORIGINALLY REPORTED, AND WHY IT WAS WRONG. The first version of this
 * file recorded that a ~150-byte `<feGaussianBlur>` gained more SSIM than anything
 * the project had shipped — +0.1161 on photo-jpeg-artifacts, +0.1037 on
 * photo-motorcycles — and concluded that photographic SSIM here was untrustworthy.
 *
 * That was a bug in `compareImages`, not a property of SSIM. The alpha gate in
 * src/metrics/index.ts admitted a fourth scored channel whenever EITHER side's
 * alpha varied, and wrapping a document in any `<filter>` makes the candidate's
 * alpha vary at the filter-region edge. That channel scores ~1.0 against a
 * constant reference plane, so the blur was buying a free 1.0 in the mean.
 * Measured on photo-motorcycles: reported 0.5698 -> 0.6716, RGB alone
 * 0.5698 -> 0.5622. The blur was making the picture WORSE the whole time.
 *
 * WHAT IT REPORTS NOW, with the gate fixed to depend on the reference alone:
 *
 *   blur's best advantage    +0.0229 (alpha-dice), +0.0155 (photo-cat)
 *   blur LOSES on            logo-tux -0.0355, motorcycles -0.0040,
 *                            jpeg-artifacts -0.0010, lighthouse -0.0010
 *
 * So SSIM does mildly favour smoothing, as it is known to — but by a couple of
 * hundredths, not a tenth, and a real improvement can clear it. That is a usable
 * floor rather than a broken instrument.
 *
 * HOW TO USE IT. Run it against a candidate configuration. A subject where blur
 * still wins has not been shown to improve — the gain is inside what smoothing
 * buys for nothing, so render it and look before claiming it. A subject where the
 * candidate beats blur has cleared the floor.
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
