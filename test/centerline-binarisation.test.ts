import { describe, expect, it } from 'vitest';
import { centerlinePolylines, centerlineTrace } from '../src/vectorize/centerline.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * Centreline has to find the ink regardless of how the artwork is coloured or
 * grounded. Two ways it did not, both of which returned an empty result while
 * every prior test passed:
 *
 *   1. A shape exported from a design tool arrives as opaque ink on a
 *      TRANSPARENT ground, and the ink can be any colour. The binariser split
 *      on luminance, which has nothing to separate when every opaque pixel is
 *      the same colour, so it produced an empty mask. This is the dominant
 *      real-world case — a Figma icon layer is transparent — and it traced to
 *      nothing.
 *
 *   2. Even on an opaque ground, Otsu bins round(luma) but the binariser
 *      compared the raw float against the returned cutoff, so any fill colour
 *      whose luminance landed on the cutoff's fractional edge was excluded from
 *      its own class. That silently lost about half of all flat colours.
 *
 * Every fixture here is a single flat colour, which is what these bugs needed
 * and what the existing black-on-white tests never exercised.
 */

const HEX: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  darkGrey: [26, 26, 26],
  slate: [0x33, 0x41, 0x55],   // luma 63.47 — lands on a cutoff edge
  teal: [0x12, 0xb8, 0x86],    // luma 145.10 — lands on a cutoff edge
  white: [255, 255, 255],
};

/** A stroked rectangle outline in `colour`, on `ground` ('transparent' or a hex). */
function outline(colour: keyof typeof HEX, ground: keyof typeof HEX | 'transparent'): RasterImage {
  const W = 200, H = 120;
  const img = createImage(W, H);
  const [r, g, b] = HEX[colour];
  if (ground !== 'transparent') {
    const [gr, gg, gb] = HEX[ground];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, gr, gg, gb);
  }
  // A 3px-thick rectangle border.
  for (let y = 20; y < H - 20; y++) {
    for (let x = 20; x < W - 20; x++) {
      const onBorder = x < 23 || x >= W - 23 || y < 23 || y >= H - 23;
      if (onBorder) setPixel(img, x, y, r, g, b);
    }
  }
  return img;
}

/** Ink is the minority of opaque pixels — the plugin's polarity hint. */
function inkIsDark(img: RasterImage): boolean {
  let dark = 0, light = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    const y = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
    if (y < 128) dark++;
    else light++;
  }
  return dark <= light;
}

describe('centerline binarisation across colour and ground', () => {
  // The regression: a transparent ground, every ink colour. Each of these
  // returned zero polylines before alpha was allowed to define the shape.
  for (const colour of ['black', 'darkGrey', 'slate', 'teal', 'white'] as const) {
    it(`traces a ${colour} outline on a transparent ground`, () => {
      const img = outline(colour, 'transparent');
      const polylines = centerlinePolylines(img, { blackOnWhite: inkIsDark(img) });
      expect(polylines.length).toBeGreaterThan(0);
      // The rectangle border is ~480px round; the skeleton should be most of it.
      const total = polylines.reduce((sum, line) => {
        let len = 0;
        for (let i = 1; i < line.length; i++) {
          len += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y);
        }
        return sum + len;
      }, 0);
      expect(total).toBeGreaterThan(300);
    });
  }

  // The rounding regression: colours that sit on a cutoff's fractional edge,
  // on an opaque white ground. slate (63.47) and teal (145.10) returned zero.
  for (const colour of ['black', 'slate', 'teal'] as const) {
    it(`traces a ${colour} outline on opaque white`, () => {
      const img = outline(colour, 'white');
      const polylines = centerlinePolylines(img, { blackOnWhite: true });
      expect(polylines.length).toBeGreaterThan(0);
    });
  }

  it('still separates genuine dark ink from a light opaque ground', () => {
    // The fix must not turn a real two-tone image into "everything is ink".
    const img = outline('black', 'white');
    const polylines = centerlinePolylines(img, { blackOnWhite: true });
    // The skeleton is the border, not the whole 200x120 field. If the fix wrongly
    // took every opaque pixel as ink, the interior would fill in and the skeleton
    // would balloon well past the border's ~480px perimeter.
    const total = polylines.reduce((sum, line) => {
      let len = 0;
      for (let i = 1; i < line.length; i++) {
        len += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y);
      }
      return sum + len;
    }, 0);
    expect(total).toBeLessThan(700);
  });

  it('reports zero paths for a fully transparent layer rather than inventing one', () => {
    // The empty-input case the plugin guards on. Nothing opaque, nothing to trace.
    const blank = createImage(120, 120);
    const out = centerlineTrace(blank);
    expect(out.paths).toBe(0);
  });

  /**
   * Low contrast is not the same as no contrast.
   *
   * The binariser used to declare "every opaque pixel is ink" whenever Otsu's
   * two class means sat within 24 luma of each other, meaning to catch a
   * tight-cropped fill with no background. On a fully opaque image that says
   * the whole frame is ink, whose skeleton prunes away to nothing — so faint
   * pencil, a washed-out scan, or any near-isoluminant ink/paper pair traced to
   * zero paths while a high-contrast copy of the same drawing traced fine.
   *
   * Alpha can only carry the shape when alpha actually varies. When the image
   * is opaque, luminance is the only signal there is, however weak.
   */
  describe('low-contrast opaque line art', () => {
    const cross = (paper: number, ink: number): RasterImage => {
      const img = createImage(48, 48);
      for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 48; x++) {
          const onInk = (y >= 22 && y <= 25) || (x >= 22 && x <= 25);
          const v = onInk ? ink : paper;
          setPixel(img, x, y, v, v, v, 255);
        }
      }
      return img;
    };

    // 368 is the drawn ink; 2304 is the whole frame. The bug reported the frame.
    const DRAWN = 4 * 48 + 4 * 48 - 16;

    it.each([
      ['barely separable', 128, 110],
      ['very low contrast', 128, 120],
      ['normal contrast', 128, 60],
      ['maximum contrast', 255, 0],
    ])('finds the strokes at %s (paper %d, ink %d)', (_label, paper, ink) => {
      const out = centerlineTrace(cross(paper, ink));
      expect(out.inkPixels).toBe(DRAWN);
      expect(out.paths).toBeGreaterThan(0);
    });

    it('does not vary its answer with contrast', () => {
      // The whole point: the same drawing at different contrasts is the same
      // drawing, so it must skeletonise to the same thing.
      const faint = centerlineTrace(cross(128, 110));
      const bold = centerlineTrace(cross(255, 0));
      expect(faint.inkPixels).toBe(bold.inkPixels);
      expect(faint.paths).toBe(bold.paths);
    });

    it('still routes a transparent-ground export through alpha', () => {
      // The regime the branch legitimately serves must keep working.
      const img = createImage(48, 48);
      for (let y = 14; y < 34; y++) for (let x = 4; x < 44; x++) setPixel(img, x, y, 90, 200, 90, 255);
      const polys = centerlinePolylines(img);
      expect(polys.length).toBeGreaterThan(0);
    });
  });
});
