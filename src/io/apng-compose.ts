import type { RasterImage } from '../types.js';
import { readApngFrames, type ApngFrame, type ApngInfo } from './formats/apng.js';

/**
 * Compose APNG frames onto a canvas.
 *
 * {@link readApngFrames} hands back each frame as a standalone PNG of just its
 * own sub-rectangle. That is not what a viewer displays: a frame is painted
 * into a persistent canvas at an offset, blended against what is already there,
 * and the canvas is then disposed of in one of three ways before the next frame
 * arrives. Skipping this and treating each sub-rectangle as a frame produces
 * output that is correct only for the degenerate case where every frame is
 * full-size, opaque and `dispose_op = NONE`.
 *
 * The three-frame dance, in order, per the specification:
 *
 * 1. If `dispose_op` is PREVIOUS, snapshot the canvas *before* painting.
 * 2. Paint the frame — SOURCE replaces the rectangle outright, OVER composites.
 * 3. Emit the canvas. **This** is the frame a viewer shows.
 * 4. Dispose: NONE keeps it, BACKGROUND clears the frame's rectangle to
 *    transparent black, PREVIOUS restores the snapshot from step 1.
 *
 * Getting step 3 and step 4 the wrong way round is the classic APNG bug: it
 * shows the disposal rather than the frame, so `dispose_op = BACKGROUND`
 * animations come out as a series of blank canvases.
 */

export interface ComposedFrame {
  image: RasterImage;
  /** Display time in milliseconds. */
  delayMs: number;
}

export interface ComposedApng {
  frames: ComposedFrame[];
  width: number;
  height: number;
  /** 0 means loop forever. */
  numPlays: number;
  /**
   * What `acTL` declared, which is not always what the file contains. Reported
   * so a truncated APNG can be described as truncated rather than silently
   * yielding fewer frames.
   */
  declaredFrames: number;
}

/** Decodes one standalone PNG to straight (non-premultiplied) RGBA. */
export type PngDecoder = (png: Uint8Array) => Promise<RasterImage>;

/**
 * @param limitInputPixels Total pixels across every frame that may be decoded,
 *   or `false` for no limit. Checked against what `IHDR` and `acTL` *declare*,
 *   before a single frame is decoded: a 30-byte header can claim a huge canvas
 *   and thousands of frames, and finding that out by allocating it is the whole
 *   attack. The declared count is used even when the file carries fewer frames,
 *   because the claim is what a decoder would try to honour.
 */
export async function composeApng(
  bytes: Uint8Array,
  decode: PngDecoder,
  limitInputPixels: number | false = false,
): Promise<ComposedApng> {
  const info: ApngInfo = readApngFrames(bytes);
  const { width, height } = info;

  if (limitInputPixels !== false) {
    const claimed = width * height * Math.max(info.declaredFrames, info.frames.length);
    if (claimed > limitInputPixels) {
      throw new Error(
        `APNG declares ${width}x${height} across ${info.declaredFrames} frames ` +
          `(${claimed.toLocaleString('en-US')} pixels), over the ` +
          `${limitInputPixels.toLocaleString('en-US')} pixel limit.`,
      );
    }
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  let saved: Uint8ClampedArray | null = null;
  const frames: ComposedFrame[] = [];

  for (const frame of info.frames) {
    const decoded = await decode(frame.png);

    if (frame.disposeOp === 2) saved = canvas.slice();

    paint(canvas, width, height, decoded, frame);

    frames.push({
      image: { width, height, data: canvas.slice() },
      delayMs: frame.delayMs,
    });

    if (frame.disposeOp === 1) clearRect(canvas, width, height, frame);
    else if (frame.disposeOp === 2 && saved) canvas.set(saved);
  }

  return {
    frames,
    width,
    height,
    numPlays: info.numPlays,
    declaredFrames: info.declaredFrames,
  };
}

/** Paint a decoded sub-rectangle into the canvas under the frame's blend op. */
function paint(
  canvas: Uint8ClampedArray,
  cw: number,
  ch: number,
  src: RasterImage,
  frame: ApngFrame,
): void {
  const w = Math.min(src.width, frame.width);
  const h = Math.min(src.height, frame.height);

  for (let y = 0; y < h; y++) {
    const cy = frame.y + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < w; x++) {
      const cx = frame.x + x;
      if (cx < 0 || cx >= cw) continue;

      const s = (y * src.width + x) * 4;
      const d = (cy * cw + cx) * 4;
      const sa = src.data[s + 3];

      if (frame.blendOp === 0) {
        // SOURCE: the frame's pixels replace the region, alpha included. A
        // transparent frame pixel therefore punches a hole rather than
        // leaving what was underneath.
        canvas[d] = src.data[s];
        canvas[d + 1] = src.data[s + 1];
        canvas[d + 2] = src.data[s + 2];
        canvas[d + 3] = sa;
        continue;
      }

      // OVER, on straight (non-premultiplied) alpha.
      if (sa === 255) {
        canvas[d] = src.data[s];
        canvas[d + 1] = src.data[s + 1];
        canvas[d + 2] = src.data[s + 2];
        canvas[d + 3] = 255;
        continue;
      }
      if (sa === 0) continue;

      const da = canvas[d + 3];
      const outA = sa + ((da * (255 - sa)) / 255);
      if (outA <= 0) {
        canvas[d] = 0; canvas[d + 1] = 0; canvas[d + 2] = 0; canvas[d + 3] = 0;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const sc = src.data[s + c];
        const dc = canvas[d + c];
        canvas[d + c] = Math.round((sc * sa + ((dc * da * (255 - sa)) / 255)) / outA);
      }
      canvas[d + 3] = Math.round(outA);
    }
  }
}

/** Clear the frame's rectangle to transparent black (dispose_op = BACKGROUND). */
function clearRect(canvas: Uint8ClampedArray, cw: number, ch: number, frame: ApngFrame): void {
  for (let y = 0; y < frame.height; y++) {
    const cy = frame.y + y;
    if (cy < 0 || cy >= ch) continue;
    const rowStart = (cy * cw + Math.max(0, frame.x)) * 4;
    const count = Math.min(frame.width, cw - frame.x) * 4;
    if (count > 0) canvas.fill(0, rowStart, rowStart + count);
  }
}
