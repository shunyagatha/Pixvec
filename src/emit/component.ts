/**
 * SVG → framework component codegen.
 *
 * A traced logo or icon is rarely the deliverable — the deliverable is a
 * component you drop into an app. This turns a vecline SVG string into a typed,
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

/** Turn a vecline SVG string into framework-component source code. */
export function toComponent(svg: string, opts: ComponentOptions): string {
  const name = opts.name ?? 'Icon';
  const jsx = opts.framework === 'react' || opts.framework === 'solid';

  // Strip only *editor*-namespace attributes (Inkscape/Sodipodi) — they are noise
  // and invalid in JSX. Crucially, do NOT strip xlink:href, which carries the
  // base64 payload of an embedded image; an earlier blanket namespace strip
  // silently destroyed embed-mode output.
  let body = svg
    .replace(/\s(?:xmlns:(?:inkscape|sodipodi)|(?:inkscape|sodipodi):[\w-]+)="[^"]*"/gi, '')
    .trim();

  // Reduce to exactly the root element: drop an XML declaration, a DOCTYPE, and
  // any leading comments, plus whatever trails `</svg>`.
  //
  // This is load-bearing rather than cosmetic. `injectProps` anchors on `^<svg`,
  // so a file that opened with `<?xml version="1.0"?>` — which is most SVGs
  // written by Illustrator or Inkscape rather than by vecline — failed that
  // anchor and silently skipped the props spread, *and* left the processing
  // instruction sitting inside a JSX `return`. The result compiled nowhere and
  // forwarded nothing, while `component` still exited 0. Tracing a raster hid
  // the bug completely, because vecline's own output has no prologue.
  const rootStart = body.search(/<svg\b/i);
  if (rootStart > 0) body = body.slice(rootStart);
  const rootEnd = body.lastIndexOf('</svg>');
  if (rootEnd !== -1) body = body.slice(0, rootEnd + '</svg>'.length);

  if (opts.currentColor) {
    // Only solid hex fills follow `color`; gradients and `none` stay as they are.
    body = body.replace(/(\s(?:fill|stroke)=)"#[0-9a-fA-F]{3,8}"/g, '$1"currentColor"');
  }

  if (jsx) {
    body = body
      // A `<style>` block's CSS braces are read by JSX as an expression
      // container, so `.a{fill:red}` produced `'}' expected`. Wrapping the text
      // in a template literal hands it to JSX as a string and keeps the rules.
      // Illustrator and Figma both emit these, so it is the common case for any
      // SVG not written by vecline.
      .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs: string, css: string) =>
        `<style${attrs}>{\`${css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`}</style>`)
      // Void HTML tags are legal inside <foreignObject> and illegal in JSX,
      // which demands every element be closed: `<br>` gave "JSX element 'br'
      // has no corresponding closing tag".
      .replace(/<(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)\b([^>]*?)\/?>/gi,
        (_m, tag: string, attrs: string) => `<${tag}${attrs.replace(/\/\s*$/, '')} />`)
      // `class` is a reserved word in JS and React wants `className`. This
      // parses either way, so it is the quieter of the two failures: the
      // component renders with no styling and nothing says why.
      .replace(/\sclass=/g, ' className=')
      // React requires `style` to be an object, not a CSS string. Same silent
      // shape: it parses, then throws at render time.
      .replace(/\sstyle="([^"]*)"/g, (_m, css: string) => {
        const props = css
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const i = d.indexOf(':');
            if (i === -1) return '';
            const key = d.slice(0, i).trim().replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase());
            const value = d.slice(i + 1).trim().replace(/'/g, "\\'");
            return `${key}: '${value}'`;
          })
          .filter(Boolean)
          .join(', ');
        return props ? ` style={{ ${props} }}` : '';
      })
      // `<!-- … -->` is not JSX. Convert rather than delete, so a hand-authored
      // note survives into the generated component instead of vanishing.
      .replace(/<!--([\s\S]*?)-->/g, (_m, text: string) =>
        `{/*${text.replace(/\*\//g, '*\\/')}*/}`)
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
