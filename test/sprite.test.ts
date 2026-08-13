import { describe, expect, it } from 'vitest';
import { svgSprite } from '../src/emit/sprite.js';
import { rasterizeSvg } from '../src/io/rasterize.js';
import { compareImages } from '../src/metrics/index.js';

const HEART =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path fill="#e4002b" d="M12 21 3 12a5 5 0 0 1 9-3 5 5 0 0 1 9 3z"/></svg>';

const STAR =
  '<?xml version="1.0"?>\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
  '<path fill="#f5a623" d="M16 2 20 12 30 12 22 19 25 30 16 23 7 30 10 19 2 12 12 12z"/></svg>';

describe('svgSprite', () => {
  it('packs each source into its own <symbol> with a stable id', () => {
    const sheet = svgSprite([
      { id: 'heart', svg: HEART },
      { id: 'star', svg: STAR },
    ]);
    expect(sheet).toContain('<symbol id="heart"');
    expect(sheet).toContain('<symbol id="star"');
    // Two symbols, one outer svg.
    expect(sheet.match(/<symbol/g)).toHaveLength(2);
    expect(sheet.match(/<svg\b/g)).toHaveLength(1);
  });

  it('carries the viewBox through, deriving it from width/height when absent', () => {
    const sheet = svgSprite([
      { id: 'heart', svg: HEART }, // explicit viewBox 0 0 24 24
      { id: 'star', svg: STAR },   // only width/height 32
    ]);
    expect(sheet).toContain('<symbol id="heart" viewBox="0 0 24 24">');
    expect(sheet).toContain('<symbol id="star" viewBox="0 0 32 32">');
  });

  it('strips the inner <?xml?> prologue but keeps the geometry', () => {
    const sheet = svgSprite([{ id: 'star', svg: STAR }]);
    expect(sheet).not.toContain('<?xml');
    expect(sheet).toContain('<path fill="#f5a623"');
  });

  it('escapes ids so a hostile filename cannot break out of the attribute', () => {
    const sheet = svgSprite([{ id: 'a"><script>', svg: HEART }]);
    expect(sheet).not.toContain('"><script>');
    expect(sheet).toContain('&quot;');
  });

  it('hides the sheet by default and honours hidden:false', () => {
    expect(svgSprite([{ id: 'h', svg: HEART }])).toContain('aria-hidden="true"');
    expect(svgSprite([{ id: 'h', svg: HEART }], { hidden: false })).not.toContain('aria-hidden');
  });

  it('produces a sheet whose <use> reference renders the original icon', async () => {
    const sheet = svgSprite([{ id: 'heart', svg: HEART }], { hidden: false });
    // A document that shows the symbol via <use> must rasterise to the same
    // pixels as the standalone icon — the sprite is render-preserving.
    const viaUse =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
      sheet.replace(/\n$/, '') +
      '<use href="#heart" xlink:href="#heart"/></svg>';
    const direct = await rasterizeSvg(HEART, { width: 48 });
    const used = await rasterizeSvg(viaUse, { width: 48 });
    expect(compareImages(direct.image, used.image).ssim).toBeGreaterThan(0.99);
  });
});
