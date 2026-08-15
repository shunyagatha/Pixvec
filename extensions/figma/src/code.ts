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
  | { type: 'traced'; svg: string; ssim: number | null; psnr: number | null; ms: number; bytes: number }
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
      const node = figma.createNodeFromSvg(msg.svg);
      const source = figma.currentPage.selection[0];
      if (source) {
        // The selection is exported at EXPORT_SCALE so the tracer sees more than
        // screen resolution, which means the SVG comes back that many times too
        // big. Resizing to the source's own dimensions puts it back — and because
        // the result is vector, nothing is lost in the process. Without this the
        // traced copy silently arrived at 810x768 beside a 405x384 original.
        node.resize(source.width, source.height);
        // Place it beside the original rather than on top of it, so the
        // comparison is immediate and nothing is hidden.
        node.x = source.x + source.width + 40;
        node.y = source.y;
        node.name = `${source.name} (vecline)`;
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);

      const quality = msg.ssim === null
        ? 'not measured'
        : `SSIM ${msg.ssim.toFixed(4)}${msg.psnr !== null && isFinite(msg.psnr) ? ` · PSNR ${msg.psnr.toFixed(1)} dB` : ' · PSNR ∞'}`;
      figma.notify(`Vecline → ${(msg.bytes / 1024).toFixed(1)} KB · ${quality} · ${msg.ms} ms`);
    } catch (err) {
      // A failure here means the SVG did not survive the importer, which is
      // worth saying plainly rather than leaving an empty canvas.
      figma.notify(`Vecline: Figma rejected the traced SVG — ${(err as Error).message}`, { error: true });
    }
  }
};

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
    // 2x so the tracer sees more than the on-screen resolution; the SVG it
    // returns is resolution-independent either way, and the extra detail is
    // what the palette is derived from.
    const bytes = await (node as ExportMixin).exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: EXPORT_SCALE },
    });
    figma.ui.postMessage({
      type: 'selection',
      ok: true,
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
