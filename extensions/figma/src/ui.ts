/**
 * Figma plugin — UI iframe.
 *
 * The engine runs here because this is the half with a DOM: it can decode the
 * PNG the main thread exported, and it can rasterise the SVG it produced back to
 * pixels in order to score it. `vecline/core` is the right build for exactly this
 * situation — zero dependencies, no Node built-ins, and CI-proven to bundle for a
 * browser, which is what a sandboxed plugin iframe requires.
 *
 * The measurement is not decoration. It is the one thing this plugin offers that
 * Figma's own "Outline stroke" or any paste-an-SVG workflow does not: a number
 * saying how close the vector actually is to the pixels it came from.
 */

import { trace, centerlineTrace, compareImages, type RasterImage } from 'vecline/core';

/**
 * The two things the Mode control chooses between.
 *
 * These used to be one call — `trace(image, { colors, gradients, mode })` — with
 * the arguments cast through `never` to make it compile. `trace` has no `mode`
 * option and never had one, so the centreline half of this control did nothing:
 * both settings produced byte-identical SVG, and the plugin then reported a
 * confident SSIM for a result the user had not asked for. The casts are what
 * hid it. Without them TypeScript rejects the object outright, which is why
 * they are gone and the types below are the real ones from the engine.
 */
type Mode = 'trace' | 'centerline';

/**
 * Douglas–Peucker tolerance for the skeleton, in pixels. The engine's default
 * is 1, which is too tight, and the result is visibly wobbly lines down shapes
 * whose true centre line is dead straight.
 *
 * The reason 1 is too tight is that thinning produces a discrete skeleton with
 * about 0.6px of its own jitter. A tolerance below that preserves the jitter as
 * geometry — you get forty vertices describing a wobble that is an artefact of
 * the pixel grid, not of the artwork. A slightly looser tolerance cuts through
 * the jitter and lands on the underlying line.
 *
 * Raising it costs nothing measurable. Against known ground truth:
 *
 *   shape                  simplify 1        simplify 4
 *   straight band          2 pts, 0.00px     2 pts, 0.00px
 *   3px-wide circle       33 pts, 0.64px    17 pts, 0.64px
 *   6px-wide circle       32 pts, 0.65px    17 pts, 0.65px
 *   28px-wide circle      43 pts, 0.80px    17 pts, 0.63px
 *   arrow + overlap       16 pts, 2.4% long 11 pts, dead straight
 *
 * Half the vertices at identical accuracy on thin strokes, better accuracy on
 * thick ones, and the straight case finally comes out straight. No shape tested
 * got worse, which is why this is a flat constant and not a control.
 */
const SIMPLIFY = 4;

/**
 * Which side of the image is the ink.
 *
 * `centerlineTrace` defaults to treating dark pixels as the line, which is right
 * for a photograph of paper and wrong for artwork sitting on a dark canvas — and
 * a Figma file is as often dark as light. Pointed the wrong way it skeletonises
 * the *background* instead of the strokes: measured on the Vecline mark, correct
 * polarity is 19 polylines against 13 on a dark ground, and 14 against 11 on a
 * light one.
 *
 * The rule is that ink is the minority of an image — a drawing is mostly not
 * drawing. Fully transparent pixels are neither, so they are skipped rather than
 * counted as dark, which is what a naive luma average over RGBA would do to
 * every logo exported with a transparent background.
 */
function inkIsDark(image: RasterImage): boolean {
  const d = image.data;
  let dark = 0;
  let light = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) continue;
    // Rec. 601 luma, the weighting the engine's own threshold uses.
    const y = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    if (y < 128) dark++;
    else light++;
  }
  return dark <= light;
}

function vectorize(
  image: RasterImage,
  mode: Mode,
  colors: number,
  gradients: boolean,
  unevenLighting: boolean,
): string {
  // Centreline is a fundamentally different operation, not a flag on the same
  // one: it binarises, thins to a skeleton and emits open stroked polylines,
  // where trace emits closed filled contours.
  //
  // `adaptive` is OFF by default, and that default was wrong for one release.
  // Bradley-Roth marks a pixel as ink when it sits below its own neighbourhood
  // mean, which is exactly right for a photograph of paper with a shadow across
  // it — and wrong for flat artwork, where a pixel inside a large uniform fill
  // IS its own neighbourhood, so the comparison decides nothing and the mask
  // breaks up along noise. On a Figma frame of flat shapes it skeletonised the
  // background: measured, 56.3% of the skeleton's vertices landed on empty
  // canvas against 100% with a global cutoff, and on a synthetic band the
  // skeleton sat a median 51px from the stroke it was supposed to follow.
  //
  // A design tool mostly holds vector artwork, so the global cutoff is the
  // default and the photograph case is a checkbox rather than an assumption.
  if (mode === 'centerline') {
    return centerlineTrace(image, {
      adaptive: unevenLighting,
      blackOnWhite: inkIsDark(image),
      simplify: SIMPLIFY,
    }).svg;
  }
  return trace(image, { colors, gradients }).svg;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const mode = (): Mode => ($('mode') as HTMLSelectElement).value as Mode;

let pending: { bytes: Uint8Array; name: string; id: string } | null = null;

/**
 * Grey out the controls the current mode ignores.
 *
 * Colours and gradients are trace's parameters; centreline binarises, so a
 * colour count means nothing to it. Leaving them live implied they did
 * something, which is the same failure the dead Mode control was.
 */
function syncControls(): void {
  const centreline = mode() === 'centerline';
  const applies: [string, boolean][] = [
    ['colors', centreline],       // trace's palette; centreline binarises
    ['gradients', centreline],    // likewise
    ['uneven', !centreline],      // thresholding, so centreline only
  ];
  for (const [id, off] of applies) {
    ($(id) as HTMLInputElement).disabled = off;
    $(id).closest('.row')?.classList.toggle('muted', off);
  }
}

/** Decode PNG bytes to the engine's pixel contract, using the browser's decoder. */
async function decode(bytes: Uint8Array): Promise<RasterImage> {
  // Copied into a fresh ArrayBuffer: the bytes arrive over postMessage and TS
  // cannot prove the backing buffer is not shared, which Blob will not accept.
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const blob = new Blob([buf.buffer], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width, height, data };
}

/**
 * Render the traced SVG back to pixels so it can be scored.
 *
 * Returns null rather than throwing when the render fails: an unmeasured result
 * is still a usable result, and reporting "not measured" is honest where
 * inventing a score would not be.
 */
async function rasterize(svg: string, width: number, height: number): Promise<RasterImage | null> {
  try {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.width = width;
      img.height = height;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('render failed'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      return { width, height, data };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

function setStatus(text: string, kind: 'idle' | 'busy' | 'error' = 'idle'): void {
  const el = $('status');
  el.textContent = text;
  el.dataset['kind'] = kind;
}

async function run(): Promise<void> {
  if (!pending) return;
  const button = $('go') as HTMLButtonElement;
  button.disabled = true;
  setStatus('Decoding…', 'busy');

  try {
    const started = performance.now();
    const image = await decode(pending.bytes);

    setStatus(mode() === 'centerline' ? 'Thinning…' : 'Tracing…', 'busy');
    const colors = Number(($('colors') as HTMLInputElement).value);
    const gradients = ($('gradients') as HTMLInputElement).checked;
    const uneven = ($('uneven') as HTMLInputElement).checked;
    const svg = vectorize(image, mode(), colors, gradients, uneven);

    setStatus('Scoring…', 'busy');
    const rendered = await rasterize(svg, image.width, image.height);
    const q = rendered ? compareImages(image, rendered) : null;

    parent.postMessage({
      pluginMessage: {
        type: 'traced',
        svg,
        // The id of the layer this result came from. The main thread used to
        // re-read the selection at insert time, which is a different layer if
        // the user clicked elsewhere during the run.
        sourceId: pending.id,
        ssim: q ? q.ssim : null,
        psnr: q ? q.psnr : null,
        ms: Math.round(performance.now() - started),
        bytes: svg.length,
      },
    }, '*');
    setStatus(q ? `Done · SSIM ${q.ssim.toFixed(4)}` : 'Done · not measured');
  } catch (err) {
    setStatus((err as Error).message, 'error');
    parent.postMessage({ pluginMessage: { type: 'failed', message: (err as Error).message } }, '*');
  } finally {
    button.disabled = !pending;
  }
}

window.onmessage = async (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg || msg.type !== 'selection') return;
  const button = $('go') as HTMLButtonElement;
  if (!msg.ok) {
    pending = null;
    button.disabled = true;
    $('target').textContent = '—';
    setStatus(msg.reason);
    return;
  }
  pending = { bytes: msg.bytes as Uint8Array, name: msg.name as string, id: msg.id as string };
  $('target').textContent = `${msg.name}  ${msg.width}×${msg.height}`;
  button.disabled = false;
  setStatus('Ready');
};

$('go').addEventListener('click', () => { void run(); });
$('mode').addEventListener('change', syncControls);
$('colors').addEventListener('input', () => {
  $('colorsVal').textContent = ($('colors') as HTMLInputElement).value;
});
syncControls();

parent.postMessage({ pluginMessage: { type: 'ready' } }, '*');
