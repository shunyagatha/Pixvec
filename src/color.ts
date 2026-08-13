/**
 * Colour science.
 *
 * Two colour spaces matter here and they do different jobs:
 *
 * - **Oklab** is perceptually uniform and cheap. It is what quantisation and
 *   nearest-colour search use, because Euclidean distance in Oklab is a good
 *   stand-in for "looks different to a human".
 * - **CIELAB + CIEDE2000** is the slow, standards-blessed answer. It is what the
 *   quality report uses, because that is the number people compare across tools.
 *
 * All conversions assume sRGB primaries and a D65 white point.
 */

/** 8-bit sRGB -> linear light, via a 256-entry table (the transfer function is expensive). */
const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbToLinear(c8: number): number {
  return SRGB_TO_LINEAR[c8 & 0xff];
}

export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

// ---------------------------------------------------------------------------
// Oklab (Björn Ottosson, 2020)
// ---------------------------------------------------------------------------

/** Convert 8-bit sRGB to Oklab, writing into `out` to avoid per-pixel allocation. */
export function srgbToOklab(r8: number, g8: number, b8: number, out: Float64Array, off = 0): void {
  const r = SRGB_TO_LINEAR[r8], g = SRGB_TO_LINEAR[g8], b = SRGB_TO_LINEAR[b8];

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);

  out[off] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  out[off + 1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  out[off + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}

/** Inverse of {@link srgbToOklab}; returns clamped 8-bit sRGB. */
export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

// ---------------------------------------------------------------------------
// CIELAB (D65) + CIEDE2000
// ---------------------------------------------------------------------------

const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const LAB_EPS = 216 / 24389; // (6/29)^3
const LAB_KAPPA = 24389 / 27;

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** 8-bit sRGB -> CIELAB (L*, a*, b*), written into `out`. */
export function srgbToLab(r8: number, g8: number, b8: number, out: Float64Array, off = 0): void {
  const r = SRGB_TO_LINEAR[r8], g = SRGB_TO_LINEAR[g8], b = SRGB_TO_LINEAR[b8];

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;

  const fx = labF(x), fy = labF(y), fz = labF(z);

  out[off] = 116 * fy - 16;
  out[off + 1] = 500 * (fx - fy);
  out[off + 2] = 200 * (fy - fz);
}

const DEG = Math.PI / 180;

/**
 * CIEDE2000 colour difference. Reference implementation follows
 * Sharma, Wu & Dalal (2005), including the hue-angle discontinuity fixes.
 */
export function deltaE2000(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number,
): number {
  const kL = 1, kC = 1, kH = 1;

  const C1ab = Math.hypot(a1, b1);
  const C2ab = Math.hypot(a2, b2);
  const CabBar = (C1ab + C2ab) / 2;

  const Cab7 = Math.pow(CabBar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab7 / (Cab7 + 6103515625))); // 25^7 = 6103515625

  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;

  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);

  let hp1 = ap1 === 0 && b1 === 0 ? 0 : Math.atan2(b1, ap1) / DEG;
  if (hp1 < 0) hp1 += 360;
  let hp2 = ap2 === 0 && b2 === 0 ? 0 : Math.atan2(b2, ap2) / DEG;
  if (hp2 < 0) hp2 += 360;

  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;

  let dhp: number;
  if (Cp1 * Cp2 === 0) {
    dhp = 0;
  } else {
    const diff = hp2 - hp1;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * DEG);

  const LpBar = (L1 + L2) / 2;
  const CpBar = (Cp1 + Cp2) / 2;

  let hpBar: number;
  if (Cp1 * Cp2 === 0) {
    hpBar = hp1 + hp2;
  } else {
    const sum = hp1 + hp2;
    const diff = Math.abs(hp1 - hp2);
    if (diff <= 180) hpBar = sum / 2;
    else if (sum < 360) hpBar = (sum + 360) / 2;
    else hpBar = (sum - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hpBar - 30) * DEG) +
    0.24 * Math.cos(2 * hpBar * DEG) +
    0.32 * Math.cos((3 * hpBar + 6) * DEG) -
    0.2 * Math.cos((4 * hpBar - 63) * DEG);

  const dTheta = 30 * Math.exp(-Math.pow((hpBar - 275) / 25, 2));
  const Cp7 = Math.pow(CpBar, 7);
  const Rc = 2 * Math.sqrt(Cp7 / (Cp7 + 6103515625));
  const Rt = -Rc * Math.sin(2 * dTheta * DEG);

  const LpBar50 = Math.pow(LpBar - 50, 2);
  const Sl = 1 + (0.015 * LpBar50) / Math.sqrt(20 + LpBar50);
  const Sc = 1 + 0.045 * CpBar;
  const Sh = 1 + 0.015 * CpBar * T;

  const tL = dLp / (kL * Sl);
  const tC = dCp / (kC * Sc);
  const tH = dHp / (kH * Sh);

  return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
}

/** Rec.709 luma from 8-bit sRGB, kept in 0–255. Used by SSIM. */
export function luma709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `#rrggbb` for an opaque colour. Lower-case, always six digits. */
export function hex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** Collapse `#aabbcc` to `#abc` when the shorthand is exact. */
export function shortHex(r: number, g: number, b: number): string {
  const h = hex(r, g, b);
  if (h[1] === h[2] && h[3] === h[4] && h[5] === h[6]) return `#${h[1]}${h[3]}${h[5]}`;
  return h;
}

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  transparent: [0, 0, 0, 0],
  none: [0, 0, 0, 0],
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  silver: [192, 192, 192, 255],
  magenta: [255, 0, 255, 255],
  cyan: [0, 255, 255, 255],
  yellow: [255, 255, 0, 255],
};

/**
 * Parse the colour syntaxes a command line realistically receives: `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, and a short list of names.
 * Returns null rather than throwing so callers can report the offending text.
 */
export function parseCssColor(input: string): { r: number; g: number; b: number; a: number } | null {
  const s = input.trim().toLowerCase();

  const named = NAMED_COLORS[s];
  if (named) return { r: named[0], g: named[1], b: named[2], a: named[3] };

  if (s.startsWith('#')) {
    const h = s.slice(1);
    const expand = (c: string): number => parseInt(c + c, 16);
    if (h.length === 3 || h.length === 4) {
      if (!/^[0-9a-f]+$/.test(h)) return null;
      return {
        r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) : 255,
      };
    }
    if (h.length === 6 || h.length === 8) {
      if (!/^[0-9a-f]+$/.test(h)) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
      };
    }
    return null;
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (t: string): number => {
      const v = t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t);
      return Math.min(255, Math.max(0, Math.round(v)));
    };
    const alpha = parts[3] === undefined
      ? 255
      : Math.min(255, Math.max(0, Math.round(
          (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) * 255,
        )));
    if (parts.slice(0, 3).some((p) => Number.isNaN(parseFloat(p)))) return null;
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
  }

  return null;
}
