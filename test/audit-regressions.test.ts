/**
 * Regressions for two defects found by *executing* the documented surface
 * rather than reading it. Both had shipped, both exited 0, and neither was
 * visible without running the command and looking at the artefact.
 */

import { describe, expect, it } from 'vitest';
import { chooseConvertRoute } from '../src/io/route.js';
import { toComponent } from '../src/emit/component.js';

describe('convert routing', () => {
  it('sends raster → raster to the raster converter, not the rasterizer', () => {
    // The shipped bug: `vecline convert photo.png thumb.webp` routed to the
    // rasterizer, which rejects non-SVG input, so it failed with "does not look
    // like an SVG" — 100 of the advertised 121 matrix cells were unreachable.
    for (const ext of ['.png', '.jpeg', '.webp', '.avif', '.tiff', '.gif', '.bmp', '.ico', '.ppm', '.tga']) {
      expect(chooseConvertRoute(ext, false)).toBe('raster-convert');
    }
  });

  it('still sends SVG → raster to the rasterizer', () => {
    for (const ext of ['.png', '.webp', '.tga']) {
      expect(chooseConvertRoute(ext, true)).toBe('rasterize');
    }
  });

  it('routes by output extension where the output alone decides', () => {
    for (const svgIn of [true, false]) {
      expect(chooseConvertRoute('.svg', svgIn)).toBe('vectorize');
      for (const ext of ['.dxf', '.eps', '.pdf']) {
        expect(chooseConvertRoute(ext, svgIn)).toBe('vector-export');
      }
    }
  });

  it('is case-insensitive about the extension', () => {
    expect(chooseConvertRoute('.SVG', false)).toBe('vectorize');
    expect(chooseConvertRoute('.DXF', false)).toBe('vector-export');
    expect(chooseConvertRoute('.PNG', false)).toBe('raster-convert');
  });
});

describe('toComponent with a real-world SVG file', () => {
  // Illustrator and Inkscape both write a prologue. vecline's own output does
  // not, which is exactly why this went unnoticed: every test fed it traced
  // output, and traced output starts at `<svg`.
  const withPrologue = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- generator noise -->',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
    '  <!-- a note -->',
    '  <path fill="#ff0000" fill-rule="evenodd" d="M2 2h20v20H2z"/>',
    '</svg>',
    '',
  ].join('\n');

  it('forwards props even when the file opens with an XML declaration', () => {
    // The prologue broke the `^<svg` anchor in injectProps, so the spread was
    // silently dropped and the component forwarded nothing.
    const out = toComponent(withPrologue, { framework: 'react' });
    expect(out).toContain('<svg {...props}');
  });

  it('never leaves an XML declaration or DOCTYPE inside a JSX return', () => {
    for (const framework of ['react', 'solid'] as const) {
      const out = toComponent(withPrologue, { framework });
      expect(out).not.toContain('<?xml');
      expect(out).not.toContain('<!DOCTYPE');
    }
  });

  it('converts HTML comments to JSX comments rather than emitting invalid JSX', () => {
    const out = toComponent(withPrologue, { framework: 'react' });
    expect(out).not.toContain('<!--');
    expect(out).toContain('{/* a note */}');
  });

  it('still applies currentColor and camelCases hyphenated attributes', () => {
    const out = toComponent(withPrologue, { framework: 'react', currentColor: true });
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain('fillRule=');
    expect(out).not.toContain('fill-rule=');
  });

  it('handles a DOCTYPE and trailing content', () => {
    const messy = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>\n<!-- trailing -->\n`;
    const out = toComponent(messy, { framework: 'react' });
    expect(out).toContain('<svg {...props}');
    expect(out).not.toContain('<!DOCTYPE');
    expect(out).not.toContain('trailing');
  });

  it('still works on prologue-free input, the case that always passed', () => {
    const clean = '<svg viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>';
    expect(toComponent(clean, { framework: 'react' })).toContain('<svg {...props}');
    expect(toComponent(clean, { framework: 'vue' })).toContain('v-bind="$attrs"');
    expect(toComponent(clean, { framework: 'svelte' })).toContain('{...$$restProps}');
  });

  it('leaves HTML comments alone for Vue and Svelte, where they are valid', () => {
    const out = toComponent(withPrologue, { framework: 'vue' });
    expect(out).toContain('<!-- a note -->');
    expect(out).not.toContain('<?xml');
  });
});
