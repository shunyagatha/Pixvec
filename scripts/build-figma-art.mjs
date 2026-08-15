/**
 * Build the Figma Community listing art: the 128x128 icon and the 1920x1080
 * thumbnail.
 *
 * The thumbnail is not a mockup. The before/after panel in it is a real trace:
 * `extensions/figma/art/mark-demo.svg` is rasterised, run through the same
 * `trace()` the plugin calls, and both the source pixels and the resulting
 * vector are magnified by the same factor and placed side by side. The metrics
 * printed on it are read out of the verify pass on that trace, not typed in.
 * If the tracer regresses, this thumbnail regresses with it, which is the point.
 *
 * The subject is our own mark rather than a corpus image on purpose: the corpus
 * is Kodak and CC BY-SA material fetched for quality testing, and a published
 * marketplace listing is a different use under different terms.
 *
 * Brand lockup mirrors the Studio header in `F:/Vecline Platform/public/index.html`
 * — mark, VECLINE, accent square, STUDIO, dashed registration box with corner
 * ticks — so the listing and the site read as the same product.
 *
 *   node scripts/build-figma-art.mjs
 */

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'extensions', 'figma', 'art');
mkdirSync(ART, { recursive: true });

/* -- palette: the Studio's dark theme, verbatim ------------------------- */
const C = {
  paper: '#120E18',
  surface: '#1C1624',
  line: '#302839',
  grid: '#241D2D',
  ink: '#F3EDF4',
  ink2: '#B9AEC2',
  accent: '#FF4D9E',
  accentText: '#FF83BB',
  meas: '#5AC6E6',
  ok: '#4BD3A0',
  readout: '#0C0910',
  readoutLine: '#2C2338',
  readoutDim: '#8E819A',
  cardPaper: '#FDFBFD',
};

/* The Studio declares a stack; a PNG has to resolve to one file. Arial Narrow
   Bold is the static member of that stack — Bahnschrift is a variable font and
   resvg renders only its default instance, so `font-weight: 700` silently does
   nothing and the wordmark comes out lighter than the site's. Segoe UI and
   Consolas are the same faces the Studio uses for body and readout. */
const WINFONTS = 'C:/Windows/Fonts/';
const FONT_FILES = [
  'ARIALN.TTF', 'ARIALNB.TTF',
  'segoeui.ttf', 'segoeuib.ttf', 'segoeuisl.ttf',
  'consola.ttf', 'consolab.ttf',
].map((f) => WINFONTS + f);

const FONT_DISPLAY = "'Arial Narrow', 'Roboto Condensed', sans-serif";
const FONT_UI = "'Segoe UI', system-ui, sans-serif";
const FONT_MONO = 'Consolas, monospace';

/** The mark, with both colours pinned — a PNG has no colour scheme to follow. */
function mark(x, y, size, inkColor) {
  const s = size / 405;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill-rule="evenodd">
    <path fill="${inkColor}" d="M7 96L130 96L179 173L153 197L110 130L70 131L128 221L102 246L7 98ZM353 96L187 377L139 303L164 277L187 310L264 180L353 97Z"/>
    <path fill="url(#vgrad)" d="M395 6L399 8L380 87L358 69L48 368L23 344L336 45L318 25L395 7Z"/>
  </g>`;
}

const render = (svg, width) =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, fontFiles: FONT_FILES, defaultFontFamily: 'Segoe UI' },
  })
    .render()
    .asPng();

/** resvg collapses the space either side of a numeric entity; nbsp survives. */
const sp = '&#160;';

/* -- 1. the traced subject ---------------------------------------------- */
const subject = readFileSync(join(ART, 'mark-demo.svg'), 'utf8');
writeFileSync(join(ART, 'mark-demo.png'), render(subject, 405));

/* Metrics come from the verify pass, written by build-figma-art-trace.mjs. */
const m = JSON.parse(readFileSync(join(ART, 'metrics.json'), 'utf8'));

/* -- 2. the before/after panel ------------------------------------------ */
/*
 * What the panel compares, and two things it deliberately does not.
 *
 * The first cut magnified one crop 4x on both halves — source pixels against
 * traced vector — on the theory that the vector would stay sharp while the
 * pixels smeared. Rendered and looked at, it did the opposite. At 4x the raster
 * is smoothly interpolated, while our traced diagonals show their staircase:
 * at the default 0.4px tolerance a diagonal raster edge *is* a staircase to
 * within 0.4px, and the tracer faithfully keeps it. Raising the tolerance does
 * not buy smoothness either — measured on this subject, 0.4 -> 0.8 drops PSNR
 * from 44.99 to 34.07 and still leaves 7,496 axis-aligned commands against
 * 10,214. The staircase is not a tuning mistake, it is what scores best, and
 * that was settled separately. It is simply not something to magnify on a
 * thumbnail.
 *
 * The second cut stroked the real path outlines over the fill to say "these are
 * editable paths". Same problem from the other end: stroking 10,214 commands
 * draws the staircase as a fringe, so the vector half read as the ragged one.
 *
 * What is left is a difference that is visible at thumbnail size *and*
 * measurably ours on every axis at once: gradients off against gradients on.
 * Both halves are this plugin's own output at its own defaults, differing in
 * one setting. build-figma-art-trace.mjs asserts the win before writing the
 * metrics, so this panel cannot outlive the claim it makes.
 */
const gradOff = readFileSync(join(ART, 'grad-off.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const gradOn = readFileSync(join(ART, 'grad-on.svg'), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/* -- 3. the thumbnail ---------------------------------------------------- */
const W = 1920, H = 1080;

/* Panel geometry. The image area keeps the crop's 215:155 aspect exactly, so
   neither side is stretched relative to the other. */
/* The whole mark at 1:1 proportions, inset so it does not touch the card edge. */
const ART_W = 405, ART_H = 384;
const INSET = 34;
const FIT = (604 - INSET * 2) / ART_H;
const IMG = { x: 1092, y: 168, w: Math.round(ART_W * FIT) + INSET * 2, h: 604 };
const P = { x: IMG.x - 20, y: IMG.y - 20, w: IMG.w + 40, h: IMG.h + 162 };
const SPLIT = IMG.x + IMG.w / 2;

const thumb = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="vgrad" x1="0" y1="1" x2="1" y2="0">
    <stop offset="0" stop-color="#A3005A"/><stop offset="1" stop-color="#FF4D9E"/>
  </linearGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1"/>
  </pattern>
  <clipPath id="clipLeft"><rect x="${IMG.x}" y="${IMG.y}" width="${IMG.w / 2}" height="${IMG.h}"/></clipPath>
  <clipPath id="clipRight"><rect x="${SPLIT}" y="${IMG.y}" width="${IMG.w / 2}" height="${IMG.h}"/></clipPath>
  <clipPath id="clipImg"><rect x="${IMG.x}" y="${IMG.y}" width="${IMG.w}" height="${IMG.h}" rx="6"/></clipPath>
</defs>

<rect width="${W}" height="${H}" fill="${C.paper}"/>
<rect width="${W}" height="${H}" fill="url(#grid)" opacity="0.55"/>

<!-- brand lockup: same parts, same order as the Studio header -->
<g>
  <rect x="104" y="96" width="452" height="132" fill="none" stroke="${C.accent}"
        stroke-dasharray="6 5" opacity="0.5"/>
  ${[[104, 96], [556, 96], [104, 228], [556, 228]]
    .map(([cx, cy]) => `<rect x="${cx - 7}" y="${cy - 7}" width="14" height="14" fill="${C.surface}" stroke="${C.accent}" stroke-width="3"/>`)
    .join('\n  ')}
  ${mark(130, 116, 92, C.ink)}
  <text x="244" y="192" font-family="${FONT_DISPLAY}" font-size="76" font-weight="700"
        letter-spacing="1" fill="${C.ink}">VECLINE</text>
</g>

<!-- the site's own pitch, word for word, broken to two lines so it fits -->
<text x="104" y="386" font-family="${FONT_DISPLAY}" font-size="122" font-weight="700"
      letter-spacing="0.5" fill="${C.ink}">Pixels in.</text>
<text x="104" y="500" font-family="${FONT_DISPLAY}" font-size="122" font-weight="700"
      letter-spacing="0.5" fill="${C.ink}">Curves out.</text>
<text x="104" y="574" font-family="${FONT_DISPLAY}" font-size="52" font-weight="400" fill="${C.ink2}">And the <tspan fill="${C.accentText}" text-decoration="underline">numbers to prove it</tspan>.</text>

<!-- what the plugin actually does, in four lines -->
<g font-family="${FONT_UI}" font-size="27" fill="${C.ink2}">
  ${[
    'Any layer &#8594; real editable vector paths',
    'Every result scored against the source, in the panel',
    'Trace filled shapes, or centreline for single strokes',
    'Runs inside the plugin &#8212; nothing is uploaded',
  ].map((t, i) => `<g transform="translate(104 ${646 + i * 50})">
      <path d="M0 -9L10 -1L0 7Z" fill="${C.accent}"/>
      <text x="24" y="0">${t}</text>
    </g>`).join('\n  ')}
</g>

<!-- measured readout: values come from the verify pass on the panel above -->
<g>
  <rect x="104" y="862" width="756" height="126" rx="10" fill="${C.readout}" stroke="${C.readoutLine}"/>
  <text x="130" y="904" font-family="${FONT_UI}" font-size="22" fill="${C.readoutDim}"
        letter-spacing="2">MEASURED, NOT CLAIMED</text>
  ${[
    ['SSIM', m.on.ssim.toFixed(4), C.ok],
    ['PSNR', `${m.on.psnr.toFixed(1)}${sp}dB`, C.meas],
    ['PATHS', String(m.on.shapes), C.ink],
  ].map(([label, value, colour], i) => `<g transform="translate(${130 + i * 244} 0)">
      <text y="954" font-family="${FONT_MONO}" font-size="20" fill="${C.readoutDim}"
            letter-spacing="2">${label}</text>
      <text y="954" x="88" font-family="${FONT_MONO}" font-size="34" font-weight="700"
            fill="${colour}">${value}</text>
    </g>`).join('\n  ')}
</g>

<!-- before/after: one crop, one magnification, applied to both sides -->
<g>
  <rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="14" fill="${C.surface}" stroke="${C.line}"/>
  <rect x="${IMG.x}" y="${IMG.y}" width="${IMG.w}" height="${IMG.h}" rx="6" fill="${C.cardPaper}"/>

  <g clip-path="url(#clipImg)">
    <g clip-path="url(#clipLeft)">
      <g transform="translate(${IMG.x + INSET} ${IMG.y + INSET}) scale(${FIT})">${gradOff}</g>
    </g>
    <g clip-path="url(#clipRight)">
      <g transform="translate(${IMG.x + INSET} ${IMG.y + INSET}) scale(${FIT})">${gradOn}</g>
    </g>
  </g>

  <line x1="${SPLIT}" y1="${IMG.y}" x2="${SPLIT}" y2="${IMG.y + IMG.h}" stroke="${C.accent}" stroke-width="3"/>
  <circle cx="${SPLIT}" cy="${IMG.y + IMG.h / 2}" r="26" fill="${C.accent}"/>
  <path d="M${SPLIT - 12} ${IMG.y + IMG.h / 2}l9-8v16zM${SPLIT + 12} ${IMG.y + IMG.h / 2}l-9-8v16z" fill="#210415"/>

  <g font-family="${FONT_UI}" font-size="24" font-weight="600">
    <rect x="${IMG.x + 14}" y="${IMG.y + IMG.h - 56}" width="200" height="42" rx="21" fill="${C.readout}" opacity="0.92"/>
    <text x="${IMG.x + 34}" y="${IMG.y + IMG.h - 27}" fill="${C.readoutDim}">Colour${sp}bands</text>
    <rect x="${IMG.x + IMG.w - 254}" y="${IMG.y + IMG.h - 56}" width="240" height="42" rx="21" fill="${C.readout}" opacity="0.92"/>
    <text x="${IMG.x + IMG.w - 234}" y="${IMG.y + IMG.h - 27}" fill="${C.accentText}">Editable${sp}gradient</text>
  </g>

  <text x="${P.x + 24}" y="${IMG.y + IMG.h + 62}" font-family="${FONT_UI}" font-size="26" fill="${C.ink2}">A ramp comes back as one gradient fill, not stacked bands.</text>
  <text x="${P.x + 24}" y="${IMG.y + IMG.h + 104}" font-family="${FONT_MONO}" font-size="21" fill="${C.readoutDim}">SSIM${sp}${m.off.ssim.toFixed(4)}${sp}&#8594;${sp}${m.on.ssim.toFixed(4)}${sp}&#183;${sp}${m.off.shapes}${sp}paths${sp}&#8594;${sp}${m.on.shapes}</text>
</g>

<text x="104" y="1024" font-family="${FONT_UI}" font-size="25" fill="${C.readoutDim}">Free and open source (MIT)${sp}&#183;${sp}vecline.xyz</text>
</svg>`;

writeFileSync(join(ART, 'thumbnail.svg'), thumb);
writeFileSync(join(ROOT, 'extensions', 'figma', 'thumbnail.png'), render(thumb, W));

/* -- 4. the 128x128 icon ------------------------------------------------- */
/* Padded so the mark does not sit edge-to-edge once a store crops it into a
   rounded tile, and on the brand *light* paper rather than the dark one.
   A dark tile is the more striking of the two, but Community renders icons
   against whichever theme the viewer is in, and a dark tile sinks into a dark
   listing; the light tile is legible in both. Not transparent either — that
   loses the mark entirely against dark chrome. */
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<defs><linearGradient id="vgrad" x1="0" y1="1" x2="1" y2="0">
  <stop offset="0" stop-color="#A3005A"/><stop offset="1" stop-color="#FF4D9E"/>
</linearGradient></defs>
<rect width="128" height="128" rx="26" fill="#FDFBFD"/>
${mark(22, 24, 84, '#1B1220')}
</svg>`;
writeFileSync(join(ART, 'icon.svg'), icon);
writeFileSync(join(ROOT, 'extensions', 'figma', 'icon.png'), render(icon, 128));

/* -- 5. the Community profile avatar ------------------------------------- */
/* Same tile at 512, because Figma crops the profile picture to a circle and
   renders it at several sizes; 128 upscales visibly on the profile header.
   The corner radius is dropped since a circular crop discards it anyway, and
   the mark is inset further so the circle does not clip the arrowhead. */
const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="vgrad" x1="0" y1="1" x2="1" y2="0">
  <stop offset="0" stop-color="#A3005A"/><stop offset="1" stop-color="#FF4D9E"/>
</linearGradient></defs>
<rect width="512" height="512" fill="#FDFBFD"/>
${mark(126, 132, 260, '#1B1220')}
</svg>`;
writeFileSync(join(ART, 'avatar.svg'), avatar);
writeFileSync(join(ROOT, 'extensions', 'figma', 'avatar.png'), render(avatar, 512));

console.log(`thumbnail.png  ${W}x${H}`);
console.log(`icon.png       128x128`);
console.log(`panel  gradients off  SSIM ${m.off.ssim.toFixed(6)}  PSNR ${m.off.psnr.toFixed(2)} dB  ${m.off.shapes} paths  ${m.off.kb} KB`);
console.log(`panel  gradients on   SSIM ${m.on.ssim.toFixed(6)}  PSNR ${m.on.psnr.toFixed(2)} dB  ${m.on.shapes} paths  ${m.on.kb} KB`);
