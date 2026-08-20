import { describe, expect, it } from 'vitest';
import { trace } from '../src/vectorize/trace.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { hairline, silhouetteDistance } from '../scripts/lib/hairline.mjs';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * The opaque silhouette underpaint.
 *
 * WHAT IT IS FOR. Two abutting fills are two elements, so at their shared edge
 * one covers `c` of the pixel and the other `1 - c`, and source-over leaves
 * `1 - c + c^2` — three quarters at `c = 0.5`. Artwork with no transparency has a
 * background rectangle underneath and nobody sees it. Artwork WITH transparency
 * has nothing underneath, so pixels the source calls fully opaque come back
 * see-through along every interior boundary.
 *
 * Every assertion here was mutation-checked: the defect it describes was
 * reintroduced in `src/vectorize/trace.ts`, the replacement confirmed to have
 * applied, and the test observed to fail. A mutation that no longer matches the
 * file passes and looks like a green test, which is the failure mode this note
 * exists to rule out.
 */

/** A disc split into two colours by a diagonal, on transparent background. */
function splitDisc(width = 90, height = 90): RasterImage {
  const img = createImage(width, height);
  const cx = width / 2, cy = height / 2, r = width * 0.42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample the disc 4x4 so the edge is antialiased, as real artwork is.
      let cov = 0, split = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
          if (Math.hypot(px - cx, py - cy) <= r) { cov++; if (py > px * 0.6 + 18) split++; }
        }
      }
      if (cov === 0) continue;
      const a = Math.round((cov / 16) * 255);
      const lower = split * 2 > cov;
      if (lower) setPixel(img, x, y, 24, 32, 120, a);
      else setPixel(img, x, y, 236, 208, 40, a);
    }
  }
  return img;
}

/** The same artwork with no transparent pixel anywhere. */
function splitDiscOnField(width = 90, height = 90): RasterImage {
  const img = splitDisc(width, height);
  for (let i = 0; i < width * height; i++) {
    if (img.data[i * 4 + 3] === 255) continue;
    img.data[i * 4] = 250; img.data[i * 4 + 1] = 250; img.data[i * 4 + 2] = 250;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

const OPTS = { mosaic: true, colors: 4, minArea: 1, strokeWidth: 0.5 } as const;

/** Elements that paint an area, in document order. */
function fills(svg: string): Array<{ id: string | null; d: string; attrs: string }> {
  return [...svg.matchAll(/<path([^>]*)\sd="([^"]*)"([^>]*)\/>/g)].map((m) => ({
    id: /\bid="([^"]*)"/.exec(m[1] + m[3])?.[1] ?? null,
    d: m[2],
    attrs: m[1] + m[3],
  }));
}

/**
 * Source-opaque pixels rendered below alpha 250, and how many of those are
 * INTERIOR — every neighbour within one step is source-opaque too, so the
 * artwork's own antialiased edge cannot explain them.
 */
function leaksIn(
  image: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
  src: RasterImage,
): { total: number; interior: number } {
  const { width, height } = src;
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && src.data[(y * width + x) * 4 + 3] === 255;
  let total = 0, interior = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaque(x, y)) continue;
      if (image.data[(y * width + x) * 4 + 3] >= 250) continue;
      total++;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!opaque(x + dx, y + dy)) edge = true;
      if (!edge) interior++;
    }
  }
  return { total, interior };
}

async function leaks(svg: string, src: RasterImage): Promise<{ total: number; interior: number }> {
  return leaksIn((await rasterizeSvg(svg, { width: src.width })).image, src);
}

describe('the leak instrument', () => {
  // An instrument that returns 0 because it cannot see is indistinguishable
  // from a document with no defect, and every assertion below rests on it.
  it('answers zero for a perfect render and finds a defect that is put there', () => {
    const src = splitDisc();
    const perfect = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    expect(leaksIn(perfect, src)).toEqual({ total: 0, interior: 0 });

    // Two pixels made see-through: one deep inside the disc, one on its edge.
    const cx = src.width >> 1, cy = src.height >> 1;
    const edge = (() => {
      for (let x = 0; x < src.width; x++) {
        const i = cy * src.width + x;
        if (src.data[i * 4 + 3] !== 255) continue;
        // The first opaque pixel on this row has a non-opaque neighbour.
        return i;
      }
      throw new Error('fixture has no opaque pixel on its centre row');
    })();
    perfect.data[(cy * src.width + cx) * 4 + 3] = 200;
    perfect.data[edge * 4 + 3] = 200;
    expect(leaksIn(perfect, src)).toEqual({ total: 2, interior: 1 });
  });
});

describe('the underpaint carries no new geometry', () => {
  it('is one path whose d is the opaque fills concatenated, character for character', () => {
    const { svg } = trace(splitDisc(), { ...OPTS, underpaint: true });
    const els = fills(svg);
    const under = els.filter((e) => e.id === 'underpaint');
    expect(under).toHaveLength(1);
    // Every coordinate in it is already in the document. Not "close to" — the
    // same string, which is what makes the union exact rather than an
    // approximation that could halo outside the artwork or fall short of it.
    const opaqueFills = els.filter((e) => e.id !== 'underpaint' && !/fill-opacity=/.test(e.attrs));
    expect(opaqueFills.length).toBeGreaterThan(1);
    expect(under[0].d).toBe(opaqueFills.map((e) => e.d).join(''));
  });

  it('paints first, with evenodd and no stroke', () => {
    const { svg } = trace(splitDisc(), { ...OPTS, underpaint: true });
    const els = fills(svg);
    // Document order is paint order: it must be under everything it repeats.
    expect(els[0].id).toBe('underpaint');
    expect(els[0].attrs).toContain('fill-rule="evenodd"');
    expect(els[0].attrs).not.toContain('stroke');
    // And it takes the largest opaque class's colour, so the band it shows
    // through in is the commonest colour rather than an invented one.
    const largest = els.find((e) => e.id !== 'underpaint')!;
    expect(/fill="(#[0-9a-f]+)"/.exec(els[0].attrs)![1])
      .toBe(/fill="(#[0-9a-f]+)"/.exec(largest.attrs)![1]);
  });
});

describe('the underpaint closes the interior seam', () => {
  it('removes every interior leak, and leaves the silhouette fringe alone', async () => {
    const src = splitDisc();
    const plain = trace(src, OPTS).svg;
    const under = trace(src, { ...OPTS, underpaint: true }).svg;
    const before = await leaks(plain, src);
    const after = await leaks(under, src);
    // The defect exists in the fixture at all — a test whose subject is absent
    // cannot fail for the right reason.
    expect(before.interior).toBeGreaterThan(0);
    expect(after.interior).toBe(0);
    // The fringe at the silhouette is partial coverage of a shape that really
    // does end there, so it is not something to remove. It must not GROW: an
    // underpaint that spilled past the fills would fatten the artwork.
    expect(after.total).toBeLessThanOrEqual(before.total);
  });

  // At an integer scale every lattice edge lands on a pixel boundary and the
  // rasteriser antialiases nothing, so a document can look seam-free purely
  // because the sampling grid happened to agree with it — the 1x case above
  // cannot tell that apart from a real fix. 3.902 cannot land on a boundary by
  // construction (see scripts/lib/hairline.mjs), so a leak merely pushed below
  // one sampling grid, rather than actually closed, would still show up here.
  //
  // strokeWidth is zeroed, unlike every other test in this file: it repaints
  // each region's own antialiasing fringe and, at this magnification, that
  // same-colour stroke alone becomes wide enough in render pixels to paper
  // over the compositing gap regardless of `underpaint` (measured: shared
  // `OPTS`, i.e. strokeWidth 0.5, gives 0 interior leaks at 3.902x for BOTH
  // the plain and the underpainted trace). Left in, the `before.interior > 0`
  // guard below would still fail on that config — but for the wrong reason,
  // "this fixture stops exhibiting the defect at this scale", not the thing
  // this test exists to check. Isolating strokeWidth out keeps it pointed at
  // the mechanism it names.
  it('removes every interior leak under magnification too, not only at 1x', async () => {
    const src = splitDisc();
    const isolated = { ...OPTS, strokeWidth: 0 };
    const plain = trace(src, isolated).svg;
    const under = trace(src, { ...isolated, underpaint: true }).svg;
    const dist = silhouetteDistance(src);
    const scale = 3.902;
    const renderAt = async (svg: string) =>
      (await rasterizeSvg(svg, { width: Math.round(src.width * scale) })).image;
    const before = hairline(src, await renderAt(plain), { scale, dist });
    const after = hairline(src, await renderAt(under), { scale, dist });
    expect(before.interior).toBeGreaterThan(0);
    expect(after.interior).toBe(0);
  });

  it('composes with interpolate rather than fighting it for the same layer', async () => {
    const src = splitDisc();
    const blend = trace(src, { ...OPTS, interpolate: true }).svg;
    const both = trace(src, { ...OPTS, interpolate: true, underpaint: true }).svg;
    // The blend layer is still there, and the underpaint is beneath it — the
    // band is meant to be seen in the gap, so painting the silhouette over it
    // would hide exactly what that layer emits. (`<clipPath>` lives in `<defs>`
    // at the top of the file and says nothing about paint order; the layer's own
    // `<g fill="none" stroke-width=` is what has to come second.)
    const layer = both.indexOf('<g fill="none" stroke-width=');
    expect(layer).toBeGreaterThan(-1);
    expect(both.indexOf('id="underpaint"')).toBeLessThan(layer);
    // interpolate does not fix this defect; the underpaint does, under it.
    expect((await leaks(blend, src)).interior).toBeGreaterThan(0);
    expect((await leaks(both, src)).interior).toBe(0);
  });
});

describe('the underpaint is refused where it would do harm or nothing', () => {
  it('is absent, and the document byte-identical, when nothing is transparent', () => {
    const src = splitDiscOnField();
    const plain = trace(src, OPTS).svg;
    const asked = trace(src, { ...OPTS, underpaint: true }).svg;
    // A background rectangle already covers every interior seam, so this would
    // be bytes for nothing. Byte-identical, not merely similar: that is what
    // makes it safe to turn on in a preset that also traces photographs.
    expect(asked).toBe(plain);
    expect(asked).not.toContain('id="underpaint"');
  });

  it('never paints under a translucent class', () => {
    // Half the disc at alpha 128. Painting the silhouette under it would show
    // through and change its colour.
    const src = splitDisc();
    for (let i = 0; i < src.width * src.height; i++) {
      if (src.data[i * 4 + 3] === 255 && src.data[i * 4] < 128) src.data[i * 4 + 3] = 128;
    }
    const { svg } = trace(src, { ...OPTS, alphaLevels: 4, underpaint: true });
    const els = fills(svg);
    const under = els.find((e) => e.id === 'underpaint');
    expect(under).toBeDefined();
    const translucent = els.filter((e) => /fill-opacity=/.test(e.attrs));
    expect(translucent.length).toBeGreaterThan(0);
    for (const t of translucent) expect(under!.d).not.toContain(t.d);
  });

  it('stands down under groupByColor and under extendUnder', () => {
    const src = splitDisc();
    // A separation must be a standalone file per colour; a shared underlay is
    // not one colour's geometry.
    expect(trace(src, { ...OPTS, underpaint: true, groupByColor: true }).svg)
      .not.toContain('id="underpaint"');
    // extendUnder removes the seam by overlapping instead, and its class paths
    // are unions rather than each class's own outline.
    expect(trace(src, { ...OPTS, underpaint: true, extendUnder: true }).svg)
      .not.toContain('id="underpaint"');
  });

  it('is off unless asked for', () => {
    expect(trace(splitDisc(), OPTS).svg).not.toContain('id="underpaint"');
  });
});
