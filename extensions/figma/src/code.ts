/**
 * Figma plugin — main thread.
 *
 * This half runs in Figma's sandbox: it can read and write the document but has
 * no DOM, so it cannot decode a PNG or rasterise an SVG. All it does is hand the
 * selection's pixels to the UI iframe, wait for traced geometry to come back, and
 * insert it. The engine itself lives in the iframe, which is the only place with
 * a canvas.
 *
 * Insertion uses `figma.createNodeFromSvg`. That was the one genuinely uncertain
 * part of this plugin, so it was checked before any of it was written: a
 * Vecline-emitted SVG pasted into Figma comes back as real editable Vector paths
 * with the gradient intact as an editable Linear fill — not a flattened raster.
 * Our gradients avoid the two documented importer failures (percentage
 * coordinates and `gradientTransform`) because they are emitted with
 * `gradientUnits="userSpaceOnUse"` and absolute values.
 */

/// <reference types="@figma/plugin-typings" />

import { placement } from './place.js';

/** Anything with pixels we can export. Text and groups qualify; a page does not. */
function exportable(node: SceneNode): boolean {
  return 'exportAsync' in node;
}

/**
 * Export scale for the selection: the layer's own size.
 *
 * This was 2x, on the theory that more input detail would help. It does not, and
 * the theory was never measured before it shipped. The tracer emits an
 * axis-aligned staircase rather than curves at its default tolerance, so doubling
 * the input doubles the number of steps; resizing the result back to the layer's
 * size then lands every one of those steps on a half-pixel, which is what read as
 * chewed, ragged edges in the canvas. Measured on a logo with a gradient:
 *
 *   1x   SSIM 0.9301   2,804 h/v commands    8 KB
 *   2x   SSIM 0.9033   5,108 h/v commands   14 KB
 *
 * Worse fidelity, nearly twice the geometry, and almost twice the file — so 2x
 * cost something on every axis and bought nothing on any.
 */
const EXPORT_SCALE = 1;

figma.showUI(__html__, { width: 340, height: 460, themeColors: true });

type UiMessage =
  | { type: 'traced'; svg: string; sourceId: string; ssim: number | null; psnr: number | null; ms: number; bytes: number; note?: string }
  | { type: 'failed'; message: string }
  | { type: 'ready' };

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'ready') {
    sendSelection();
    return;
  }

  if (msg.type === 'failed') {
    figma.notify(`Vecline: ${msg.message}`, { error: true });
    return;
  }

  if (msg.type === 'traced') {
    try {
      // Resolve the layer this result was actually traced from, rather than
      // whatever happens to be selected now. A trace takes around half a second
      // and the user is free to click elsewhere during it; re-reading the
      // selection meant the copy could be sized to a different layer's aspect
      // ratio and named after it.
      const source = msg.sourceId ? await figma.getNodeByIdAsync(msg.sourceId) : null;
      const src = source && 'width' in source ? (source as SceneNode) : null;

      const node = figma.createNodeFromSvg(msg.svg);
      if (src) {
        // Export happens at the layer's own size, so the SVG comes back at that
        // size already. Resizing is still worth doing because export bounds and
        // node bounds are not always equal — a drop shadow or stroke that bleeds
        // outside the box makes the render larger than the layer.
        if (src.width >= 0.01 && src.height >= 0.01) node.resize(src.width, src.height);
        placeBeside(node, src);
        node.name = `${src.name} (vecline)`;
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView(src ? [src, node] : [node]);

      const quality = msg.ssim === null
        ? 'not measured'
        : `SSIM ${msg.ssim.toFixed(4)}${msg.psnr !== null && isFinite(msg.psnr) ? ` · PSNR ${msg.psnr.toFixed(1)} dB` : ' · PSNR ∞'}`;
      figma.notify(`Vecline → ${(msg.bytes / 1024).toFixed(1)} KB · ${quality} · ${msg.ms} ms`);
      // The medial-axis advisory rides as its own longer-lived toast so it is
      // not lost behind the metrics line.
      if (msg.note) figma.notify(`Vecline: ${msg.note}`, { timeout: 6000 });
    } catch (err) {
      // A failure here means the SVG did not survive the importer, which is
      // worth saying plainly rather than leaving an empty canvas.
      figma.notify(`Vecline: Figma rejected the traced SVG — ${(err as Error).message}`, { error: true });
    }
  }
};

/**
 * Apply the placement decision from `place.ts` to the real nodes.
 *
 * The arithmetic deliberately lives in a separate, Figma-free module so it can
 * be unit-tested — `test/figma-placement.test.ts` in the main repo covers the
 * container cases, including the nested-in-a-frame one that this originally got
 * wrong. All that happens here is translating a `SceneNode` into the small
 * structural description that function takes, and doing what it says.
 */
function placeBeside(node: SceneNode, source: SceneNode): void {
  const parent = source.parent;
  const decision = placement({
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    absoluteBoundingBox: source.absoluteBoundingBox,
    parent: parent
      ? {
        ...('layoutMode' in parent ? { layoutMode: parent.layoutMode as string } : {}),
        canAppend: 'appendChild' in parent && parent.type !== 'DOCUMENT',
      }
      : null,
  });

  if (decision.reparent && parent && 'appendChild' in parent) parent.appendChild(node);
  node.x = decision.x;
  node.y = decision.y;
}

/** Export the current selection to PNG bytes and hand them to the iframe. */
async function sendSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'selection', ok: false, reason: 'Select a layer to vectorize.' });
    return;
  }
  const node = selection[0];
  if (!exportable(node)) {
    figma.ui.postMessage({ type: 'selection', ok: false, reason: `A ${node.type.toLowerCase()} cannot be exported.` });
    return;
  }

  try {
    // At the layer's own size — see EXPORT_SCALE above for the measurements
    // that settled it. (This comment used to claim 2x, which stopped being true
    // when the constant changed and nobody re-read the prose next to it.)
    const bytes = await (node as ExportMixin).exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: EXPORT_SCALE },
    });
    figma.ui.postMessage({
      type: 'selection',
      ok: true,
      // Carried so the result can be matched back to this exact layer even if
      // the selection moves on while the trace is running.
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      bytes,
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'selection', ok: false, reason: (err as Error).message });
  }
}

figma.on('selectionchange', () => { void sendSelection(); });
