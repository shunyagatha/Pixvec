import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { framesToAnimatedSvg } from '../src/emit/animate.js';
import { traceAnimation } from '../src/pipelines/animate.js';
import { rasterizeSvg } from '../src/io/rasterize.js';

const frame = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;

describe('framesToAnimatedSvg', () => {
  it('stacks frames into one SVG with a CSS flipbook', () => {
    const svg = framesToAnimatedSvg([frame('#f00'), frame('#0f0'), frame('#00f')]);
    expect((svg.match(/<g class="pv-f pv-f\d"/g) ?? [])).toHaveLength(3);
    expect(svg).toContain('@keyframes pv-flip');
    expect(svg).toContain('viewBox="0 0 10 10"');       // inherited from frame 0
    expect(svg).toMatch(/<svg\b/g);
    // Exactly one outer <svg>.
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
  });

  it('makes frame 0 the static poster (opaque without animation)', () => {
    const svg = framesToAnimatedSvg([frame('#f00'), frame('#0f0')]);
    // Base style hides frames, but frame 0 is explicitly opaque.
    expect(svg).toContain('.pv-f{opacity:0');
    expect(svg).toMatch(/\.pv-f0\{animation-delay:0s;opacity:1\}/);
  });

  it('fans frames out with negative per-frame delays', () => {
    const svg = framesToAnimatedSvg([frame('#f00'), frame('#0f0'), frame('#00f')], { duration: 3 });
    expect(svg).toContain('.pv-f1{animation-delay:-1s');
    expect(svg).toContain('.pv-f2{animation-delay:-2s');
  });

  it('guards prefers-reduced-motion by default', () => {
    expect(framesToAnimatedSvg([frame('#f00'), frame('#0f0')])).toContain('prefers-reduced-motion');
    expect(framesToAnimatedSvg([frame('#f00'), frame('#0f0')], { respectReducedMotion: false }))
      .not.toContain('prefers-reduced-motion');
  });

  it('passes a single frame straight through, and freezes when loop is false', () => {
    expect(framesToAnimatedSvg([frame('#f00')])).toBe(frame('#f00'));
    expect(framesToAnimatedSvg([frame('#f00'), frame('#0f0')], { loop: false })).toBe(frame('#f00'));
  });

  it('returns an empty SVG for no frames', () => {
    expect(framesToAnimatedSvg([])).toContain('<svg');
  });
});

/** Build an animated GIF of solid-colour frames, `size`×`size` each. */
async function makeGif(colors: Array<[number, number, number]>, size = 16): Promise<Uint8Array> {
  const frames = await Promise.all(colors.map(([r, g, b]) => {
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
    return sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  }));
  const out = await sharp(frames, { join: { animated: true } })
    .gif({ delay: colors.map(() => 120), loop: 0 })
    .toBuffer();
  return new Uint8Array(out);
}

describe('traceAnimation', () => {
  it('traces every frame of a GIF into one animated SVG with a shared palette', async () => {
    const gif = await makeGif([[220, 30, 30], [30, 200, 60], [40, 70, 210]]);
    const res = await traceAnimation(gif, { trace: { colors: 8 } });

    expect(res.sourceFrames).toBe(3);
    expect(res.frames).toBe(3);
    expect([res.width, res.height]).toEqual([16, 16]);
    expect((res.svg.match(/<g class="pv-f /g) ?? [])).toHaveLength(3);
    expect(res.duration).toBeCloseTo(0.36, 2); // 3 × 120ms
  });

  it('renders frame 0 as the poster in a static rasteriser', async () => {
    const gif = await makeGif([[220, 30, 30], [30, 200, 60]]);
    const res = await traceAnimation(gif, { trace: { colors: 8 } });
    // resvg does not run CSS animations, so it must fall back to frame 0 (red).
    const { image } = await rasterizeSvg(res.svg, { width: 16 });
    const mid = (8 * 16 + 8) * 4;
    expect(image.data[mid]).toBeGreaterThan(150);      // R high
    expect(image.data[mid + 1]).toBeLessThan(110);     // G low
    expect(image.data[mid + 2]).toBeLessThan(110);     // B low
  });

  it('caps frames when asked, sampling evenly', async () => {
    const gif = await makeGif([[10, 10, 10], [80, 80, 80], [150, 150, 150], [240, 240, 240]]);
    const res = await traceAnimation(gif, { maxFrames: 2, trace: { colors: 8 } });
    expect(res.sourceFrames).toBe(4);
    expect(res.frames).toBe(2);
  });
});
