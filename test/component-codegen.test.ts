import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { toComponent } from '../src/emit/component.js';

/**
 * Generated components are parsed here, not substring-matched.
 *
 * The existing coverage asserts with `toContain(...)`, and that is precisely
 * why a whole class of defect survived: a string assertion cannot see a JSX
 * syntax error. `toComponent` would take an Illustrator or Figma SVG, emit TSX
 * that failed to compile, and the CLI would write the file and exit 0.
 *
 * Two of the four failures below *parse* and still break — `class` and a
 * `style` string are valid JSX and invalid React — so parsing alone is not
 * enough either. Both are asserted directly.
 */

/** Parse as TSX and return the syntax diagnostics. */
function parseErrors(code: string): string[] {
  const sf = ts.createSourceFile('Icon.tsx', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  // `parseDiagnostics` is not on the public type but is what actually carries
  // syntax errors for a standalone source file.
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">${inner}</svg>`;

const FIXTURES: [string, string][] = [
  ['a <style> block, as Illustrator and Figma emit', svg('<style>.a{fill:red}</style><path class="a" d="M0 0h8v8H0z"/>')],
  ['a void tag inside foreignObject', svg('<foreignObject><br></foreignObject><path d="M0 0h8v8H0z"/>')],
  ['a class attribute', svg('<path class="icon" d="M0 0h8v8H0z"/>')],
  ['an inline style string', svg('<path style="fill:red;stroke-width:2" d="M0 0h8v8H0z"/>')],
  ['an XML prologue', `<?xml version="1.0"?>${svg('<path d="M0 0h8v8H0z"/>')}`],
  ['a comment', svg('<!-- drawn by hand --><path d="M0 0h8v8H0z"/>')],
  ["vecline's own output", svg('<path d="M0 0h8v8H0z" fill="#f00" fill-rule="evenodd"/>')],
];

describe('component codegen produces code that compiles', () => {
  describe.each(FIXTURES)('%s', (_label, source) => {
    it.each(['react', 'solid'] as const)('parses as TSX for %s', (framework) => {
      const code = toComponent(source, { framework, name: 'Icon', typescript: true });
      expect(parseErrors(code)).toEqual([]);
    });

    it('emits no React-invalid attributes', () => {
      const code = toComponent(source, { framework: 'react', name: 'Icon', typescript: true });
      // Both of these parse fine and then fail at render, which is why the
      // parse check above cannot be the only assertion.
      expect(code).not.toMatch(/\sclass=/);
      expect(code).not.toMatch(/\sstyle="/);
    });
  });

  it('turns a style string into an object with camelCase keys', () => {
    const code = toComponent(svg('<path style="fill:red;stroke-width:2" d="M0 0h8v8H0z"/>'), {
      framework: 'react', name: 'Icon', typescript: true,
    });
    expect(code).toContain("style={{ fill: 'red', strokeWidth: '2' }}");
  });

  it('keeps the CSS in a style block rather than dropping it', () => {
    const code = toComponent(svg('<style>.a{fill:red}</style><path class="a" d="M0 0h8v8H0z"/>'), {
      framework: 'react', name: 'Icon', typescript: true,
    });
    expect(code).toContain('.a{fill:red}');
    expect(code).toContain('className="a"');
  });

  it('closes void tags rather than leaving JSX unbalanced', () => {
    const code = toComponent(svg('<foreignObject><br></foreignObject><path d="M0 0h8v8H0z"/>'), {
      framework: 'react', name: 'Icon', typescript: true,
    });
    expect(code).toMatch(/<br\s*\/>/);
  });
});
