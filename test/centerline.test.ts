import { describe, expect, it } from 'vitest';
import { centerlineTrace } from '../src/vectorize/centerline.js';
import { createImage, setPixel } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

function white(w: number, h: number): RasterImage {
  const img = createImage(w, h);
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; }
  return img;
}

/** A horizontal black bar `thickness` px tall — a single stroke. */
function hbar(w: number, h: number, thickness: number): RasterImage {
  const img = white(w, h);
  const cy = Math.floor(h / 2);
  for (let y = cy - Math.floor(thickness / 2); y <= cy + Math.floor(thickness / 2); y++) {
    for (let x = 4; x < w - 4; x++) setPixel(img, x, y, 0, 0, 0);
  }
  return img;
}

describe('centerlineTrace', () => {
  it('reduces a thick stroke to ONE single-stroke open path, not a double-edged fill', () => {
    const out = centerlineTrace(hbar(80, 40, 6));
    expect(out.paths).toBe(1);
    expect(out.svg).toContain('fill="none"');
    // one <path>, and it's a stroke not a fill
    expect((out.svg.match(/<path/g) ?? []).length).toBe(1);
    expect(out.svg).not.toMatch(/fill="#/); // no filled regions
  });

  it('splits a junction into separate arms', () => {
    // A plus sign: one centre junction, four arms.
    const img = white(60, 60);
    for (let y = 6; y < 54; y++) for (let x = 28; x <= 31; x++) setPixel(img, x, y, 0, 0, 0);
    for (let x = 6; x < 54; x++) for (let y = 28; y <= 31; y++) setPixel(img, x, y, 0, 0, 0);
    const out = centerlineTrace(img);
    expect(out.paths).toBeGreaterThanOrEqual(3); // arms meeting at the junction
    expect(out.svg).toContain('stroke-linecap="round"');
  });

  it('honours stroke width, colour and white-on-black', () => {
    const out = centerlineTrace(hbar(60, 30, 4), { strokeWidth: 2.5, stroke: '#f00' });
    expect(out.svg).toContain('stroke-width="2.5"');
    expect(out.svg).toContain('stroke="#f00"');

    // Inverted: a white bar on black should trace with --white-on-black.
    const inv = white(60, 30);
    for (let i = 0; i < inv.data.length; i += 4) { inv.data[i] = inv.data[i + 1] = inv.data[i + 2] = 0; }
    const cy = 15;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = 4; x < 56; x++) setPixel(inv, x, y, 255, 255, 255);
    expect(centerlineTrace(inv, { blackOnWhite: false }).paths).toBe(1);
  });

  it('drops strokes below the minimum length', () => {
    const img = white(60, 60);
    // one long stroke + one 2px speck
    for (let x = 4; x < 56; x++) setPixel(img, x, 30, 0, 0, 0);
    setPixel(img, 10, 10, 0, 0, 0);
    setPixel(img, 11, 10, 0, 0, 0);
    const out = centerlineTrace(img, { minLength: 5 });
    expect(out.paths).toBe(1);
  });
});
