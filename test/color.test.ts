import { describe, expect, it } from 'vitest';
import { deltaE2000, oklabToSrgb, parseCssColor, shortHex, srgbToLab, srgbToOklab } from '../src/color.js';

/**
 * CIEDE2000 is easy to implement almost correctly: the hue-angle arithmetic has
 * three discontinuities, and an implementation that ignores them agrees with the
 * reference on most colours and disagrees badly on a few. Sharma, Wu & Dalal
 * published a test set specifically to catch that, and it is the only honest way
 * to claim the metric is right.
 *
 * Source: G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 Color-Difference
 * Formula", Color Research & Application, 2005 — supplementary test data.
 */
const SHARMA: Array<[number, number, number, number, number, number, number]> = [
  [50.0000, 2.6772, -79.7751, 50.0000, 0.0000, -82.7485, 2.0425],
  [50.0000, 3.1571, -77.2803, 50.0000, 0.0000, -82.7485, 2.8615],
  [50.0000, 2.8361, -74.0200, 50.0000, 0.0000, -82.7485, 3.4412],
  [50.0000, -1.3802, -84.2814, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -1.1848, -84.8006, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -0.9009, -85.5211, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, 0.0000, 0.0000, 50.0000, -1.0000, 2.0000, 2.3669],
  [50.0000, -1.0000, 2.0000, 50.0000, 0.0000, 0.0000, 2.3669],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0009, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0010, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0011, 7.2195],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0012, 7.2195],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0009, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0010, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0011, -2.4900, 4.7461],
  [50.0000, 2.5000, 0.0000, 50.0000, 0.0000, -2.5000, 4.3065],
  [50.0000, 2.5000, 0.0000, 73.0000, 25.0000, -18.0000, 27.1492],
  [50.0000, 2.5000, 0.0000, 61.0000, -5.0000, 29.0000, 22.8977],
  [50.0000, 2.5000, 0.0000, 56.0000, -27.0000, -3.0000, 31.9030],
  [50.0000, 2.5000, 0.0000, 58.0000, 24.0000, 15.0000, 19.4535],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.1736, 0.5854, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2972, 0.0000, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 1.8634, 0.5757, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2592, 0.3350, 1.0000],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
  [36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
];

describe('deltaE2000', () => {
  it.each(SHARMA)(
    'matches the reference for (%f, %f, %f) vs (%f, %f, %f)',
    (l1, a1, b1, l2, a2, b2, expected) => {
      expect(deltaE2000(l1, a1, b1, l2, a2, b2)).toBeCloseTo(expected, 4);
    },
  );

  it('is symmetric', () => {
    for (const [l1, a1, b1, l2, a2, b2] of SHARMA) {
      expect(deltaE2000(l1, a1, b1, l2, a2, b2)).toBeCloseTo(
        deltaE2000(l2, a2, b2, l1, a1, b1),
        10,
      );
    }
  });

  it('is zero for identical colours', () => {
    expect(deltaE2000(50, 10, -20, 50, 10, -20)).toBe(0);
  });
});

describe('CIELAB', () => {
  it('places sRGB white at L*=100 with no chroma', () => {
    const lab = new Float64Array(3);
    srgbToLab(255, 255, 255, lab);
    expect(lab[0]).toBeCloseTo(100, 2);
    expect(lab[1]).toBeCloseTo(0, 2);
    expect(lab[2]).toBeCloseTo(0, 2);
  });

  it('places black at the origin', () => {
    const lab = new Float64Array(3);
    srgbToLab(0, 0, 0, lab);
    expect(lab[0]).toBeCloseTo(0, 6);
  });

  it('gives mid grey a neutral L* near 53.4', () => {
    const lab = new Float64Array(3);
    srgbToLab(128, 128, 128, lab);
    expect(lab[0]).toBeCloseTo(53.585, 1);
    expect(Math.hypot(lab[1], lab[2])).toBeLessThan(0.01);
  });
});

describe('Oklab', () => {
  it('round-trips every 8-bit grey exactly', () => {
    const lab = new Float64Array(3);
    for (let v = 0; v < 256; v++) {
      srgbToOklab(v, v, v, lab);
      expect(oklabToSrgb(lab[0], lab[1], lab[2])).toEqual([v, v, v]);
    }
  });

  it('round-trips saturated primaries exactly', () => {
    const lab = new Float64Array(3);
    for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [17, 119, 221], [200, 150, 90]]) {
      srgbToOklab(r, g, b, lab);
      expect(oklabToSrgb(lab[0], lab[1], lab[2])).toEqual([r, g, b]);
    }
  });

  it('puts white at L≈1 with no chroma', () => {
    const lab = new Float64Array(3);
    srgbToOklab(255, 255, 255, lab);
    expect(lab[0]).toBeCloseTo(1, 3);
    expect(lab[1]).toBeCloseTo(0, 3);
    expect(lab[2]).toBeCloseTo(0, 3);
  });
});

describe('parseCssColor', () => {
  it('parses the hex forms', () => {
    expect(parseCssColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseCssColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseCssColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
    expect(parseCssColor('#F00A')).toEqual({ r: 255, g: 0, b: 0, a: 170 });
  });

  it('parses functional notation', () => {
    expect(parseCssColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 128 });
    expect(parseCssColor('rgb(100% 0% 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('parses names, including transparent', () => {
    expect(parseCssColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('returns null rather than guessing', () => {
    expect(parseCssColor('not-a-colour')).toBeNull();
    expect(parseCssColor('#12345')).toBeNull();
    expect(parseCssColor('#gggggg')).toBeNull();
  });
});

describe('shortHex', () => {
  it('collapses only when the shorthand is exact', () => {
    expect(shortHex(255, 0, 0)).toBe('#f00');
    expect(shortHex(255, 1, 0)).toBe('#ff0100');
    expect(shortHex(17, 34, 51)).toBe('#123');
  });
});
