/**
 * SVG → framework component codegen.
 *
 * A traced logo or icon is rarely the deliverable — the deliverable is a
 * component you drop into an app. This turns a graver SVG string into a typed,
 * prop-forwarding component for React, Vue, Svelte or Solid, so the pipeline is
 * raster → traced/optimised SVG → component in one pass (SVGR and friends start
 * from an SVG file). Pure string transformation, so it belongs in the portable
 * core.
 */

export type Framework = 'react' | 'vue' | 'svelte' | 'solid';

export interface ComponentOptions {
  /** Target framework. */
  framework: Framework;
  /** Component name (PascalCase recommended). Default `Icon`. */
  name?: string;
  /** Emit TypeScript (typed props). Default true. Ignored by Vue/Svelte SFCs. */
  typescript?: boolean;
  /** Replace solid colour fills with `currentColor` so CSS `color` drives it. */
  currentColor?: boolean;
}

/** Turn a graver SVG string into framework-component source code. */
export function toComponent(svg: string, opts: ComponentOptions): string {
  const name = opts.name ?? 'Icon';
  const jsx = opts.framework === 'react' || opts.framework === 'solid';

  // Strip only *editor*-namespace attributes (Inkscape/Sodipodi) — they are noise
  // and invalid in JSX. Crucially, do NOT strip xlink:href, which carries the
  // base64 payload of an embedded image; an earlier blanket namespace strip
  // silently destroyed embed-mode output.
  let body = svg
    .replace(/^<!--[\s\S]*?-->\n?/, '') // strip the generator comment
    .replace(/\s(?:xmlns:(?:inkscape|sodipodi)|(?:inkscape|sodipodi):[\w-]+)="[^"]*"/gi, '')
    .trim();

  if (opts.currentColor) {
    // Only solid hex fills follow `color`; gradients and `none` stay as they are.
    body = body.replace(/(\s(?:fill|stroke)=)"#[0-9a-fA-F]{3,8}"/g, '$1"currentColor"');
  }

  if (jsx) {
    body = body
      // JSX-supported namespaced attrs become camelCase (xlink:href → xlinkHref).
      .replace(/\s(xlink:[a-z]+|xmlns:xlink)=/gi, (_m, a: string) =>
        ` ${a.replace(/[:-]([a-z])/g, (_x: string, c: string) => c.toUpperCase())}=`)
      // Hyphenated names → camelCase (fill-rule → fillRule), but leave data-*
      // and aria-*, which JSX requires to stay hyphenated.
      .replace(/\s(?!data-|aria-)([a-z]+(?:-[a-z]+)+)=/g, (_m, attr: string) =>
        ` ${attr.replace(/-([a-z])/g, (_x: string, c: string) => c.toUpperCase())}=`);
  }

  switch (opts.framework) {
    case 'react':
      return renderReact(name, injectProps(body, '{...props}'), opts.typescript !== false);
    case 'solid':
      return renderSolid(name, injectProps(body, '{...props}'), opts.typescript !== false);
    case 'vue':
      return renderVue(name, injectProps(body, 'v-bind="$attrs"'));
    case 'svelte':
      return renderSvelte(injectProps(body, '{...$$restProps}'));
  }
}

/** Splice a props expression into the opening `<svg …>` tag. */
function injectProps(svg: string, expr: string): string {
  // A function replacement, so `$$restProps` (Svelte) is not eaten by `String
  // .replace`'s `$` substitution rules.
  return svg.replace(/^<svg\b/, (m) => `${m} ${expr}`);
}

function renderReact(name: string, svg: string, ts: boolean): string {
  const sig = ts
    ? `export function ${name}(props: React.SVGProps<SVGSVGElement>) {`
    : `export function ${name}(props) {`;
  return `import * as React from 'react';\n\n${sig}\n  return (\n    ${svg}\n  );\n}\n`;
}

function renderSolid(name: string, svg: string, ts: boolean): string {
  const imp = ts
    ? `import type { JSX } from 'solid-js';\n\n`
    : '';
  const sig = ts
    ? `export function ${name}(props: JSX.SvgSVGAttributes<SVGSVGElement>) {`
    : `export function ${name}(props) {`;
  return `${imp}${sig}\n  return (\n    ${svg}\n  );\n}\n`;
}

function renderVue(name: string, svg: string): string {
  // `inheritAttrs: false` + v-bind="$attrs" forwards every caller attribute.
  return `<script>\nexport default { name: ${JSON.stringify(name)}, inheritAttrs: false };\n</script>\n\n<template>\n  ${svg}\n</template>\n`;
}

function renderSvelte(svg: string): string {
  return `${svg}\n`;
}
