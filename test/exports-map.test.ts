import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The exports map has to hand each module system its OWN declarations.
 *
 * Every entry used to carry a single top-level `types` pointing into
 * `dist/esm/`, and `dist/esm/package.json` declares `"type": "module"`.
 * TypeScript therefore classified those declarations as ESM and rejected them
 * for any require-emitting file, so a CommonJS project could not import the
 * package at all:
 *
 *   error TS1479: The current file is a CommonJS module whose imports will
 *   produce 'require' calls; however, the referenced file is an ECMAScript
 *   module and cannot be imported with 'require'.
 *
 * The runtime `require('vecline')` worked perfectly the whole time, which is
 * why nothing caught it — the failure was types-only, and the test suite is
 * ESM.
 */

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
};

const dual = Object.entries(pkg.exports).filter(
  ([, v]) => typeof v === 'object' && v !== null && 'require' in (v as object) && 'import' in (v as object),
) as [string, { import: { types?: string; default?: string }; require: { types?: string; default?: string } }][];

describe('exports map', () => {
  it('has entries to check', () => {
    expect(dual.length).toBeGreaterThan(0);
  });

  describe.each(dual)('%s', (_subpath, entry) => {
    it('gives import and require their own types', () => {
      // A bare string condition means the old shape has come back.
      expect(typeof entry.import).toBe('object');
      expect(typeof entry.require).toBe('object');
      expect(entry.import.types).toBeDefined();
      expect(entry.require.types).toBeDefined();
    });

    it('points require at the CommonJS build, not the ESM one', () => {
      // This is the actual defect: require->types resolving into dist/esm is
      // what produces TS1479, because that directory is marked type: module.
      expect(entry.require.types).toMatch(/^\.\/dist\/cjs\//);
      expect(entry.require.default).toMatch(/^\.\/dist\/cjs\//);
      expect(entry.import.types).toMatch(/^\.\/dist\/esm\//);
      expect(entry.import.default).toMatch(/^\.\/dist\/esm\//);
    });

    it('references declaration files that exist', () => {
      for (const t of [entry.import.types!, entry.require.types!]) {
        expect(existsSync(join(ROOT, t)), `${t} is referenced but absent`).toBe(true);
      }
    });
  });

  it('keeps the module-type markers the whole scheme rests on', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'dist/esm/package.json'), 'utf8')).type).toBe('module');
    expect(JSON.parse(readFileSync(join(ROOT, 'dist/cjs/package.json'), 'utf8')).type).toBe('commonjs');
  });
});
