import { describe, expect, it, beforeAll } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { veclinePlugin } from '../src/plugin/vite.js';
import { flatArtwork, encode } from './fixtures.js';

let png: string;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vecline-vite-'));
  png = join(dir, 'logo.png');
  await writeFile(png, await encode(flatArtwork(64, 48), 'png'));
});

describe('veclinePlugin (Vite/Rollup)', () => {
  const plugin = veclinePlugin();

  it('turns image?svg into a default-exported SVG string', async () => {
    const code = await plugin.load(`${png}?svg`);
    expect(code).toMatch(/^export default "<svg/);
    expect(code).toContain('</svg>');
  });

  it('turns image?component into component source', async () => {
    const code = await veclinePlugin({ framework: 'react' }).load(`${png}?component`);
    expect(code).toContain('export function Icon');
    expect(code).toContain('<svg');
  });

  it('ignores imports without a recognised query', async () => {
    expect(await plugin.load(png)).toBeNull();
    expect(await plugin.load(`${png}?url`)).toBeNull();
  });

  it('ignores non-raster ids', async () => {
    expect(await plugin.load('styles.css?svg')).toBeNull();
    expect(await plugin.load('module.ts')).toBeNull();
  });
});
