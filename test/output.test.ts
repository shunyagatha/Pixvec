import { describe, expect, it } from 'vitest';
import { trace, traceSeparations } from '../src/vectorize/trace.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';
import { shortHex } from '../src/color.js';
import { toComponent } from '../src/emit/component.js';
import { flatArtwork, photoLike } from './fixtures.js';

/**
 * Output-shape features: layered SVG (Inkscape/Illustrator layers) and per-colour
 * print separations. The contract is that they reorganise the *same* geometry —
 * a layered document must rasterise identically to the flat one.
 */

describe('layered SVG (groupByColor)', () => {
  it('emits one Inkscape layer per colour and declares the namespace', () => {
    const svg = trace(flatArtwork(80, 60), { colors: 8, groupByColor: true }).svg;
    const layers = svg.match(/inkscape:groupmode="layer"/g) ?? [];
    expect(layers.length).toBeGreaterThan(1);
    expect(svg).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(svg).toMatch(/inkscape:label="#[0-9a-f]/); // labelled by colour
  });

  it('leaves the flat tracer untouched when off', () => {
    const svg = trace(flatArtwork(80, 60), { colors: 8 }).svg;
    expect(svg).not.toContain('groupmode');
    expect(svg).not.toContain('xmlns:inkscape');
  });

  it('rasterises identically to the flat output — same geometry, just grouped', async () => {
    const src = flatArtwork(64, 48);
    const flat = await rasterizeSvg(trace(src, { colors: 8 }).svg, { width: src.width });
    const layered = await rasterizeSvg(trace(src, { colors: 8, groupByColor: true }).svg, { width: src.width });
    expect(compareImages(flat.image, layered.image).lossless).toBe(true);
  });
});

describe('fixed palette', () => {
  it('emits only the supplied colours', () => {
    const palette = [
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 228, g: 0, b: 43, a: 255 },
      { r: 0, g: 0, b: 0, a: 255 },
    ];
    const allowed = new Set(palette.map((c) => shortHex(c.r, c.g, c.b)));
    const svg = trace(photoLike(64, 48), { fixedPalette: palette }).svg;
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(allowed.has(f), `${f} not in palette`).toBe(true);
  });

  it('overrides the auto colour count', () => {
    const one = [{ r: 10, g: 20, b: 30, a: 255 }];
    const svg = trace(photoLike(40, 30), { colors: 32, fixedPalette: one }).svg;
    const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]+)"/g)].map((m) => m[1]));
    expect([...fills]).toEqual(['#0a141e']);
  });
});

describe('toComponent', () => {
  const svg = trace(flatArtwork(40, 30), { colors: 6, groupByColor: true }).svg;

  it('emits a React component with camelCased attrs, props, and no editor namespace', () => {
    const c = toComponent(svg, { framework: 'react', name: 'Logo' });
    expect(c).toContain("import * as React");
    expect(c).toContain('export function Logo(props: React.SVGProps<SVGSVGElement>)');
    expect(c).toContain('<svg {...props}');
    expect(c).toContain('fillRule='); // fill-rule → fillRule
    expect(c).not.toContain('inkscape'); // editor namespace stripped
    expect(c).not.toContain('fill-rule='); // no kebab attrs left in JSX
  });

  it('emits a Svelte component that keeps $$restProps intact', () => {
    const c = toComponent(svg, { framework: 'svelte' });
    expect(c).toContain('{...$$restProps}'); // not mangled to $restProps
    expect(c).toContain('fill-rule='); // Svelte keeps kebab attrs
  });

  it('emits a Vue SFC and a Solid component', () => {
    expect(toComponent(svg, { framework: 'vue', name: 'Logo' })).toContain('<template>');
    expect(toComponent(svg, { framework: 'vue', name: 'Logo' })).toContain('v-bind="$attrs"');
    expect(toComponent(svg, { framework: 'solid', name: 'Logo' })).toContain('solid-js');
  });

  it('maps solid fills to currentColor when asked, leaving gradients alone', () => {
    const grad = trace(photoLike(60, 40), { gradients: true, gradientStepMax: 0.15 }).svg;
    const c = toComponent(grad, { framework: 'react', currentColor: true });
    expect(c).toMatch(/fill="currentColor"/);
    if (grad.includes('url(#')) expect(c).toContain('url(#'); // gradient refs untouched
  });
});

describe('traceSeparations', () => {
  it('returns one self-contained SVG per colour', () => {
    const seps = traceSeparations(flatArtwork(80, 60), { colors: 6 });
    expect(seps.length).toBeGreaterThan(1);
    for (const s of seps) {
      expect(s.svg).toMatch(/^<svg /);
      expect(s.svg.trimEnd()).toMatch(/<\/svg>$/);
      expect(s.color).toMatch(/#[0-9a-f]|background/);
      // A separation carries exactly one colour: no other layer groups inside.
      expect(s.svg).not.toContain('groupmode');
    }
  });

  it('each separation renders on its own', async () => {
    const [first] = traceSeparations(flatArtwork(48, 36), { colors: 4 });
    const { image } = await rasterizeSvg(first.svg, { width: 48 });
    expect(image.width).toBe(48);
  });
});
