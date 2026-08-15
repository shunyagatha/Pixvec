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

import { trace, compareImages } from 'vecline/core';

type RasterImage = { width: number; height: number; data: Uint8ClampedArray };

const $ = (id: string): HTMLElement => document.getElementById(id)!;

let pending: { bytes: Uint8Array; name: string } | null = null;

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

    setStatus('Tracing…', 'busy');
    const mode = ($('mode') as HTMLSelectElement).value;
    const colors = Number(($('colors') as HTMLInputElement).value);
    const gradients = ($('gradients') as HTMLInputElement).checked;
    const result = trace(image as never, { colors, gradients, mode } as never) as { svg: string };

    setStatus('Scoring…', 'busy');
    const rendered = await rasterize(result.svg, image.width, image.height);
    const q = rendered ? (compareImages(image as never, rendered as never) as { ssim: number; psnr: number }) : null;

    parent.postMessage({
      pluginMessage: {
        type: 'traced',
        svg: result.svg,
        ssim: q ? q.ssim : null,
        psnr: q ? q.psnr : null,
        ms: Math.round(performance.now() - started),
        bytes: result.svg.length,
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
  pending = { bytes: msg.bytes as Uint8Array, name: msg.name as string };
  $('target').textContent = `${msg.name}  ${msg.width}×${msg.height}`;
  button.disabled = false;
  setStatus('Ready');
};

$('go').addEventListener('click', () => { void run(); });
$('colors').addEventListener('input', () => {
  $('colorsVal').textContent = ($('colors') as HTMLInputElement).value;
});

parent.postMessage({ pluginMessage: { type: 'ready' } }, '*');
