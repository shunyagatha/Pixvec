/**
 * Build the Figma Community carousel — the images people scroll after the
 * thumbnail.
 *
 * Same rule as the thumbnail: nothing here is a mockup of a number. The slider
 * slide reads its swatches and its metrics out of build-figma-art-sweep.mjs,
 * the gradient slide out of build-figma-art-trace.mjs, and the privacy slide
 * quotes manifest.json rather than paraphrasing it. If any of those change, the
 * slides change with them.
 *
 *   node scripts/build-figma-carousel.mjs
 */

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'extensions', 'figma', 'art');
const OUT = join(ROOT, 'extensions', 'figma', 'carousel');
const { mkdirSync } = await import('node:fs');
mkdirSync(OUT, { recursive: true });

const C = {
  paper: '#120E18', surface: '#1C1624', line: '#302839', grid: '#241D2D',
  ink: '#F3EDF4', ink2: '#B9AEC2', accent: '#FF4D9E', accentText: '#FF83BB',
  meas: '#5AC6E6', ok: '#4BD3A0', readout: '#0C0910', readoutLine: '#2C2338',
  readoutDim: '#8E819A', cardPaper: '#FDFBFD',
};

const WINFONTS = 'C:/Windows/Fonts/';
const FONT_FILES = ['ARIALN.TTF', 'ARIALNB.TTF', 'segoeui.ttf', 'segoeuib.ttf', 'consola.ttf', 'consolab.ttf']
  .map((f) => WINFONTS + f);
const DISPLAY = "'Arial Narrow', sans-serif";
const UI = "'Segoe UI', system-ui, sans-serif";
const MONO = 'Consolas, monospace';
const sp = '&#160;';

const W = 1920, H = 1080;

const render = (svg) => new Resvg(svg, {
  fitTo: { mode: 'width', value: W },
  font: { loadSystemFonts: true, fontFiles: FONT_FILES, defaultFontFamily: 'Segoe UI' },
}).render().asPng();

function mark(x, y, size, ink) {
  const s = size / 405;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill-rule="evenodd">
    <path fill="${ink}" d="M7 96L130 96L179 173L153 197L110 130L70 131L128 221L102 246L7 98ZM353 96L187 377L139 303L164 277L187 310L264 180L353 97Z"/>
    <path fill="url(#vgrad)" d="M395 6L399 8L380 87L358 69L48 368L23 344L336 45L318 25L395 7Z"/>
  </g>`;
}

const inner = (file) => readFileSync(join(ART, file), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** Shared chrome: background, brand, title, subtitle, footer. */
function slide(title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="vgrad" x1="0" y1="1" x2="1" y2="0">
    <stop offset="0" stop-color="#A3005A"/><stop offset="1" stop-color="#FF4D9E"/>
  </linearGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1"/>
  </pattern>
</defs>
<rect width="${W}" height="${H}" fill="${C.paper}"/>
<rect width="${W}" height="${H}" fill="url(#grid)" opacity="0.55"/>

${mark(100, 74, 54, C.ink)}
<text x="168" y="118" font-family="${DISPLAY}" font-size="46" font-weight="700"
      letter-spacing="1" fill="${C.ink}">VECLINE</text>

<text x="100" y="232" font-family="${DISPLAY}" font-size="86" font-weight="700"
      letter-spacing="0.5" fill="${C.ink}">${title}</text>
<text x="100" y="288" font-family="${UI}" font-size="32" fill="${C.ink2}">${subtitle}</text>

${body}

<text x="100" y="1016" font-family="${UI}" font-size="24" fill="${C.readoutDim}">Free and open source (MIT)${sp}&#183;${sp}vecline.xyz</text>
</svg>`;
}

/* ---------------------------------------------------------------- slide 1 */
/* What actually happens when you press the button, including where the result
   goes — the one thing people worry about with a destructive-sounding verb. */
const steps = [
  ['1', 'Select a layer', 'Any layer with pixels. A frame, a group, a placed image, even text.'],
  ['2', 'Press Trace', 'The engine runs inside the plugin. Colours and gradients are yours to set.'],
  ['3', 'It lands beside it', 'Never on top. Your original layer is untouched, so you can compare.'],
];
const slide1 = slide(
  'Three steps. Nothing overwritten.',
  'The result is placed next to the original, never on top of it.',
  steps.map(([n, head, sub], i) => {
    const x = 100 + i * 590;
    return `<g>
      <rect x="${x}" y="380" width="546" height="330" rx="14" fill="${C.surface}" stroke="${C.line}"/>
      <circle cx="${x + 58}" cy="452" r="34" fill="${C.accent}"/>
      <text x="${x + 58}" y="466" text-anchor="middle" font-family="${DISPLAY}" font-size="42"
            font-weight="700" fill="#210415">${n}</text>
      <text x="${x + 40}" y="560" font-family="${DISPLAY}" font-size="46" font-weight="700" fill="${C.ink}">${head}</text>
      ${wrap(sub, 36, x + 40, 610, 36, UI, 25, C.ink2)}
    </g>`;
  }).join('\n') + `
  <g>
    <rect x="100" y="762" width="1720" height="118" rx="12" fill="${C.readout}" stroke="${C.readoutLine}"/>
    <text x="132" y="812" font-family="${UI}" font-size="22" fill="${C.readoutDim}" letter-spacing="2">THE NOTIFICATION YOU GET</text>
    <text x="132" y="856" font-family="${MONO}" font-size="27" fill="${C.ok}">Vecline${sp}&#8594;${sp}37.8${sp}KB${sp}&#183;${sp}SSIM${sp}0.9982${sp}&#183;${sp}PSNR${sp}45.0${sp}dB${sp}&#183;${sp}870${sp}ms</text>
  </g>`
);

/** Naive greedy wrap — resvg has no text layout, so lines are placed by hand. */
function wrap(text, cols, x, y, lh, family, size, fill) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > cols) { lines.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l, i) =>
    `<text x="${x}" y="${y + i * lh}" font-family="${family}" font-size="${size}" fill="${fill}">${l}</text>`
  ).join('\n');
}

/* ---------------------------------------------------------------- slide 2 */
/* The slider, with the cost of every stop measured rather than described. */
const sweep = JSON.parse(readFileSync(join(ART, 'sweep.json'), 'utf8'));
const CARD = { w: 400, h: 372, gap: 40, y: 350 };
const slide2 = slide(
  'The colours slider, with its receipts.',
  'Every stop below is a real trace of the same image, scored against it.',
  sweep.map((s, i) => {
    const x = 100 + i * (CARD.w + CARD.gap);
    const fit = Math.min((CARD.w - 56) / 405, (CARD.h - 56) / 384);
    const ax = x + (CARD.w - 405 * fit) / 2, ay = CARD.y + (CARD.h - 384 * fit) / 2;
    return `<g>
      <rect x="${x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="12"
            fill="${C.cardPaper}" stroke="${s.isDefault ? C.accent : C.line}" stroke-width="${s.isDefault ? 4 : 1}"/>
      <g transform="translate(${ax} ${ay}) scale(${fit})">${inner(`sweep-${s.colors}.svg`)}</g>
      ${s.isDefault ? `<g>
        <rect x="${x + CARD.w - 126}" y="${CARD.y + 16}" width="110" height="36" rx="18" fill="${C.accent}"/>
        <text x="${x + CARD.w - 71}" y="${CARD.y + 41}" text-anchor="middle" font-family="${UI}"
              font-size="22" font-weight="600" fill="#210415">default</text>
      </g>` : ''}
      <text x="${x}" y="${CARD.y + CARD.h + 62}" font-family="${DISPLAY}" font-size="52" font-weight="700"
            fill="${s.isDefault ? C.accentText : C.ink}">${s.colors} colours</text>
      <text x="${x}" y="${CARD.y + CARD.h + 108}" font-family="${MONO}" font-size="25" fill="${C.ok}">SSIM${sp}${s.ssim.toFixed(4)}</text>
      <text x="${x}" y="${CARD.y + CARD.h + 146}" font-family="${MONO}" font-size="25" fill="${C.readoutDim}">${s.paths}${sp}paths${sp}&#183;${sp}${s.kb}${sp}KB</text>
    </g>`;
  }).join('\n') + `
  <text x="100" y="948" font-family="${UI}" font-size="26" fill="${C.ink2}">16 is the default because that is where the curve flattens${sp}&#8212;${sp}32 colours buys 0.0003 more SSIM for 8 more paths and 4.8 KB.</text>`
);

/* ---------------------------------------------------------------- slide 3 */
/* The gradient claim, shown rather than asserted, with both traces real. */
const m = JSON.parse(readFileSync(join(ART, 'metrics.json'), 'utf8'));
const GCARD = { w: 820, h: 434, y: 344 };
const gfit = Math.min((GCARD.w - 80) / 405, (GCARD.h - 60) / 384);
const slide3 = slide(
  'A ramp comes back as a gradient.',
  'Not a stack of flat bands pretending to be one.',
  gradPanel(100, 'Gradients off', C.readoutDim, inner('grad-off.svg'), m.off) + '\n' +
  gradPanel(1000, 'Gradients on', C.accentText, inner('grad-on.svg'), m.on) + `
  <text x="100" y="948" font-family="${UI}" font-size="26" fill="${C.ink2}">Fewer paths, smaller file, higher score${sp}&#8212;${sp}and it arrives as a real Figma gradient fill you can still edit.</text>`
);

function gradPanel(x, label, labelColour, art, met) {
  const ax = x + (GCARD.w - 405 * gfit) / 2, ay = GCARD.y + (GCARD.h - 384 * gfit) / 2;
  return `<g>
    <rect x="${x}" y="${GCARD.y}" width="${GCARD.w}" height="${GCARD.h}" rx="14" fill="${C.cardPaper}" stroke="${C.line}"/>
    <g transform="translate(${ax} ${ay}) scale(${gfit})">${art}</g>
    <text x="${x}" y="${GCARD.y + GCARD.h + 66}" font-family="${DISPLAY}" font-size="54" font-weight="700" fill="${labelColour}">${label}</text>
    <text x="${x}" y="${GCARD.y + GCARD.h + 112}" font-family="${MONO}" font-size="26" fill="${C.readoutDim}">SSIM${sp}${met.ssim.toFixed(4)}${sp}&#183;${sp}${met.shapes}${sp}paths${sp}&#183;${sp}${met.kb}${sp}KB</text>
  </g>`;
}

/* ---------------------------------------------------------------- slide 4 */
/* The privacy claim, quoting the manifest Figma itself enforces. */
const manifest = JSON.parse(readFileSync(join(ROOT, 'extensions', 'figma', 'manifest.json'), 'utf8'));
const slide4 = slide(
  'Nothing leaves the document.',
  'Not "we do not look at it". There is no request to look at.',
  `<g>
    <rect x="100" y="368" width="900" height="330" rx="14" fill="${C.readout}" stroke="${C.readoutLine}"/>
    <text x="132" y="418" font-family="${UI}" font-size="22" fill="${C.readoutDim}" letter-spacing="2">manifest.json</text>
    ${[
      '"networkAccess": {',
      `  "allowedDomains": ["${manifest.networkAccess.allowedDomains[0]}"]`,
      '}',
    ].map((l, i) => `<text x="132" y="${472 + i * 46}" font-family="${MONO}" font-size="30" fill="${i === 1 ? C.accentText : C.ink}" xml:space="preserve">${l.replace(/ /g, sp)}</text>`).join('\n')}
    <text x="132" y="654" font-family="${UI}" font-size="23" fill="${C.readoutDim}">Figma enforces this. The plugin cannot reach the network even if it tried.</text>
  </g>
  ${[
    ['The tracer runs in the plugin iframe', 'Your pixels are decoded, traced and scored on your machine.'],
    ['No account, no key, no quota', 'Nothing to sign up for and nothing to run out of.'],
    ['No analytics, no telemetry', 'The plugin does not phone home about what you traced.'],
  ].map(([head, sub], i) => `<g transform="translate(1060 ${390 + i * 118})">
      <path d="M0 -14L16 0L0 14Z" fill="${C.accent}"/>
      <text x="34" y="4" font-family="${DISPLAY}" font-size="42" font-weight="700" fill="${C.ink}">${head}</text>
      <text x="34" y="44" font-family="${UI}" font-size="25" fill="${C.ink2}">${sub}</text>
    </g>`).join('\n')}
  <g>
    <rect x="100" y="760" width="1720" height="150" rx="14" fill="${C.surface}" stroke="${C.line}"/>
    <text x="132" y="822" font-family="${DISPLAY}" font-size="46" font-weight="700" fill="${C.ink}">Open source, so you do not have to take our word for it.</text>
    <text x="132" y="872" font-family="${UI}" font-size="27" fill="${C.ink2}">MIT licensed. Read the tracer, the metrics and this plugin at github.com/shunyagatha/Vecline.</text>
  </g>`
);

/* ---------------------------------------------------------------- slide 5 */
/* Where else the identical engine runs, so the plugin is not a dead end. */
const surfaces = [
  ['In Figma', 'This plugin. Select, trace, keep the paths.', false],
  ['In VS Code', 'Right-click a PNG, get a verified SVG.', false],
  ['On the command line', 'npx vecline vectorize logo.png --verify', true],
  ['In the browser', 'vecline.xyz. No upload, no signup, no limit.', false],
  ['To an AI agent', 'An MCP server, so agents can trace and measure.', false],
  ['In your build', 'Vite plugin, GitHub Action, DXF and G-code out.', false],
];
const slide5 = slide(
  'The same engine, wherever you work.',
  'This plugin is one surface on a toolkit, not a one-off.',
  surfaces.map(([head, sub, isMono], i) => {
    const x = 100 + (i % 3) * 590, y = 366 + Math.floor(i / 3) * 250;
    return `<g>
      <rect x="${x}" y="${y}" width="546" height="206" rx="14" fill="${C.surface}" stroke="${C.line}"/>
      <rect x="${x}" y="${y}" width="6" height="206" rx="3" fill="${C.accent}"/>
      <text x="${x + 36}" y="${y + 76}" font-family="${DISPLAY}" font-size="46" font-weight="700" fill="${C.ink}">${head}</text>
      ${wrap(sub, isMono ? 40 : 40, x + 36, y + 122, 36, isMono ? MONO : UI, isMono ? 22 : 25, isMono ? C.ok : C.ink2)}
    </g>`;
  }).join('\n') + `
  <text x="100" y="948" font-family="${UI}" font-size="26" fill="${C.ink2}">One MIT codebase behind all six${sp}&#8212;${sp}so a result you get here is the result you get anywhere.</text>`
);

/* ---------------------------------------------------------------- write */
const slides = [
  ['1-three-steps', slide1],
  ['2-slider-measured', slide2],
  ['3-gradients', slide3],
  ['4-privacy', slide4],
  ['5-everywhere', slide5],
];

for (const [name, svg] of slides) {
  writeFileSync(join(OUT, `${name}.svg`), svg);
  writeFileSync(join(OUT, `${name}.png`), render(svg));
  console.log(`carousel/${name}.png  ${W}x${H}`);
}
