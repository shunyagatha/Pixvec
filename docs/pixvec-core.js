var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/color.ts
var SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function srgbToLinear(c8) {
  return SRGB_TO_LINEAR[c8 & 255];
}
function linearToSrgb(v) {
  const c = v <= 31308e-7 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}
function srgbToOklab(r8, g8, b8, out, off = 0) {
  const r = SRGB_TO_LINEAR[r8 & 255], g = SRGB_TO_LINEAR[g8 & 255], b = SRGB_TO_LINEAR[b8 & 255];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  out[off] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  out[off + 1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  out[off + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}
function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}
var XN = 0.95047;
var YN = 1;
var ZN = 1.08883;
var LAB_EPS = 216 / 24389;
var LAB_KAPPA = 24389 / 27;
function labF(t) {
  return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}
function srgbToLab(r8, g8, b8, out, off = 0) {
  const r = SRGB_TO_LINEAR[r8], g = SRGB_TO_LINEAR[g8], b = SRGB_TO_LINEAR[b8];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  out[off] = 116 * fy - 16;
  out[off + 1] = 500 * (fx - fy);
  out[off + 2] = 200 * (fy - fz);
}
var DEG = Math.PI / 180;
function deltaE2000(L1, a1, b1, L2, a2, b2) {
  const kL = 1, kC = 1, kH = 1;
  const C1ab = Math.hypot(a1, b1);
  const C2ab = Math.hypot(a2, b2);
  const CabBar = (C1ab + C2ab) / 2;
  const Cab7 = Math.pow(CabBar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab7 / (Cab7 + 6103515625)));
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
  let dhp;
  if (Cp1 * Cp2 === 0) {
    dhp = 0;
  } else {
    const diff = hp2 - hp1;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp / 2 * DEG);
  const LpBar = (L1 + L2) / 2;
  const CpBar = (Cp1 + Cp2) / 2;
  let hpBar;
  if (Cp1 * Cp2 === 0) {
    hpBar = hp1 + hp2;
  } else {
    const sum = hp1 + hp2;
    const diff = Math.abs(hp1 - hp2);
    if (diff <= 180) hpBar = sum / 2;
    else if (sum < 360) hpBar = (sum + 360) / 2;
    else hpBar = (sum - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hpBar - 30) * DEG) + 0.24 * Math.cos(2 * hpBar * DEG) + 0.32 * Math.cos((3 * hpBar + 6) * DEG) - 0.2 * Math.cos((4 * hpBar - 63) * DEG);
  const dTheta = 30 * Math.exp(-Math.pow((hpBar - 275) / 25, 2));
  const Cp7 = Math.pow(CpBar, 7);
  const Rc = 2 * Math.sqrt(Cp7 / (Cp7 + 6103515625));
  const Rt = -Rc * Math.sin(2 * dTheta * DEG);
  const LpBar50 = Math.pow(LpBar - 50, 2);
  const Sl = 1 + 0.015 * LpBar50 / Math.sqrt(20 + LpBar50);
  const Sc = 1 + 0.045 * CpBar;
  const Sh = 1 + 0.015 * CpBar * T;
  const tL = dLp / (kL * Sl);
  const tC = dCp / (kC * Sc);
  const tH = dHp / (kH * Sh);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
}
function luma709(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function hex(r, g, b) {
  return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}
function shortHex(r, g, b) {
  const h = hex(r, g, b);
  if (h[1] === h[2] && h[3] === h[4] && h[5] === h[6]) return `#${h[1]}${h[3]}${h[5]}`;
  return h;
}
var NAMED_COLORS = {
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
  yellow: [255, 255, 0, 255]
};
function parseCssColor(input) {
  const s = input.trim().toLowerCase();
  const named = NAMED_COLORS[s];
  if (named) return { r: named[0], g: named[1], b: named[2], a: named[3] };
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const expand = (c) => parseInt(c + c, 16);
    if (h.length === 3 || h.length === 4) {
      if (!/^[0-9a-f]+$/.test(h)) return null;
      return {
        r: expand(h[0]),
        g: expand(h[1]),
        b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) : 255
      };
    }
    if (h.length === 6 || h.length === 8) {
      if (!/^[0-9a-f]+$/.test(h)) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (t) => {
      const v = t.endsWith("%") ? parseFloat(t) / 100 * 255 : parseFloat(t);
      return Math.min(255, Math.max(0, Math.round(v)));
    };
    const alpha = parts[3] === void 0 ? 255 : Math.min(255, Math.max(0, Math.round(
      (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) * 255
    )));
    if (parts.slice(0, 3).some((p) => Number.isNaN(parseFloat(p)))) return null;
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
  }
  return null;
}

// src/image.ts
function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
function sameSize(a, b) {
  return a.width === b.width && a.height === b.height;
}
function premultiply(img) {
  const n2 = img.width * img.height;
  const src = img.data;
  const out = new Uint8ClampedArray(n2 * 4);
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const a = src[o + 3];
    if (a === 255) {
      out[o] = src[o];
      out[o + 1] = src[o + 1];
      out[o + 2] = src[o + 2];
    } else if (a !== 0) {
      const f = a / 255;
      out[o] = Math.round(src[o] * f);
      out[o + 1] = Math.round(src[o + 1] * f);
      out[o + 2] = Math.round(src[o + 2] * f);
    }
    out[o + 3] = a;
  }
  return out;
}
function compositeOver(img, bg) {
  const n2 = img.width * img.height;
  const src = img.data;
  const out = new Uint8ClampedArray(n2 * 3);
  for (let i = 0; i < n2; i++) {
    const o = i * 4, q = i * 3;
    const a = src[o + 3] / 255;
    const inv = 1 - a;
    out[q] = Math.round(src[o] * a + bg.r * inv);
    out[q + 1] = Math.round(src[o + 1] * a + bg.g * inv);
    out[q + 2] = Math.round(src[o + 2] * a + bg.b * inv);
  }
  return out;
}
function isOpaque(img) {
  const d = img.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 255) return false;
  return true;
}
function packRgba(r, g, b, a) {
  return (r << 24 | g << 16 | b << 8 | a) >>> 0;
}
function unpackRgba(key) {
  return {
    r: key >>> 24 & 255,
    g: key >>> 16 & 255,
    b: key >>> 8 & 255,
    a: key & 255
  };
}
function colorHistogram(img, stopAfter = Infinity) {
  const counts = /* @__PURE__ */ new Map();
  const d = img.data;
  const n2 = img.width * img.height;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const a = d[o + 3];
    const key = a === 0 ? 0 : packRgba(d[o], d[o + 1], d[o + 2], a);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > stopAfter) return { counts, truncated: true };
  }
  return { counts, truncated: false };
}
function subsample(img, maxPixels) {
  const total = img.width * img.height;
  if (total <= maxPixels) return img;
  const scale = Math.sqrt(maxPixels / total);
  const w = Math.max(1, Math.floor(img.width * scale));
  const h = Math.max(1, Math.floor(img.height * scale));
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / w));
      const so = (sy * img.width + sx) * 4;
      const dobj = (y * w + x) * 4;
      out.data[dobj] = img.data[so];
      out.data[dobj + 1] = img.data[so + 1];
      out.data[dobj + 2] = img.data[so + 2];
      out.data[dobj + 3] = img.data[so + 3];
    }
  }
  return out;
}

// src/background.ts
var DEFAULT_TOLERANCE = 0.02;
function detectBackgroundColor(img) {
  const { width, height, data } = img;
  const votes = /* @__PURE__ */ new Map();
  const vote = (x, y) => {
    const o = (y * width + x) * 4;
    const key = data[o + 3] === 0 ? 0 : (data[o] << 24 | data[o + 1] << 16 | data[o + 2] << 8 | data[o + 3]) >>> 0;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    vote(x, 0);
    if (height > 1) vote(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    vote(0, y);
    if (width > 1) vote(width - 1, y);
  }
  let best = 0;
  let bestKey = 0;
  for (const [key, count] of votes) {
    if (count > best) {
      best = count;
      bestKey = key;
    }
  }
  return {
    r: bestKey >>> 24 & 255,
    g: bestKey >>> 16 & 255,
    b: bestKey >>> 8 & 255,
    a: bestKey & 255
  };
}
function removeBackground(img, opts = {}) {
  const { width, height } = img;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const edgesOnly = opts.edgesOnly ?? true;
  const detected = opts.color === void 0;
  const color = opts.color ?? detectBackgroundColor(img);
  const out = {
    width,
    height,
    data: new Uint8ClampedArray(img.data)
  };
  const target = new Float64Array(3);
  srgbToOklab(color.r, color.g, color.b, target);
  const scratch = new Float64Array(3);
  const distanceAt = (index) => {
    const o = index * 4;
    if (img.data[o + 3] === 0) return 0;
    srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], scratch);
    return Math.hypot(scratch[0] - target[0], scratch[1] - target[1], scratch[2] - target[2]);
  };
  const outerBand = opts.feather ? tolerance * 2 : tolerance;
  const alphaFor = (distance) => {
    if (distance <= tolerance) return 0;
    if (!opts.feather || distance >= outerBand) return -1;
    return Math.round(255 * ((distance - tolerance) / (outerBand - tolerance)));
  };
  let removed = 0;
  if (!edgesOnly) {
    for (let i = 0; i < width * height; i++) {
      const alpha = alphaFor(distanceAt(i));
      if (alpha < 0) continue;
      if (alpha < out.data[i * 4 + 3]) {
        out.data[i * 4 + 3] = alpha;
        removed++;
      }
    }
    return { image: out, color, removed, detected };
  }
  const visited = new Uint8Array(width * height);
  const stack = [];
  const consider = (index) => {
    if (visited[index]) return;
    visited[index] = 1;
    const alpha = alphaFor(distanceAt(index));
    if (alpha < 0) return;
    if (alpha < out.data[index * 4 + 3]) {
      out.data[index * 4 + 3] = alpha;
      removed++;
    }
    stack.push(index);
  };
  for (let x = 0; x < width; x++) {
    consider(x);
    if (height > 1) consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    consider(y * width);
    if (width > 1) consider(y * width + width - 1);
  }
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) consider(index - 1);
    if (x < width - 1) consider(index + 1);
    if (y > 0) consider(index - width);
    if (y < height - 1) consider(index + width);
  }
  return { image: out, color, removed, detected };
}

// src/metrics/ssim.ts
var K1 = 0.01;
var K2 = 0.03;
var DYNAMIC_RANGE = 255;
var C1 = (K1 * DYNAMIC_RANGE) ** 2;
var C2 = (K2 * DYNAMIC_RANGE) ** 2;
function gaussianKernel(radius, sigma) {
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}
function blur(src, width, height, kernel, radius, tmp, dst) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0;
        else if (sx >= width) sx = width - 1;
        acc += src[row + sx] * kernel[t + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0;
        else if (sy >= height) sy = height - 1;
        acc += tmp[sy * width + x] * kernel[t + radius];
      }
      dst[y * width + x] = acc;
    }
  }
}
function ssimPlane(x, y, width, height) {
  const minDim = Math.min(width, height);
  if (minDim < 3) {
    let identical = true;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        identical = false;
        break;
      }
    }
    return identical ? 1 : 0;
  }
  let win = 11;
  if (minDim < win) win = minDim % 2 === 0 ? minDim - 1 : minDim;
  const radius = (win - 1) / 2;
  const kernel = gaussianKernel(radius, 1.5);
  const n2 = width * height;
  const xx = new Float64Array(n2);
  const yy = new Float64Array(n2);
  const xy = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    xx[i] = x[i] * x[i];
    yy[i] = y[i] * y[i];
    xy[i] = x[i] * y[i];
  }
  const tmp = new Float64Array(n2);
  const muX = new Float64Array(n2);
  const muY = new Float64Array(n2);
  const sXX = new Float64Array(n2);
  const sYY = new Float64Array(n2);
  const sXY = new Float64Array(n2);
  blur(x, width, height, kernel, radius, tmp, muX);
  blur(y, width, height, kernel, radius, tmp, muY);
  blur(xx, width, height, kernel, radius, tmp, sXX);
  blur(yy, width, height, kernel, radius, tmp, sYY);
  blur(xy, width, height, kernel, radius, tmp, sXY);
  let total = 0;
  let count = 0;
  for (let py = radius; py < height - radius; py++) {
    for (let px = radius; px < width - radius; px++) {
      const i = py * width + px;
      const mx = muX[i], my = muY[i];
      const mx2 = mx * mx, my2 = my * my, mxy = mx * my;
      const vx = sXX[i] - mx2;
      const vy = sYY[i] - my2;
      const vxy = sXY[i] - mxy;
      const num2 = (2 * mxy + C1) * (2 * vxy + C2);
      const den = (mx2 + my2 + C1) * (vx + vy + C2);
      total += num2 / den;
      count++;
    }
  }
  return count > 0 ? total / count : 1;
}

// src/metrics/index.ts
var WHITE = { r: 255, g: 255, b: 255, a: 255 };
function compareImages(reference, candidate, opts = {}) {
  if (!sameSize(reference, candidate)) {
    throw new Error(
      `Cannot compare images of different sizes: ${reference.width}x${reference.height} vs ${candidate.width}x${candidate.height}`
    );
  }
  const alphaMode = opts.alphaMode ?? "premultiplied";
  const bg = opts.deltaEBackground ?? WHITE;
  const a = alphaMode === "premultiplied" ? premultiply(reference) : reference.data;
  const b = alphaMode === "premultiplied" ? premultiply(candidate) : candidate.data;
  const width = reference.width;
  const height = reference.height;
  const pixels = width * height;
  let sqErr = 0;
  let exactPixels = 0;
  let maxChannelDiff = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const d0 = a[o] - b[o];
    const d1 = a[o + 1] - b[o + 1];
    const d2 = a[o + 2] - b[o + 2];
    const d3 = a[o + 3] - b[o + 3];
    sqErr += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
    if (d0 === 0 && d1 === 0 && d2 === 0 && d3 === 0) {
      exactPixels++;
    } else {
      const m = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3));
      if (m > maxChannelDiff) maxChannelDiff = m;
    }
  }
  const mse = sqErr / (pixels * 4);
  const rmse = Math.sqrt(mse);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  const lossless = exactPixels === pixels;
  let ssim = 1;
  let ssimLuma = 1;
  if (!lossless && !opts.skipSsim) {
    const planesA = extractPlanes(a, pixels);
    const planesB = extractPlanes(b, pixels);
    const channelScores = [];
    for (let c = 0; c < 3; c++) {
      channelScores.push(ssimPlane(planesA.rgb[c], planesB.rgb[c], width, height));
    }
    ssim = channelScores.reduce((s, v) => s + v, 0) / channelScores.length;
    ssimLuma = ssimPlane(planesA.luma, planesB.luma, width, height);
  }
  let deltaE = { mean: 0, p95: 0, max: 0 };
  if (!lossless && !opts.skipDeltaE) {
    deltaE = deltaEStats(reference, candidate, bg);
  }
  return {
    width,
    height,
    pixels,
    exactPixels,
    exactRatio: pixels === 0 ? 1 : exactPixels / pixels,
    maxChannelDiff,
    mse,
    rmse,
    psnr,
    ssim,
    ssimLuma,
    deltaE,
    deltaEBackground: bg,
    alphaMode,
    lossless
  };
}
function extractPlanes(rgba, pixels) {
  const r = new Float64Array(pixels);
  const g = new Float64Array(pixels);
  const b = new Float64Array(pixels);
  const luma = new Float64Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    r[i] = rgba[o];
    g[i] = rgba[o + 1];
    b[i] = rgba[o + 2];
    luma[i] = luma709(rgba[o], rgba[o + 1], rgba[o + 2]);
  }
  return { rgb: [r, g, b], luma };
}
function deltaEStats(reference, candidate, bg) {
  const flatA = compositeOver(reference, bg);
  const flatB = compositeOver(candidate, bg);
  const pixels = reference.width * reference.height;
  const BINS = 10001;
  const hist = new Uint32Array(BINS);
  const labA = new Float64Array(3);
  const labB = new Float64Array(3);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 3;
    const ra = flatA[o], ga = flatA[o + 1], ba = flatA[o + 2];
    const rb = flatB[o], gb = flatB[o + 1], bb = flatB[o + 2];
    if (ra === rb && ga === gb && ba === bb) {
      hist[0]++;
      continue;
    }
    srgbToLab(ra, ga, ba, labA);
    srgbToLab(rb, gb, bb, labB);
    const de = deltaE2000(labA[0], labA[1], labA[2], labB[0], labB[1], labB[2]);
    sum += de;
    if (de > max) max = de;
    const bin = Math.min(BINS - 1, Math.round(de * 100));
    hist[bin]++;
  }
  const target = Math.ceil(pixels * 0.95);
  let cumulative = 0;
  let p95 = 0;
  for (let i = 0; i < BINS; i++) {
    cumulative += hist[i];
    if (cumulative >= target) {
      p95 = i / 100;
      break;
    }
  }
  return { mean: pixels === 0 ? 0 : sum / pixels, p95, max };
}

// src/svg/path.ts
function num(value, precision) {
  const f = 10 ** precision;
  let v = Math.round(value * f) / f;
  if (Object.is(v, -0)) v = 0;
  let s = String(v);
  if (s.includes("e")) s = v.toFixed(Math.max(0, precision)).replace(/\.?0+$/, "") || "0";
  if (s.startsWith("0.")) s = s.slice(1);
  else if (s.startsWith("-0.")) s = "-" + s.slice(2);
  return s;
}
function trailingNumberHasDot(chunk) {
  for (let i = chunk.length - 1; i >= 0; i--) {
    const c = chunk[i];
    if (c === ".") return true;
    if (c < "0" || c > "9") return false;
  }
  return false;
}
var PathBuilder = class {
  constructor(precision = 2) {
    this.precision = precision;
    __publicField(this, "out", "");
    __publicField(this, "cx", 0);
    __publicField(this, "cy", 0);
    __publicField(this, "startX", 0);
    __publicField(this, "startY", 0);
    __publicField(this, "lastCommand", "");
  }
  snap(v) {
    const f = 10 ** this.precision;
    return Math.round(v * f) / f;
  }
  /**
   * Emit one command, omitting the letter where implicit repetition allows it
   * and the separator where the grammar makes it unambiguous.
   */
  push(command, args) {
    const repeatable = command !== "M" && command !== "m" && command !== "z";
    let chunk = repeatable && command === this.lastCommand ? "" : command;
    for (const a of args) {
      const s = num(a, this.precision);
      const context = chunk.length > 0 ? chunk : this.out;
      if (context.length > 0) {
        const last = context[context.length - 1];
        if (last >= "0" && last <= "9" || last === ".") {
          if (s[0] !== "-" && !(s[0] === "." && trailingNumberHasDot(context))) {
            chunk += " ";
          }
        }
      }
      chunk += s;
    }
    this.out += chunk;
    this.lastCommand = command;
  }
  moveTo(x, y) {
    const ax = this.snap(x), ay = this.snap(y);
    if (this.out === "") this.push("M", [ax, ay]);
    else this.push("m", [ax - this.cx, ay - this.cy]);
    this.cx = ax;
    this.cy = ay;
    this.startX = ax;
    this.startY = ay;
    return this;
  }
  lineTo(x, y) {
    const ax = this.snap(x), ay = this.snap(y);
    const dx = ax - this.cx, dy = ay - this.cy;
    if (dx === 0 && dy === 0) return this;
    if (dy === 0) this.push("h", [dx]);
    else if (dx === 0) this.push("v", [dy]);
    else this.push("l", [dx, dy]);
    this.cx = ax;
    this.cy = ay;
    return this;
  }
  curveTo(x1, y1, x2, y2, x, y) {
    const a1x = this.snap(x1), a1y = this.snap(y1);
    const a2x = this.snap(x2), a2y = this.snap(y2);
    const ax = this.snap(x), ay = this.snap(y);
    this.push("c", [
      a1x - this.cx,
      a1y - this.cy,
      a2x - this.cx,
      a2y - this.cy,
      ax - this.cx,
      ay - this.cy
    ]);
    this.cx = ax;
    this.cy = ay;
    return this;
  }
  /** Axis-aligned rectangle as a closed subpath — the workhorse of pixel mode. */
  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    return this.close();
  }
  close() {
    this.push("z", []);
    this.cx = this.startX;
    this.cy = this.startY;
    return this;
  }
  get length() {
    return this.out.length;
  }
  isEmpty() {
    return this.out.length === 0;
  }
  toString() {
    return this.out;
  }
};

// src/svg/build.ts
var SvgDoc = class {
  constructor(opts) {
    this.opts = opts;
    __publicField(this, "children", []);
    __publicField(this, "defs", []);
    __publicField(this, "idSeq", 0);
    __publicField(this, "inkscapeNs", false);
  }
  add(markup) {
    this.children.push(markup);
    return this;
  }
  /**
   * Wrap markup in a named `<g>` that Inkscape and Illustrator recognise as an
   * editable **layer**, so a traced document opens as organised colour layers
   * rather than one flattened blob. Using this once declares the `inkscape`
   * namespace on the root; a document that never calls it is unchanged.
   */
  addLayer(label, id, markup) {
    this.inkscapeNs = true;
    return this.add(
      `<g inkscape:groupmode="layer" inkscape:label="${escapeAttr(label)}" id="${escapeAttr(id)}">${markup}</g>`
    );
  }
  /**
   * Register a `<defs>` entry — a gradient, a pattern — emitted once at the top
   * of the document and referenced by id from a `fill`. No `<defs>` element is
   * written unless something is added here, so a gradient-free document is
   * byte-for-byte what it was before.
   */
  addDef(markup) {
    this.defs.push(markup);
    return this;
  }
  /** A document-unique id for a def, so two gradients never collide. */
  nextId(prefix = "g") {
    return `${prefix}${this.idSeq++}`;
  }
  /** A full-canvas background rectangle. Cheaper than repeating the same fill. */
  addBackground(color) {
    const { width, height } = this.opts;
    return this.add(
      `<path d="M0 0h${width}v${height}H0z"${fillAttrs(color)}/>`
    );
  }
  toString() {
    const { width, height, generator, shapeRendering, emitDimensions = true, title } = this.opts;
    const attrs = [
      'xmlns="http://www.w3.org/2000/svg"',
      `viewBox="0 0 ${width} ${height}"`
    ];
    if (this.inkscapeNs) {
      attrs.push('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    }
    if (emitDimensions) {
      attrs.splice(1, 0, `width="${width}"`, `height="${height}"`);
    }
    if (shapeRendering && shapeRendering !== "auto") {
      attrs.push(`shape-rendering="${shapeRendering}"`);
    }
    const head = generator ? `<!-- ${escapeComment(generator)} -->
` : "";
    const titleEl = title ? `<title>${escapeText(title)}</title>` : "";
    const defsEl = this.defs.length ? `<defs>${this.defs.join("")}</defs>` : "";
    return `${head}<svg ${attrs.join(" ")}>${titleEl}${defsEl}${this.children.join("")}</svg>
`;
  }
  get childCount() {
    return this.children.length;
  }
};
function fillAttrs(c) {
  const fill = ` fill="${shortHex(c.r, c.g, c.b)}"`;
  if (c.a >= 255) return fill;
  const o = (c.a / 255).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${fill} fill-opacity="${o.startsWith("0.") ? o.slice(1) : o}"`;
}
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, "&quot;");
}
function escapeComment(s) {
  return s.replace(/--+/g, "-").replace(/-$/, "");
}

// src/svg/optimize.ts
function optimizeSvg(svg, opts = {}) {
  const precision = opts.precision ?? 2;
  const scale = 10 ** precision;
  const stripProlog = opts.stripProlog !== false;
  let out = svg;
  if (stripProlog) {
    out = out.replace(/<\?xml[\s\S]*?\?>\s*/gi, "").replace(/<!DOCTYPE[^>]*>\s*/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  }
  out = out.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").replace(/-?\d*\.\d+(?:e-?\d+)?/gi, (m) => {
    const n2 = Math.round(parseFloat(m) * scale) / scale;
    return Number.isFinite(n2) ? String(n2) : m;
  }).replace(/\s(?:fill|stroke)-opacity="1"/g, "").replace(/\sfill-rule="nonzero"/g, "").trim();
  return out;
}

// src/vectorize/pixel.ts
var DEFAULT_MAX_RECTS = 4e6;
function vectorizePixels(img, opts = {}) {
  const { width, height, data } = img;
  const maxRects = opts.maxRects ?? DEFAULT_MAX_RECTS;
  const n2 = width * height;
  const keys = new Uint32Array(n2);
  let opaque = true;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) {
      keys[i] = 0;
      opaque = false;
    } else {
      if (a !== 255) opaque = false;
      keys[i] = packRgba(data[o], data[o + 1], data[o + 2], a);
    }
  }
  const byColor = /* @__PURE__ */ new Map();
  const counts = /* @__PURE__ */ new Map();
  const visited = new Uint8Array(n2);
  let rectTotal = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (visited[i]) continue;
      const key = keys[i];
      if (key === 0) continue;
      let w = 1;
      while (x + w < width && !visited[i + w] && keys[i + w] === key) w++;
      let h = 1;
      outer: while (y + h < height) {
        const probe = i + h * width;
        for (let t = 0; t < w; t++) {
          if (visited[probe + t] || keys[probe + t] !== key) break outer;
        }
        h++;
      }
      for (let dy = 0; dy < h; dy++) {
        const start = i + dy * width;
        visited.fill(1, start, start + w);
      }
      let list = byColor.get(key);
      if (!list) {
        list = [];
        byColor.set(key, list);
      }
      list.push(x, y, w, h);
      counts.set(key, (counts.get(key) ?? 0) + w * h);
      if (++rectTotal > maxRects) {
        throw new Error(
          `Pixel-exact vectorisation would need more than ${maxRects.toLocaleString()} rectangles. This input is photographic; use --mode embed for a lossless result or --mode trace for real curves.`
        );
      }
    }
  }
  let backgroundKey = 0;
  if (opts.background !== false && opaque && counts.size > 1) {
    let best = 0;
    for (const [key, count] of counts) {
      if (count > best) {
        best = count;
        backgroundKey = key;
      }
    }
  }
  const doc = new SvgDoc({
    width,
    height,
    generator: opts.generator,
    title: opts.title,
    shapeRendering: opts.crispEdges === false ? "auto" : "crispEdges"
  });
  if (backgroundKey !== 0) doc.addBackground(unpackRgba(backgroundKey));
  const ordered = [...byColor.keys()].filter((k) => k !== backgroundKey).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a - b);
  for (const key of ordered) {
    const rects = byColor.get(key);
    const path = new PathBuilder(0);
    for (let i = 0; i < rects.length; i += 4) {
      path.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
    }
    doc.add(`<path d="${path.toString()}"${fillAttrs(unpackRgba(key))}/>`);
  }
  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: byColor.size,
    rects: rectTotal
  };
}
function countDistinctColors(img, cap) {
  const seen = /* @__PURE__ */ new Set();
  const d = img.data;
  const n2 = img.width * img.height;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const a = d[o + 3];
    seen.add(a === 0 ? 0 : packRgba(d[o], d[o + 1], d[o + 2], a));
    if (seen.size > cap) return { count: seen.size, capped: true };
  }
  return { count: seen.size, capped: false };
}
function dominantColor(img) {
  const counts = /* @__PURE__ */ new Map();
  const d = img.data;
  const n2 = img.width * img.height;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const key = packRgba(d[o], d[o + 1], d[o + 2], d[o + 3]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestKey = packRgba(255, 255, 255, 255);
  for (const [key, count] of counts) {
    if (count > best) {
      best = count;
      bestKey = key;
    }
  }
  return unpackRgba(bestKey);
}

// src/vectorize/components.ts
var UnionFind = class {
  constructor(capacity) {
    __publicField(this, "parent");
    __publicField(this, "size", 0);
    this.parent = new Int32Array(Math.max(16, capacity));
  }
  make() {
    if (this.size === this.parent.length) {
      const grown = new Int32Array(this.parent.length * 2);
      grown.set(this.parent);
      this.parent = grown;
    }
    const id = this.size++;
    this.parent[id] = id;
    return id;
  }
  find(x) {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent[hi] = lo;
    return lo;
  }
  get length() {
    return this.size;
  }
};
function connectedComponents(classes, width, height, voidClass = -1) {
  const n2 = width * height;
  const provisional = new Int32Array(n2).fill(-1);
  const uf = new UnionFind(Math.max(16, Math.ceil(n2 / 4)));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const cls = classes[i];
      if (cls === voidClass) continue;
      const left = x > 0 && classes[i - 1] === cls ? provisional[i - 1] : -1;
      const up = y > 0 && classes[i - width] === cls ? provisional[i - width] : -1;
      if (left === -1 && up === -1) {
        provisional[i] = uf.make();
      } else if (left === -1) {
        provisional[i] = up;
      } else if (up === -1) {
        provisional[i] = left;
      } else {
        provisional[i] = uf.union(left, up);
      }
    }
  }
  const remap = new Int32Array(uf.length).fill(-1);
  const labels = new Int32Array(n2).fill(-1);
  let count = 0;
  for (let i = 0; i < n2; i++) {
    const p = provisional[i];
    if (p === -1) continue;
    const root = uf.find(p);
    let dense = remap[root];
    if (dense === -1) {
      dense = count++;
      remap[root] = dense;
    }
    labels[i] = dense;
  }
  const areas = new Int32Array(count);
  const componentClasses = new Int32Array(count).fill(-1);
  const bounds = new Int32Array(count * 4);
  for (let c = 0; c < count; c++) {
    bounds[c * 4] = Number.MAX_SAFE_INTEGER;
    bounds[c * 4 + 1] = Number.MAX_SAFE_INTEGER;
    bounds[c * 4 + 2] = -1;
    bounds[c * 4 + 3] = -1;
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      areas[c]++;
      if (componentClasses[c] === -1) componentClasses[c] = classes[row + x];
      const b = c * 4;
      if (x < bounds[b]) bounds[b] = x;
      if (y < bounds[b + 1]) bounds[b + 1] = y;
      if (x > bounds[b + 2]) bounds[b + 2] = x;
      if (y > bounds[b + 3]) bounds[b + 3] = y;
    }
  }
  return { labels, count, areas, classes: componentClasses, bounds };
}
function despeckle(classes, comps, width, height, minArea, voidClass = -1) {
  if (minArea <= 1) return 0;
  const small = [];
  for (let c = 0; c < comps.count; c++) {
    if (comps.areas[c] < minArea) small.push(c);
  }
  if (small.length === 0) return 0;
  small.sort((a, b) => comps.areas[a] - comps.areas[b]);
  const isSmall = new Uint8Array(comps.count);
  for (const c of small) isSmall[c] = 1;
  const borderTally = /* @__PURE__ */ new Map();
  let merged = 0;
  for (const c of small) {
    borderTally.clear();
    const b = c * 4;
    const x0 = comps.bounds[b], y0 = comps.bounds[b + 1];
    const x1 = comps.bounds[b + 2], y1 = comps.bounds[b + 3];
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        if (comps.labels[row + x] !== c) continue;
        tally(borderTally, comps, classes, row + x - 1, x > 0, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x + 1, x < width - 1, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x - width, y > 0, c, isSmall, voidClass);
        tally(borderTally, comps, classes, row + x + width, y < height - 1, c, isSmall, voidClass);
      }
    }
    let bestClass = -2;
    let bestLen = 0;
    for (const [cls, len] of borderTally) {
      if (len > bestLen) {
        bestLen = len;
        bestClass = cls;
      }
    }
    if (bestClass === -2) continue;
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        if (comps.labels[row + x] === c) classes[row + x] = bestClass;
      }
    }
    isSmall[c] = 0;
    merged++;
  }
  return merged;
}
function tally(out, comps, classes, idx, inBounds, self, isSmall, voidClass) {
  if (!inBounds) return;
  const other = comps.labels[idx];
  if (other === self) return;
  if (other !== -1 && isSmall[other]) return;
  const cls = other === -1 ? voidClass : classes[idx];
  out.set(cls, (out.get(cls) ?? 0) + 1);
}

// src/vectorize/contour.ts
function traceComponents(labels, width, height, componentCount, turnPolicy = "left") {
  const VW = width + 1;
  const vertexCount = VW * (height + 1);
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      if (y === 0 || labels[row + x - width] !== c) edgeCount++;
      if (x === width - 1 || labels[row + x + 1] !== c) edgeCount++;
      if (y === height - 1 || labels[row + x + width] !== c) edgeCount++;
      if (x === 0 || labels[row + x - 1] !== c) edgeCount++;
    }
  }
  const edgeFrom = new Int32Array(edgeCount);
  const edgeTo = new Int32Array(edgeCount);
  const edgeComp = new Int32Array(edgeCount);
  const edgeNext = new Int32Array(edgeCount);
  const used = new Uint8Array(edgeCount);
  const head = new Int32Array(vertexCount).fill(-1);
  let e = 0;
  const emit2 = (from, to, comp) => {
    edgeFrom[e] = from;
    edgeTo[e] = to;
    edgeComp[e] = comp;
    edgeNext[e] = head[from];
    head[from] = e;
    e++;
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const c = labels[row + x];
      if (c === -1) continue;
      const tl = y * VW + x;
      const tr = tl + 1;
      const bl = (y + 1) * VW + x;
      const br = bl + 1;
      if (y === 0 || labels[row + x - width] !== c) emit2(tl, tr, c);
      if (x === width - 1 || labels[row + x + 1] !== c) emit2(tr, br, c);
      if (y === height - 1 || labels[row + x + width] !== c) emit2(br, bl, c);
      if (x === 0 || labels[row + x - 1] !== c) emit2(bl, tl, c);
    }
  }
  const result = Array.from({ length: componentCount }, () => []);
  for (let start = 0; start < edgeCount; start++) {
    if (used[start]) continue;
    const loop = walkLoop(
      start,
      edgeComp[start],
      edgeFrom,
      edgeTo,
      edgeComp,
      edgeNext,
      head,
      used,
      VW,
      width,
      height,
      labels,
      turnPolicy
    );
    if (loop) result[edgeComp[start]].push(loop);
  }
  return result;
}
function walkLoop(startEdge, comp, edgeFrom, edgeTo, edgeComp, edgeNext, head, used, VW, width, height, labels, turnPolicy) {
  const xs = [];
  const ys = [];
  let current = startEdge;
  let dx = 0;
  let dy = 0;
  for (; ; ) {
    used[current] = 1;
    const from = edgeFrom[current];
    const to = edgeTo[current];
    const fx = from % VW, fy = (from - fx) / VW;
    const tx = to % VW, ty = (to - tx) / VW;
    xs.push(fx);
    ys.push(fy);
    dx = tx - fx;
    dy = ty - fy;
    const next = pickNext(
      to,
      dx,
      dy,
      comp,
      edgeTo,
      edgeComp,
      edgeNext,
      head,
      used,
      VW,
      width,
      height,
      labels,
      turnPolicy
    );
    if (next === -1) break;
    current = next;
  }
  if (xs.length < 3) return null;
  const kx = [];
  const ky = [];
  const n2 = xs.length;
  for (let i = 0; i < n2; i++) {
    const p = (i - 1 + n2) % n2;
    const q = (i + 1) % n2;
    const ax = xs[i] - xs[p], ay = ys[i] - ys[p];
    const bx = xs[q] - xs[i], by = ys[q] - ys[i];
    if (ax * by - ay * bx !== 0) {
      kx.push(xs[i]);
      ky.push(ys[i]);
    }
  }
  if (kx.length < 3) return null;
  const pts = new Int32Array(kx.length * 2);
  let area2 = 0;
  for (let i = 0; i < kx.length; i++) {
    pts[i * 2] = kx[i];
    pts[i * 2 + 1] = ky[i];
    const j = (i + 1) % kx.length;
    area2 += kx[i] * ky[j] - kx[j] * ky[i];
  }
  return { pts, signedArea: area2 / 2 };
}
function pickNext(vertex, dx, dy, comp, edgeTo, edgeComp, edgeNext, head, used, VW, width, height, labels, turnPolicy) {
  const vx = vertex % VW;
  const vy = (vertex - vx) / VW;
  const dirs = [
    [-dy, dx],
    // 0 clockwise  (cut: arms stay separate)
    [dx, dy],
    // 1 straight
    [dy, -dx],
    // 2 counter-clockwise (hug: arms join)
    [-dx, -dy]
    // 3 reverse
  ];
  const edges = [-1, -1, -1, -1];
  for (let d = 0; d < 4; d++) {
    const nx = vx + dirs[d][0];
    const ny = vy + dirs[d][1];
    if (nx < 0 || nx > width || ny < 0 || ny > height) continue;
    const target = ny * VW + nx;
    for (let g = head[vertex]; g !== -1; g = edgeNext[g]) {
      if (!used[g] && edgeComp[g] === comp && edgeTo[g] === target) {
        edges[d] = g;
        break;
      }
    }
  }
  const clockwise = edges[0];
  const ccw = edges[2];
  if (clockwise !== -1 && ccw !== -1) {
    return shouldHug(turnPolicy, vx, vy, comp, labels, width, height) ? ccw : clockwise;
  }
  for (let d = 0; d < 4; d++) if (edges[d] !== -1) return edges[d];
  return -1;
}
function shouldHug(policy, vx, vy, comp, labels, width, height) {
  switch (policy) {
    case "right":
    case "black":
      return true;
    case "left":
    case "white":
      return false;
    case "majority":
      return componentIsLocalMajority(vx, vy, comp, labels, width, height);
    case "minority":
      return !componentIsLocalMajority(vx, vy, comp, labels, width, height);
  }
}
function componentIsLocalMajority(vx, vy, comp, labels, width, height) {
  const isComp = (px, py) => px >= 0 && px < width && py >= 0 && py < height && labels[py * width + px] === comp ? 1 : -1;
  for (let i = 2; i < 5; i++) {
    let ct = 0;
    for (let a = -i + 1; a <= i - 1; a++) {
      ct += isComp(vx + a, vy + i - 1);
      ct += isComp(vx + i - 1, vy + a - 1);
      ct += isComp(vx + a - 1, vy - i);
      ct += isComp(vx - i, vy + a);
    }
    if (ct > 0) return true;
    if (ct < 0) return false;
  }
  return false;
}

// src/vectorize/exact.ts
var DEFAULT_MAX_REGIONS = 2e5;
function vectorizeExact(img, opts = {}) {
  const rects = vectorizePixels(img, opts);
  const contours = tryContours(img, opts);
  if (!contours || contours.svg.length >= rects.svg.length) {
    return {
      svg: rects.svg,
      shapes: rects.shapes,
      colors: rects.colors,
      strategy: "rectangles",
      sizes: { rectangles: rects.svg.length, contours: contours?.svg.length }
    };
  }
  return {
    svg: contours.svg,
    shapes: contours.shapes,
    colors: contours.colors,
    strategy: "contours",
    sizes: { rectangles: rects.svg.length, contours: contours.svg.length }
  };
}
function tryContours(img, opts) {
  try {
    return vectorizeExactContours(img, opts);
  } catch {
    return null;
  }
}
function vectorizeExactContours(img, opts = {}) {
  const { width, height, data } = img;
  const n2 = width * height;
  const maxRegions = opts.maxRegions ?? DEFAULT_MAX_REGIONS;
  const classOf = /* @__PURE__ */ new Map();
  const classes = new Int32Array(n2);
  const colors = [];
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) {
      classes[i] = -1;
      continue;
    }
    const key = packRgba(data[o], data[o + 1], data[o + 2], a);
    let cls = classOf.get(key);
    if (cls === void 0) {
      cls = colors.length;
      classOf.set(key, cls);
      colors.push(unpackRgba(key));
    }
    classes[i] = cls;
  }
  const comps = connectedComponents(classes, width, height, -1);
  if (comps.count > maxRegions) {
    throw new Error(
      `Exact contours would need ${comps.count.toLocaleString()} regions, over the ${maxRegions.toLocaleString()} budget. This input is photographic.`
    );
  }
  const loops = traceComponents(comps.labels, width, height, comps.count);
  const areaByClass = /* @__PURE__ */ new Map();
  const componentsByClass = /* @__PURE__ */ new Map();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    areaByClass.set(cls, (areaByClass.get(cls) ?? 0) + comps.areas[c]);
    let list = componentsByClass.get(cls);
    if (!list) {
      list = [];
      componentsByClass.set(cls, list);
    }
    list.push(c);
  }
  const ordered = [...areaByClass.keys()].sort(
    (a, b) => (areaByClass.get(b) ?? 0) - (areaByClass.get(a) ?? 0) || a - b
  );
  const doc = new SvgDoc({
    width,
    height,
    generator: opts.generator,
    title: opts.title,
    // Integer geometry renders identically either way, but disabling
    // antialiasing removes any dependence on the renderer's edge rules.
    shapeRendering: opts.crispEdges === false ? "auto" : "crispEdges"
  });
  const hasVoid = classes.includes(-1);
  const backgroundClass = opts.background !== false && !hasVoid && ordered.length > 1 ? ordered[0] : -1;
  if (backgroundClass >= 0) doc.addBackground(colors[backgroundClass]);
  for (const cls of ordered) {
    if (cls === backgroundClass) continue;
    const path = new PathBuilder(0);
    for (const c of componentsByClass.get(cls)) {
      for (const loop of loops[c]) {
        const pts = loop.pts;
        path.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
        path.close();
      }
    }
    if (path.isEmpty()) continue;
    doc.add(`<path fill-rule="evenodd" d="${path.toString()}"${fillAttrs(colors[cls])}/>`);
  }
  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: areaByClass.size,
    regions: comps.count
  };
}

// src/preprocess.ts
var DEFAULT_DELTA = 20;
function gaussianKernel2(radius) {
  const sigma = radius / 3 || 1;
  const size = radius * 2 + 1;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}
function selectiveBlur(img, opts) {
  const radius = Math.min(5, Math.floor(opts.radius));
  const delta = opts.delta ?? DEFAULT_DELTA;
  const { width, height, data } = img;
  if (radius < 1) return { width, height, data: new Uint8ClampedArray(data) };
  const kernel = gaussianKernel2(radius);
  const n2 = width * height;
  const tmp = new Float64Array(n2 * 4);
  const blurred = new Float64Array(n2 * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0;
        else if (sx >= width) sx = width - 1;
        const o = (row + sx) * 4;
        const w = kernel[t + radius];
        r += data[o] * w;
        g += data[o + 1] * w;
        b += data[o + 2] * w;
        a += data[o + 3] * w;
      }
      const d = (row + x) * 4;
      tmp[d] = r;
      tmp[d + 1] = g;
      tmp[d + 2] = b;
      tmp[d + 3] = a;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = -radius; t <= radius; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0;
        else if (sy >= height) sy = height - 1;
        const o = (sy * width + x) * 4;
        const w = kernel[t + radius];
        r += tmp[o] * w;
        g += tmp[o + 1] * w;
        b += tmp[o + 2] * w;
        a += tmp[o + 3] * w;
      }
      const d = (y * width + x) * 4;
      blurred[d] = r;
      blurred[d + 1] = g;
      blurred[d + 2] = b;
      blurred[d + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(n2 * 4);
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const dr = Math.abs(blurred[o] - data[o]);
    const dg = Math.abs(blurred[o + 1] - data[o + 1]);
    const db = Math.abs(blurred[o + 2] - data[o + 2]);
    const da = Math.abs(blurred[o + 3] - data[o + 3]);
    if (dr > delta || dg > delta || db > delta || da > delta) {
      out[o] = data[o];
      out[o + 1] = data[o + 1];
      out[o + 2] = data[o + 2];
      out[o + 3] = data[o + 3];
    } else {
      out[o] = Math.round(blurred[o]);
      out[o + 1] = Math.round(blurred[o + 1]);
      out[o + 2] = Math.round(blurred[o + 2]);
      out[o + 3] = Math.round(blurred[o + 3]);
    }
  }
  return { width, height, data: out };
}

// src/vectorize/fit.ts
var MAX_NEWTON_ITERATIONS = 6;
var COLLINEAR_EPSILON = 0.05;
var MAX_HANDLE_RATIO = 1;
var NEWTON_BAND = 4;
var TANGENT_WINDOW = 4;
var MAX_OPTIMIZE_PASSES = 8;
function fitLoop(pts, opts) {
  const n2 = pts.length / 2;
  if (n2 < 3) return null;
  const px = new Float64Array(n2);
  const py = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    px[i] = pts[i * 2];
    py[i] = pts[i * 2 + 1];
  }
  let tolerance = opts.tolerance;
  let anchors = simplifyClosed(px, py, n2, tolerance);
  while (anchors.length < 3 && tolerance > 0) {
    tolerance = tolerance > 0.05 ? tolerance / 2 : 0;
    anchors = simplifyClosed(px, py, n2, tolerance);
  }
  if (anchors.length < 3) return null;
  const forcedCorners = opts.rightAngleEnhance ? enhanceRightAngles(px, py, anchors, opts.rightAngleThreshold ?? 12) : void 0;
  if (opts.polygonOnly) {
    const segments2 = [];
    for (let i = 1; i < anchors.length; i++) {
      segments2.push({ kind: "line", x: px[anchors[i]], y: py[anchors[i]] });
    }
    segments2.push({ kind: "line", x: px[anchors[0]], y: py[anchors[0]] });
    return { start: { x: px[anchors[0]], y: py[anchors[0]] }, segments: segments2 };
  }
  const breaks = findBreakpoints(px, py, n2, anchors, opts.cornerAngle, forcedCorners);
  const segments = [];
  for (let b = 0; b < breaks.length; b++) {
    const startIdx = breaks[b].index;
    const endIdx = breaks[(b + 1) % breaks.length].index;
    const chain = extractChain(px, py, n2, startIdx, endIdx);
    if (chain.x.length < 2) continue;
    const t1 = breaks[b].corner ? leftTangent(chain.x, chain.y, 0) : centerTangentAt(px, py, n2, startIdx);
    const t2 = breaks[(b + 1) % breaks.length].corner ? rightTangent(chain.x, chain.y, chain.x.length - 1) : negate(centerTangentAt(px, py, n2, endIdx));
    const fitted = [];
    fitCubic(chain.x, chain.y, 0, chain.x.length - 1, t1, t2, opts.fitError, fitted);
    const optimized = opts.optimize === false ? fitted : optimizeCurves(chain.x, chain.y, fitted, opts.optimizeError ?? opts.fitError);
    for (const f of optimized) segments.push(f.segment);
  }
  if (segments.length === 0) return null;
  return { start: { x: px[breaks[0].index], y: py[breaks[0].index] }, segments };
}
function simplifyClosed(px, py, n2, tolerance) {
  if (n2 <= 3 || tolerance <= 0) return Array.from({ length: n2 }, (_, i) => i);
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < n2; i++) {
    const d = (px[i] - px[0]) ** 2 + (py[i] - py[0]) ** 2;
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  if (far === 0) return Array.from({ length: n2 }, (_, i) => i);
  const first = [];
  douglasPeucker(px, py, 0, far, tolerance, first, (i) => i);
  const second = [];
  const wrapLength = n2 - far;
  douglasPeucker(
    px,
    py,
    0,
    wrapLength,
    tolerance,
    second,
    (i) => (far + i) % n2
  );
  const out = [0, ...first, far, ...second.filter((i) => i !== 0 && i !== far)];
  return dedupeOrdered(out, n2);
}
function douglasPeucker(px, py, first, last, tolerance, out, map) {
  if (last <= first + 1) return;
  const ax = px[map(first)], ay = py[map(first)];
  const bx = px[map(last)], by = py[map(last)];
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let worst = -1;
  let worstDist = tolerance;
  for (let i = first + 1; i < last; i++) {
    const cx = px[map(i)], cy = py[map(i)];
    let dist;
    if (lenSq === 0) {
      dist = Math.hypot(cx - ax, cy - ay);
    } else {
      dist = Math.abs(dy * cx - dx * cy + bx * ay - by * ax) / Math.sqrt(lenSq);
    }
    if (dist > worstDist) {
      worstDist = dist;
      worst = i;
    }
  }
  if (worst === -1) return;
  douglasPeucker(px, py, first, worst, tolerance, out, map);
  out.push(map(worst));
  douglasPeucker(px, py, worst, last, tolerance, out, map);
}
function dedupeOrdered(indices, n2) {
  const seen = new Uint8Array(n2);
  const out = [];
  for (const i of indices) {
    if (!seen[i]) {
      seen[i] = 1;
      out.push(i);
    }
  }
  return out;
}
function enhanceRightAngles(px, py, anchors, thresholdDeg) {
  const forced = /* @__PURE__ */ new Set();
  const m = anchors.length;
  if (m < 3) return forced;
  const slack = Math.sin(Math.max(0, thresholdDeg) * (Math.PI / 180));
  for (let i = 0; i < m; i++) {
    const prev = anchors[(i - 1 + m) % m];
    const cur = anchors[i];
    const next = anchors[(i + 1) % m];
    const inDx = px[cur] - px[prev], inDy = py[cur] - py[prev];
    const outDx = px[next] - px[cur], outDy = py[next] - py[cur];
    const inLen = Math.hypot(inDx, inDy), outLen = Math.hypot(outDx, outDy);
    if (inLen === 0 || outLen === 0) continue;
    if (Math.abs((inDx * outDx + inDy * outDy) / (inLen * outLen)) > slack) continue;
    const inHoriz = Math.abs(inDy) / inLen <= slack;
    const inVert = Math.abs(inDx) / inLen <= slack;
    const outHoriz = Math.abs(outDy) / outLen <= slack;
    const outVert = Math.abs(outDx) / outLen <= slack;
    if (inHoriz && outVert) {
      py[cur] = py[prev];
      px[cur] = px[next];
      forced.add(cur);
    } else if (inVert && outHoriz) {
      px[cur] = px[prev];
      py[cur] = py[next];
      forced.add(cur);
    }
  }
  return forced;
}
function findBreakpoints(px, py, n2, anchors, cornerAngleDeg, forced) {
  const threshold = Math.cos(cornerAngleDeg * (Math.PI / 180));
  const corners = [];
  const m = anchors.length;
  for (let i = 0; i < m; i++) {
    const prev = anchors[(i - 1 + m) % m];
    const cur = anchors[i];
    const next = anchors[(i + 1) % m];
    const ax = px[cur] - px[prev], ay = py[cur] - py[prev];
    const bx = px[next] - px[cur], by = py[next] - py[cur];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos < threshold || forced !== void 0 && forced.has(cur)) {
      corners.push({ index: cur, corner: true });
    }
  }
  if (corners.length >= 2) return corners;
  if (corners.length === 1) {
    const start = anchors.indexOf(corners[0].index);
    const opposite = anchors[(start + Math.floor(m / 2)) % m];
    return [corners[0], { index: opposite, corner: false }];
  }
  return [
    { index: anchors[0], corner: false },
    { index: anchors[Math.floor(m / 2)], corner: false }
  ];
}
function extractChain(px, py, n2, start, end) {
  const count = start <= end ? end - start + 1 : n2 - start + end + 1;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const idx = (start + i) % n2;
    x[i] = px[idx];
    y[i] = py[idx];
  }
  return { x, y };
}
function leftTangent(x, y, i) {
  const k = Math.min(TANGENT_WINDOW, x.length - 1 - i);
  let vx = 0, vy = 0;
  for (let j = 1; j <= k; j++) {
    vx += (x[i + j] - x[i]) / j;
    vy += (y[i + j] - y[i]) / j;
  }
  return normalize(vx, vy);
}
function rightTangent(x, y, i) {
  const k = Math.min(TANGENT_WINDOW, i);
  let vx = 0, vy = 0;
  for (let j = 1; j <= k; j++) {
    vx += (x[i - j] - x[i]) / j;
    vy += (y[i - j] - y[i]) / j;
  }
  return normalize(vx, vy);
}
function centerTangentAt(px, py, n2, i) {
  const k = Math.max(1, Math.min(TANGENT_WINDOW, Math.floor(n2 / 2) - 1));
  const before = (i - k + n2 * 2) % n2;
  const after = (i + k) % n2;
  return normalize(px[after] - px[before], py[after] - py[before]);
}
function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}
function negate(p) {
  return { x: -p.x, y: -p.y };
}
function fitCubic(x, y, first, last, tHat1, tHat2, error, out, depth = 0) {
  const nPts = last - first + 1;
  if (nPts === 2) {
    const dist = Math.hypot(x[last] - x[first], y[last] - y[first]) / 3;
    emit(
      x[first] + tHat1.x * dist,
      y[first] + tHat1.y * dist,
      x[last] + tHat2.x * dist,
      y[last] + tHat2.y * dist,
      x[first],
      y[first],
      x[last],
      y[last],
      out,
      first,
      last,
      tHat1,
      tHat2
    );
    return;
  }
  let u = chordLengthParameterize(x, y, first, last);
  let bez = generateBezier(x, y, first, last, u, tHat1, tHat2);
  let { maxError, splitPoint } = computeMaxError(x, y, first, last, bez, u);
  if (maxError < error) {
    emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
    return;
  }
  if (maxError < error * NEWTON_BAND) {
    for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
      const uPrime = reparameterize(x, y, first, last, u, bez);
      bez = generateBezier(x, y, first, last, uPrime, tHat1, tHat2);
      const next = computeMaxError(x, y, first, last, bez, uPrime);
      if (next.maxError < error) {
        emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
        return;
      }
      u = uPrime;
      maxError = next.maxError;
      splitPoint = next.splitPoint;
    }
  }
  if (depth > 24 || splitPoint <= first || splitPoint >= last) {
    emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, tHat1, tHat2);
    return;
  }
  const tCenter = centerTangentOfChain(x, y, splitPoint);
  fitCubic(x, y, first, splitPoint, tHat1, negate(tCenter), error, out, depth + 1);
  fitCubic(x, y, splitPoint, last, tCenter, tHat2, error, out, depth + 1);
}
function optimizeCurves(x, y, segments, error) {
  if (segments.length < 2) return segments;
  let current = segments;
  for (let pass = 0; pass < MAX_OPTIMIZE_PASSES; pass++) {
    const merged = [];
    let changed = false;
    let i = 0;
    while (i < current.length) {
      const a = current[i];
      const b = current[i + 1];
      if (!b || b.first !== a.last) {
        merged.push(a);
        i++;
        continue;
      }
      const candidate = tryMerge(x, y, a, b, error);
      if (candidate) {
        merged.push(candidate);
        changed = true;
        i += 2;
      } else {
        merged.push(a);
        i++;
      }
    }
    current = merged;
    if (!changed) break;
  }
  return current;
}
function tryMerge(x, y, a, b, error) {
  const first = a.first;
  const last = b.last;
  if (last - first < 2) return null;
  const u = chordLengthParameterize(x, y, first, last);
  const bez = generateBezier(x, y, first, last, u, a.t1, b.t2);
  const { maxError } = computeMaxError(x, y, first, last, bez, u);
  if (maxError > error) return null;
  const out = [];
  emit(bez[2], bez[3], bez[4], bez[5], bez[0], bez[1], bez[6], bez[7], out, first, last, a.t1, b.t2);
  return out[0] ?? null;
}
function centerTangentOfChain(x, y, i) {
  const k = Math.min(TANGENT_WINDOW, i, x.length - 1 - i);
  if (k < 1) return normalize(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]);
  return normalize(x[i + k] - x[i - k], y[i + k] - y[i - k]);
}
function emit(c1x, c1y, c2x, c2y, p0x, p0y, p3x, p3y, out, first, last, t1, t2) {
  const dx = p3x - p0x, dy = p3y - p0y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    const d1 = Math.abs(dy * c1x - dx * c1y + p3x * p0y - p3y * p0x) / len;
    const d2 = Math.abs(dy * c2x - dx * c2y + p3x * p0y - p3y * p0x) / len;
    if (d1 < COLLINEAR_EPSILON && d2 < COLLINEAR_EPSILON) {
      out.push({ segment: { kind: "line", x: p3x, y: p3y }, first, last, t1, t2 });
      return;
    }
  }
  out.push({
    segment: { kind: "curve", x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: p3x, y: p3y },
    first,
    last,
    t1,
    t2
  });
}
function chordLengthParameterize(x, y, first, last) {
  const u = new Float64Array(last - first + 1);
  for (let i = first + 1; i <= last; i++) {
    u[i - first] = u[i - first - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  const total = u[last - first];
  if (total > 0) for (let i = 1; i <= last - first; i++) u[i] /= total;
  return u;
}
function generateBezier(x, y, first, last, u, tHat1, tHat2) {
  const nPts = last - first + 1;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < nPts; i++) {
    const t = u[i];
    const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);
    const a0x = tHat1.x * b1, a0y = tHat1.y * b1;
    const a1x = tHat2.x * b2, a1y = tHat2.y * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    const tmpX = x[first + i] - (x[first] * (b0 + b1) + x[last] * (b2 + b3));
    const tmpY = y[first + i] - (y[first] * (b0 + b1) + y[last] * (b2 + b3));
    x0 += a0x * tmpX + a0y * tmpY;
    x1 += a1x * tmpX + a1y * tmpY;
  }
  const detC = c00 * c11 - c01 * c01;
  const detXC1 = x0 * c11 - c01 * x1;
  const detC0X = c00 * x1 - c01 * x0;
  let alphaL = detC === 0 ? 0 : detXC1 / detC;
  let alphaR = detC === 0 ? 0 : detC0X / detC;
  const segLength = Math.hypot(x[last] - x[first], y[last] - y[first]);
  const epsilon = 1e-6 * segLength;
  if (alphaL < epsilon || alphaR < epsilon) {
    alphaL = alphaR = segLength / 3;
  }
  const maxAlpha = segLength * MAX_HANDLE_RATIO;
  if (alphaL > maxAlpha) alphaL = maxAlpha;
  if (alphaR > maxAlpha) alphaR = maxAlpha;
  return new Float64Array([
    x[first],
    y[first],
    x[first] + tHat1.x * alphaL,
    y[first] + tHat1.y * alphaL,
    x[last] + tHat2.x * alphaR,
    y[last] + tHat2.y * alphaR,
    x[last],
    y[last]
  ]);
}
function computeMaxError(x, y, first, last, bez, u) {
  let maxError = 0;
  let splitPoint = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const p = bezierAt(bez, u[i - first]);
    const dist = (p.x - x[i]) ** 2 + (p.y - y[i]) ** 2;
    if (dist >= maxError) {
      maxError = dist;
      splitPoint = i;
    }
  }
  return { maxError: Math.sqrt(maxError), splitPoint };
}
function reparameterize(x, y, first, last, u, bez) {
  const out = new Float64Array(u.length);
  for (let i = first; i <= last; i++) {
    out[i - first] = newtonRaphsonRootFind(bez, x[i], y[i], u[i - first]);
  }
  return out;
}
function newtonRaphsonRootFind(bez, px, py, u) {
  const q = bezierAt(bez, u);
  const d1 = derivativeAt(bez, u, 1);
  const d2 = derivativeAt(bez, u, 2);
  const numerator = (q.x - px) * d1.x + (q.y - py) * d1.y;
  const denominator = d1.x * d1.x + d1.y * d1.y + (q.x - px) * d2.x + (q.y - py) * d2.y;
  if (denominator === 0) return u;
  return u - numerator / denominator;
}
function bezierAt(bez, t) {
  const b0 = B0(t), b1 = B1(t), b2 = B2(t), b3 = B3(t);
  return {
    x: bez[0] * b0 + bez[2] * b1 + bez[4] * b2 + bez[6] * b3,
    y: bez[1] * b0 + bez[3] * b1 + bez[5] * b2 + bez[7] * b3
  };
}
function derivativeAt(bez, t, order) {
  const q = new Float64Array(6);
  for (let i = 0; i < 3; i++) {
    q[i * 2] = (bez[(i + 1) * 2] - bez[i * 2]) * 3;
    q[i * 2 + 1] = (bez[(i + 1) * 2 + 1] - bez[i * 2 + 1]) * 3;
  }
  if (order === 1) {
    const mt = 1 - t;
    return {
      x: q[0] * mt * mt + q[2] * 2 * mt * t + q[4] * t * t,
      y: q[1] * mt * mt + q[3] * 2 * mt * t + q[5] * t * t
    };
  }
  const r = new Float64Array(4);
  for (let i = 0; i < 2; i++) {
    r[i * 2] = (q[(i + 1) * 2] - q[i * 2]) * 2;
    r[i * 2 + 1] = (q[(i + 1) * 2 + 1] - q[i * 2 + 1]) * 2;
  }
  return {
    x: r[0] * (1 - t) + r[2] * t,
    y: r[1] * (1 - t) + r[3] * t
  };
}
function B0(t) {
  const m = 1 - t;
  return m * m * m;
}
function B1(t) {
  const m = 1 - t;
  return 3 * t * m * m;
}
function B2(t) {
  const m = 1 - t;
  return 3 * t * t * m;
}
function B3(t) {
  return t * t * t;
}

// src/vectorize/quantize.ts
var SIDE = 33;
var R_STRIDE = SIDE * SIDE;
var G_STRIDE = SIDE;
var VOLUME = SIDE * SIDE * SIDE;
function boxIndex(r, g, b) {
  return r * R_STRIDE + g * G_STRIDE + b;
}
function buildMoments(img, alphaFloor) {
  const wt = new Float64Array(VOLUME);
  const mr = new Float64Array(VOLUME);
  const mg = new Float64Array(VOLUME);
  const mb = new Float64Array(VOLUME);
  const m2 = new Float64Array(VOLUME);
  const d = img.data;
  const n2 = img.width * img.height;
  let total = 0;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    if (d[o + 3] < alphaFloor) continue;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const idx = boxIndex((r >> 3) + 1, (g >> 3) + 1, (b >> 3) + 1);
    wt[idx] += 1;
    mr[idx] += r;
    mg[idx] += g;
    mb[idx] += b;
    m2[idx] += r * r + g * g + b * b;
    total++;
  }
  const binCount = wt.slice();
  const binR = mr.slice();
  const binG = mg.slice();
  const binB = mb.slice();
  accumulate(wt, mr, mg, mb, m2);
  return { wt, mr, mg, mb, m2, binCount, binR, binG, binB, total };
}
function accumulate(wt, mr, mg, mb, m2) {
  const area = new Float64Array(SIDE);
  const areaR = new Float64Array(SIDE);
  const areaG = new Float64Array(SIDE);
  const areaB = new Float64Array(SIDE);
  const area2 = new Float64Array(SIDE);
  for (let r = 1; r < SIDE; r++) {
    area.fill(0);
    areaR.fill(0);
    areaG.fill(0);
    areaB.fill(0);
    area2.fill(0);
    for (let g = 1; g < SIDE; g++) {
      let line = 0, lineR = 0, lineG = 0, lineB = 0, line2 = 0;
      for (let b = 1; b < SIDE; b++) {
        const cur = boxIndex(r, g, b);
        line += wt[cur];
        lineR += mr[cur];
        lineG += mg[cur];
        lineB += mb[cur];
        line2 += m2[cur];
        area[b] += line;
        areaR[b] += lineR;
        areaG[b] += lineG;
        areaB[b] += lineB;
        area2[b] += line2;
        const prev = cur - R_STRIDE;
        wt[cur] = wt[prev] + area[b];
        mr[cur] = mr[prev] + areaR[b];
        mg[cur] = mg[prev] + areaG[b];
        mb[cur] = mb[prev] + areaB[b];
        m2[cur] = m2[prev] + area2[b];
      }
    }
  }
}
function volume(c, m) {
  return m[boxIndex(c.r1, c.g1, c.b1)] - m[boxIndex(c.r1, c.g1, c.b0)] - m[boxIndex(c.r1, c.g0, c.b1)] + m[boxIndex(c.r1, c.g0, c.b0)] - m[boxIndex(c.r0, c.g1, c.b1)] + m[boxIndex(c.r0, c.g1, c.b0)] + m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)];
}
function bottom(c, dir, m) {
  switch (dir) {
    case "r":
      return -m[boxIndex(c.r0, c.g1, c.b1)] + m[boxIndex(c.r0, c.g1, c.b0)] + m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)];
    case "g":
      return -m[boxIndex(c.r1, c.g0, c.b1)] + m[boxIndex(c.r1, c.g0, c.b0)] + m[boxIndex(c.r0, c.g0, c.b1)] - m[boxIndex(c.r0, c.g0, c.b0)];
    case "b":
      return -m[boxIndex(c.r1, c.g1, c.b0)] + m[boxIndex(c.r1, c.g0, c.b0)] + m[boxIndex(c.r0, c.g1, c.b0)] - m[boxIndex(c.r0, c.g0, c.b0)];
  }
}
function top(c, dir, pos, m) {
  switch (dir) {
    case "r":
      return m[boxIndex(pos, c.g1, c.b1)] - m[boxIndex(pos, c.g1, c.b0)] - m[boxIndex(pos, c.g0, c.b1)] + m[boxIndex(pos, c.g0, c.b0)];
    case "g":
      return m[boxIndex(c.r1, pos, c.b1)] - m[boxIndex(c.r1, pos, c.b0)] - m[boxIndex(c.r0, pos, c.b1)] + m[boxIndex(c.r0, pos, c.b0)];
    case "b":
      return m[boxIndex(c.r1, c.g1, pos)] - m[boxIndex(c.r1, c.g0, pos)] - m[boxIndex(c.r0, c.g1, pos)] + m[boxIndex(c.r0, c.g0, pos)];
  }
}
function variance(c, m) {
  const dr = volume(c, m.mr);
  const dg = volume(c, m.mg);
  const db = volume(c, m.mb);
  const xx = volume(c, m.m2);
  const w = volume(c, m.wt);
  if (w === 0) return 0;
  return xx - (dr * dr + dg * dg + db * db) / w;
}
function maximize(c, dir, first, last, wholeR, wholeG, wholeB, wholeW, m) {
  const baseR = bottom(c, dir, m.mr);
  const baseG = bottom(c, dir, m.mg);
  const baseB = bottom(c, dir, m.mb);
  const baseW = bottom(c, dir, m.wt);
  let best = -1;
  let bestPos = -1;
  for (let i = first; i < last; i++) {
    let halfR = baseR + top(c, dir, i, m.mr);
    let halfG = baseG + top(c, dir, i, m.mg);
    let halfB = baseB + top(c, dir, i, m.mb);
    let halfW = baseW + top(c, dir, i, m.wt);
    if (halfW === 0) continue;
    let temp = (halfR * halfR + halfG * halfG + halfB * halfB) / halfW;
    halfR = wholeR - halfR;
    halfG = wholeG - halfG;
    halfB = wholeB - halfB;
    halfW = wholeW - halfW;
    if (halfW === 0) continue;
    temp += (halfR * halfR + halfG * halfG + halfB * halfB) / halfW;
    if (temp > best) {
      best = temp;
      bestPos = i;
    }
  }
  return { position: bestPos, reduction: best };
}
function cut(set1, set2, m) {
  const wholeR = volume(set1, m.mr);
  const wholeG = volume(set1, m.mg);
  const wholeB = volume(set1, m.mb);
  const wholeW = volume(set1, m.wt);
  const cr = maximize(set1, "r", set1.r0 + 1, set1.r1, wholeR, wholeG, wholeB, wholeW, m);
  const cg = maximize(set1, "g", set1.g0 + 1, set1.g1, wholeR, wholeG, wholeB, wholeW, m);
  const cb = maximize(set1, "b", set1.b0 + 1, set1.b1, wholeR, wholeG, wholeB, wholeW, m);
  let dir;
  if (cr.reduction >= cg.reduction && cr.reduction >= cb.reduction) {
    if (cr.position < 0) return false;
    dir = "r";
  } else if (cg.reduction >= cr.reduction && cg.reduction >= cb.reduction) {
    dir = "g";
  } else {
    dir = "b";
  }
  const chosen = dir === "r" ? cr : dir === "g" ? cg : cb;
  if (chosen.position < 0) return false;
  set2.r1 = set1.r1;
  set2.g1 = set1.g1;
  set2.b1 = set1.b1;
  switch (dir) {
    case "r":
      set2.r0 = set1.r1 = chosen.position;
      set2.g0 = set1.g0;
      set2.b0 = set1.b0;
      break;
    case "g":
      set2.g0 = set1.g1 = chosen.position;
      set2.r0 = set1.r0;
      set2.b0 = set1.b0;
      break;
    case "b":
      set2.b0 = set1.b1 = chosen.position;
      set2.r0 = set1.r0;
      set2.g0 = set1.g0;
      break;
  }
  set1.vol = (set1.r1 - set1.r0) * (set1.g1 - set1.g0) * (set1.b1 - set1.b0);
  set2.vol = (set2.r1 - set2.r0) * (set2.g1 - set2.g0) * (set2.b1 - set2.b0);
  return true;
}
function quantize(img, maxColors, opts = {}) {
  if (opts.fixedPalette && opts.fixedPalette.length > 0) {
    const cols = opts.fixedPalette.slice(0, 256);
    const rgb2 = new Uint8Array(cols.length * 3);
    const lab = new Float64Array(cols.length * 3);
    for (let i = 0; i < cols.length; i++) {
      const r = clamp255(cols[i].r), g = clamp255(cols[i].g), b = clamp255(cols[i].b);
      rgb2[i * 3] = r;
      rgb2[i * 3 + 1] = g;
      rgb2[i * 3 + 2] = b;
      srgbToOklab(r, g, b, lab, i * 3);
    }
    return { rgb: rgb2, lab, count: cols.length };
  }
  const alphaFloor = opts.alphaFloor ?? 1;
  const k = Math.max(1, Math.min(256, Math.floor(maxColors)));
  const m = buildMoments(img, alphaFloor);
  if (m.total === 0) {
    return { rgb: new Uint8Array([0, 0, 0]), lab: new Float64Array(3), count: 1 };
  }
  const boxes = Array.from({ length: k }, () => ({
    r0: 0,
    r1: 0,
    g0: 0,
    g1: 0,
    b0: 0,
    b1: 0,
    vol: 0
  }));
  boxes[0] = { r0: 0, r1: 32, g0: 0, g1: 32, b0: 0, b1: 32, vol: 32 * 32 * 32 };
  const residual = new Float64Array(k);
  let next = 0;
  let used = 1;
  for (let i = 1; i < k; i++) {
    if (cut(boxes[next], boxes[i], m)) {
      residual[next] = boxes[next].vol > 1 ? variance(boxes[next], m) : 0;
      residual[i] = boxes[i].vol > 1 ? variance(boxes[i], m) : 0;
    } else {
      residual[next] = 0;
      i--;
    }
    next = 0;
    let worst = residual[0];
    for (let j = 1; j <= i; j++) {
      if (residual[j] > worst) {
        worst = residual[j];
        next = j;
      }
    }
    if (worst <= 0) {
      used = i + 1;
      break;
    }
    used = i + 1;
  }
  const strategy = opts.fillStrategy ?? "mean";
  const rgb = new Uint8Array(used * 3);
  for (let i = 0; i < used; i++) {
    const w = volume(boxes[i], m.wt);
    if (w > 0 && strategy === "mean") {
      rgb[i * 3] = clamp255(volume(boxes[i], m.mr) / w);
      rgb[i * 3 + 1] = clamp255(volume(boxes[i], m.mg) / w);
      rgb[i * 3 + 2] = clamp255(volume(boxes[i], m.mb) / w);
    } else if (w > 0) {
      const c = strategy === "dominant" ? dominantColorOfBox(boxes[i], m) : medianColorOfBox(boxes[i], m);
      rgb[i * 3] = c[0];
      rgb[i * 3 + 1] = c[1];
      rgb[i * 3 + 2] = c[2];
    } else {
      rgb[i * 3] = clamp255((boxes[i].r0 + boxes[i].r1) / 2 * 8);
      rgb[i * 3 + 1] = clamp255((boxes[i].g0 + boxes[i].g1) / 2 * 8);
      rgb[i * 3 + 2] = clamp255((boxes[i].b0 + boxes[i].b1) / 2 * 8);
    }
  }
  const palette = { rgb, lab: new Float64Array(used * 3), count: used };
  refineOklab(palette, m, strategy === "mean" ? opts.refineIterations ?? 4 : 0);
  computeLab(palette);
  return palette;
}
function dominantColorOfBox(c, m) {
  let best = -1;
  let bestCount = 0;
  for (let r = c.r0 + 1; r <= c.r1; r++) {
    for (let g = c.g0 + 1; g <= c.g1; g++) {
      for (let b = c.b0 + 1; b <= c.b1; b++) {
        const idx = boxIndex(r, g, b);
        if (m.binCount[idx] > bestCount) {
          bestCount = m.binCount[idx];
          best = idx;
        }
      }
    }
  }
  if (best < 0) {
    return [
      clamp255((c.r0 + c.r1) / 2 * 8),
      clamp255((c.g0 + c.g1) / 2 * 8),
      clamp255((c.b0 + c.b1) / 2 * 8)
    ];
  }
  const w = m.binCount[best];
  return [clamp255(m.binR[best] / w), clamp255(m.binG[best] / w), clamp255(m.binB[best] / w)];
}
function medianColorOfBox(c, m) {
  const rs = [], gs = [], bs = [], ws = [];
  let totalW = 0;
  for (let r = c.r0 + 1; r <= c.r1; r++) {
    for (let g = c.g0 + 1; g <= c.g1; g++) {
      for (let b = c.b0 + 1; b <= c.b1; b++) {
        const idx = boxIndex(r, g, b);
        const w = m.binCount[idx];
        if (w <= 0) continue;
        rs.push(m.binR[idx] / w);
        gs.push(m.binG[idx] / w);
        bs.push(m.binB[idx] / w);
        ws.push(w);
        totalW += w;
      }
    }
  }
  if (totalW === 0) {
    return [
      clamp255((c.r0 + c.r1) / 2 * 8),
      clamp255((c.g0 + c.g1) / 2 * 8),
      clamp255((c.b0 + c.b1) / 2 * 8)
    ];
  }
  return [
    weightedMedian(rs, ws, totalW),
    weightedMedian(gs, ws, totalW),
    weightedMedian(bs, ws, totalW)
  ];
}
function weightedMedian(values, weights, totalW) {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const half = totalW / 2;
  let acc = 0;
  for (const i of order) {
    acc += weights[i];
    if (acc >= half) return clamp255(values[i]);
  }
  return clamp255(values[order[order.length - 1]]);
}
function clamp255(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}
function computeLab(p) {
  for (let i = 0; i < p.count; i++) {
    srgbToOklab(p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], p.lab, i * 3);
  }
}
function refineOklab(p, m, iterations) {
  if (iterations <= 0) return;
  const binIdx = [];
  for (let i = 0; i < VOLUME; i++) if (m.binCount[i] > 0) binIdx.push(i);
  if (binIdx.length <= p.count) return;
  const bins = binIdx.length;
  const pts = new Float64Array(bins * 3);
  const weights = new Float64Array(bins);
  const scratch = new Float64Array(3);
  for (let i = 0; i < bins; i++) {
    const b = binIdx[i];
    const w = m.binCount[b];
    weights[i] = w;
    srgbToOklab(
      clamp255(m.binR[b] / w),
      clamp255(m.binG[b] / w),
      clamp255(m.binB[b] / w),
      scratch
    );
    pts[i * 3] = scratch[0];
    pts[i * 3 + 1] = scratch[1];
    pts[i * 3 + 2] = scratch[2];
  }
  const centroids = new Float64Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    srgbToOklab(p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], centroids, i * 3);
  }
  const sums = new Float64Array(p.count * 3);
  const totals = new Float64Array(p.count);
  for (let iter = 0; iter < iterations; iter++) {
    sums.fill(0);
    totals.fill(0);
    let moved = false;
    for (let i = 0; i < bins; i++) {
      const L = pts[i * 3], A = pts[i * 3 + 1], B = pts[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < p.count; c++) {
        const dL = L - centroids[c * 3];
        const dA = A - centroids[c * 3 + 1];
        const dB = B - centroids[c * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      const w = weights[i];
      sums[best * 3] += L * w;
      sums[best * 3 + 1] += A * w;
      sums[best * 3 + 2] += B * w;
      totals[best] += w;
    }
    for (let c = 0; c < p.count; c++) {
      if (totals[c] === 0) continue;
      const nL = sums[c * 3] / totals[c];
      const nA = sums[c * 3 + 1] / totals[c];
      const nB = sums[c * 3 + 2] / totals[c];
      if (nL !== centroids[c * 3] || nA !== centroids[c * 3 + 1] || nB !== centroids[c * 3 + 2]) {
        moved = true;
      }
      centroids[c * 3] = nL;
      centroids[c * 3 + 1] = nA;
      centroids[c * 3 + 2] = nB;
    }
    if (!moved) break;
  }
  for (let c = 0; c < p.count; c++) {
    const [r, g, b] = oklabToSrgb(centroids[c * 3], centroids[c * 3 + 1], centroids[c * 3 + 2]);
    p.rgb[c * 3] = r;
    p.rgb[c * 3 + 1] = g;
    p.rgb[c * 3 + 2] = b;
  }
}
var NearestColor = class {
  constructor(palette, expectedPixels) {
    this.palette = palette;
    __publicField(this, "cache");
    __publicField(this, "map");
    __publicField(this, "scratch", new Float64Array(3));
    if (expectedPixels > 25e4) {
      this.cache = new Int16Array(1 << 24).fill(-1);
      this.map = null;
    } else {
      this.cache = null;
      this.map = /* @__PURE__ */ new Map();
    }
  }
  index(r, g, b) {
    const key = r << 16 | g << 8 | b;
    if (this.cache) {
      const hit2 = this.cache[key];
      if (hit2 >= 0) return hit2;
      const found2 = this.search(r, g, b);
      this.cache[key] = found2;
      return found2;
    }
    const hit = this.map.get(key);
    if (hit !== void 0) return hit;
    const found = this.search(r, g, b);
    this.map.set(key, found);
    return found;
  }
  search(r, g, b) {
    srgbToOklab(r, g, b, this.scratch);
    const L = this.scratch[0], A = this.scratch[1], B = this.scratch[2];
    const lab = this.palette.lab;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < this.palette.count; c++) {
      const dL = L - lab[c * 3];
      const dA = A - lab[c * 3 + 1];
      const dB = B - lab[c * 3 + 2];
      const d = dL * dL + dA * dA + dB * dB;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
};
function quantizeAlpha(img, maxLevels) {
  const hist = new Float64Array(256);
  const d = img.data;
  const n2 = img.width * img.height;
  for (let i = 0; i < n2; i++) hist[d[i * 4 + 3]]++;
  const present = [];
  for (let v = 0; v < 256; v++) if (hist[v] > 0) present.push(v);
  if (present.length <= maxLevels) return Uint8Array.from(present);
  const k = Math.max(1, maxLevels);
  let centers = Array.from(
    { length: k },
    (_, i) => present[Math.min(present.length - 1, Math.round(i * (present.length - 1) / (k - 1 || 1)))]
  );
  for (let iter = 0; iter < 24; iter++) {
    const sums = new Float64Array(k);
    const counts = new Float64Array(k);
    for (const v of present) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = Math.abs(v - centers[c]);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      sums[best] += v * hist[v];
      counts[best] += hist[v];
    }
    let moved = false;
    const nextCenters = centers.slice();
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const nv = Math.round(sums[c] / counts[c]);
      if (nv !== centers[c]) moved = true;
      nextCenters[c] = nv;
    }
    centers = nextCenters;
    if (!moved) break;
  }
  const levels = new Set(centers);
  if (hist[0] > 0) levels.add(0);
  if (hist[255] > 0) levels.add(255);
  return Uint8Array.from([...levels].sort((x, y) => x - y));
}
function extractPalette(img, colors = 6) {
  const pal = quantize(img, colors, {});
  const n2 = img.width * img.height;
  const nearest = new NearestColor(pal, n2);
  const counts = new Float64Array(pal.count);
  let total = 0;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    if (img.data[o + 3] < 8) continue;
    counts[nearest.index(img.data[o], img.data[o + 1], img.data[o + 2])]++;
    total++;
  }
  const out = [];
  for (let i = 0; i < pal.count; i++) {
    out.push({
      hex: shortHex(pal.rgb[i * 3], pal.rgb[i * 3 + 1], pal.rgb[i * 3 + 2]),
      rgb: { r: pal.rgb[i * 3], g: pal.rgb[i * 3 + 1], b: pal.rgb[i * 3 + 2], a: 255 },
      oklab: [pal.lab[i * 3], pal.lab[i * 3 + 1], pal.lab[i * 3 + 2]],
      weight: total > 0 ? counts[i] / total : 0
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}
function paletteToCssVars(palette, prefix = "--color") {
  const body = palette.map((e, i) => `  ${prefix}-${i + 1}: ${e.hex};`).join("\n");
  return `:root {
${body}
}
`;
}

// src/vectorize/threshold.ts
function otsuThreshold(img) {
  const histogram = new Float64Array(256);
  const { data } = img;
  const n2 = img.width * img.height;
  let counted = 0;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    histogram[Math.round(luma709(data[o], data[o + 1], data[o + 2]))]++;
    counted++;
  }
  if (counted === 0) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBackground = 0;
  let weightBackground = 0;
  let maxBetween = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = counted - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > maxBetween) {
      maxBetween = between;
      threshold = t;
    }
  }
  return threshold;
}
function applyThreshold(img, opts = {}) {
  const cutoff = opts.threshold === void 0 || opts.threshold === "auto" ? otsuThreshold(img) : opts.threshold;
  const blackOnWhite = opts.blackOnWhite ?? true;
  const fg = opts.foreground ?? [0, 0, 0];
  const bg = opts.background ?? [255, 255, 255];
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  const n2 = width * height;
  for (let i = 0; i < n2; i++) {
    const o = i * 4;
    const alpha = data[o + 3];
    if (alpha < 128) {
      out[o + 3] = 0;
      continue;
    }
    const lum = luma709(data[o], data[o + 1], data[o + 2]);
    const isForeground = blackOnWhite ? lum <= cutoff : lum > cutoff;
    const c = isForeground ? fg : bg;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return { image: { width, height, data: out }, threshold: cutoff };
}

// src/vectorize/gradient.ts
var GRAD_BASE = 1 << 20;
var GRADIENT_DEFAULTS = {
  gradients: false,
  gradientMinArea: 0,
  gradientStepMax: 0.08,
  gradientMargin: 0.1,
  gradientMaxError: 0.1,
  gradientStops: 16
};
function detectGradients(img, classes, palette, alphaLevels, levelCount, width, height, opts) {
  const n2 = width * height;
  const paints = /* @__PURE__ */ new Map();
  if (!opts.gradients) return { classes, paints };
  const minArea = opts.gradientMinArea > 0 ? opts.gradientMinArea : Math.max(64, Math.round(n2 / 2e3));
  const stepMaxSq = opts.gradientStepMax * opts.gradientStepMax;
  const parent = new Int32Array(n2);
  for (let i = 0; i < n2; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r] = parent[parent[r]];
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };
  const colorIdx = (cls) => Math.floor(cls / levelCount);
  const alphaIdx = (cls) => cls % levelCount;
  const bandClose = (ca, cb) => {
    if (ca === cb) return true;
    const dl = palette.lab[ca * 3] - palette.lab[cb * 3];
    const da = palette.lab[ca * 3 + 1] - palette.lab[cb * 3 + 1];
    const db = palette.lab[ca * 3 + 2] - palette.lab[cb * 3 + 2];
    return dl * dl + da * da + db * db <= stepMaxSq;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const cls = classes[i];
      if (cls < 0) continue;
      const ci = colorIdx(cls), ai = alphaIdx(cls);
      if (x + 1 < width) {
        const j = i + 1;
        const cj = classes[j];
        if (cj >= 0 && alphaIdx(cj) === ai && bandClose(ci, colorIdx(cj))) union(i, j);
      }
      if (y + 1 < height) {
        const j = i + width;
        const cj = classes[j];
        if (cj >= 0 && alphaIdx(cj) === ai && bandClose(ci, colorIdx(cj))) union(i, j);
      }
    }
  }
  const area = new Int32Array(n2);
  const firstColor = new Int32Array(n2).fill(-1);
  const multiColor = new Uint8Array(n2);
  for (let i = 0; i < n2; i++) {
    if (classes[i] < 0) continue;
    const r = find(i);
    area[r]++;
    const ci = colorIdx(classes[i]);
    if (firstColor[r] === -1) firstColor[r] = ci;
    else if (firstColor[r] !== ci) multiColor[r] = 1;
  }
  const rootToK = new Int32Array(n2).fill(-1);
  const kRoot = [];
  for (let i = 0; i < n2; i++) {
    if (parent[i] === i && classes[i] >= 0 && area[i] >= minArea && multiColor[i]) {
      rootToK[i] = kRoot.length;
      kRoot.push(i);
    }
  }
  const K = kRoot.length;
  if (K === 0) return { classes, paints };
  const kOf = (i) => rootToK[find(i)];
  const M = new Float64Array(K * 6);
  const RL = new Float64Array(K * 3);
  const RA = new Float64Array(K * 3);
  const RB = new Float64Array(K * 3);
  const lab = new Float64Array(3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0) continue;
      const o = i * 4;
      srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], lab);
      const m = k * 6;
      M[m] += 1;
      M[m + 1] += x;
      M[m + 2] += y;
      M[m + 3] += x * x;
      M[m + 4] += x * y;
      M[m + 5] += y * y;
      const rl = k * 3;
      RL[rl] += lab[0];
      RL[rl + 1] += x * lab[0];
      RL[rl + 2] += y * lab[0];
      RA[rl] += lab[1];
      RA[rl + 1] += x * lab[1];
      RA[rl + 2] += y * lab[1];
      RB[rl] += lab[2];
      RB[rl + 1] += x * lab[2];
      RB[rl + 2] += y * lab[2];
    }
  }
  const models = new Array(K).fill(null);
  for (let k = 0; k < K; k++) {
    const m = k * 6;
    const nrm = [M[m], M[m + 1], M[m + 2], M[m + 1], M[m + 3], M[m + 4], M[m + 2], M[m + 4], M[m + 5]];
    const cl = solve3(nrm, RL[k * 3], RL[k * 3 + 1], RL[k * 3 + 2]);
    const ca = solve3(nrm, RA[k * 3], RA[k * 3 + 1], RA[k * 3 + 2]);
    const cb = solve3(nrm, RB[k * 3], RB[k * 3 + 1], RB[k * 3 + 2]);
    if (!cl || !ca || !cb) continue;
    const jxx = cl[1], jxy = cl[2], jax = ca[1], jay = ca[2], jbx = cb[1], jby = cb[2];
    const a = jxx * jxx + jax * jax + jbx * jbx;
    const b = jxx * jxy + jax * jay + jbx * jby;
    const c = jxy * jxy + jay * jay + jby * jby;
    const axis = topEigenvector2(a, b, c);
    if (!axis) continue;
    const count = M[m];
    models[k] = {
      dx: axis[0],
      dy: axis[1],
      meanX: M[m + 1] / count,
      meanY: M[m + 2] / count
    };
  }
  const tMin = new Float64Array(K).fill(Infinity);
  const tMax = new Float64Array(K).fill(-Infinity);
  const flatSum = new Float64Array(K);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0 || !models[k]) continue;
      const mdl = models[k];
      const t = mdl.dx * x + mdl.dy * y;
      if (t < tMin[k]) tMin[k] = t;
      if (t > tMax[k]) tMax[k] = t;
      const o = i * 4;
      srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], lab);
      const ci = colorIdx(classes[i]) * 3;
      flatSum[k] += sq(lab[0] - palette.lab[ci]) + sq(lab[1] - palette.lab[ci + 1]) + sq(lab[2] - palette.lab[ci + 2]);
    }
  }
  const FINE = 32;
  const fineL = new Float64Array(K * FINE);
  const fineA = new Float64Array(K * FINE);
  const fineB = new Float64Array(K * FINE);
  const fineN = new Float64Array(K * FINE);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0 || !models[k] || !(tMax[k] > tMin[k])) continue;
      const mdl = models[k];
      const u = clamp01((mdl.dx * x + mdl.dy * y - tMin[k]) / (tMax[k] - tMin[k]));
      const j = Math.min(FINE - 1, Math.floor(u * FINE));
      const o = i * 4;
      srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], lab);
      const b = k * FINE + j;
      fineL[b] += lab[0];
      fineA[b] += lab[1];
      fineB[b] += lab[2];
      fineN[b] += 1;
    }
  }
  const maxStops = Math.max(2, opts.gradientStops);
  const stopList = new Array(K).fill(null);
  for (let k = 0; k < K; k++) {
    if (!models[k] || !(tMax[k] > tMin[k])) {
      models[k] = null;
      continue;
    }
    const curve = new Float64Array(FINE * 3);
    const w = new Float64Array(FINE);
    let last = -1;
    for (let j = 0; j < FINE; j++) {
      const b = k * FINE + j;
      if (fineN[b] > 0) {
        curve[j * 3] = fineL[b] / fineN[b];
        curve[j * 3 + 1] = fineA[b] / fineN[b];
        curve[j * 3 + 2] = fineB[b] / fineN[b];
        w[j] = fineN[b];
        if (last === -1) {
          for (let t = 0; t < j; t++) {
            curve[t * 3] = curve[j * 3];
            curve[t * 3 + 1] = curve[j * 3 + 1];
            curve[t * 3 + 2] = curve[j * 3 + 2];
          }
        }
        last = j;
      } else if (last >= 0) {
        curve[j * 3] = curve[last * 3];
        curve[j * 3 + 1] = curve[last * 3 + 1];
        curve[j * 3 + 2] = curve[last * 3 + 2];
      }
    }
    const flatErr = flatSum[k] / M[k * 6];
    stopList[k] = selectStops(curve, w, FINE, maxStops, flatErr * (1 - opts.gradientMargin));
  }
  const gradSum = new Float64Array(K);
  const renderLab = new Float64Array(3);
  const rgbTmp = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (classes[i] < 0) continue;
      const k = kOf(i);
      if (k < 0 || !models[k] || !stopList[k]) continue;
      const mdl = models[k];
      const u = clamp01((mdl.dx * x + mdl.dy * y - tMin[k]) / (tMax[k] - tMin[k]));
      renderStops(stopList[k], u, rgbTmp);
      srgbToOklab(Math.round(rgbTmp[0]), Math.round(rgbTmp[1]), Math.round(rgbTmp[2]), renderLab);
      const o = i * 4;
      srgbToOklab(img.data[o], img.data[o + 1], img.data[o + 2], lab);
      gradSum[k] += sq(lab[0] - renderLab[0]) + sq(lab[1] - renderLab[1]) + sq(lab[2] - renderLab[2]);
    }
  }
  const out = classes.slice();
  const accepted = new Uint8Array(K);
  const floorSq = opts.gradientMaxError * opts.gradientMaxError;
  for (let k = 0; k < K; k++) {
    if (!models[k]) continue;
    const count = M[k * 6];
    const gradErr = gradSum[k] / count;
    const flatErr = flatSum[k] / count;
    if (gradErr < flatErr * (1 - opts.gradientMargin) && gradErr < floorSq) {
      accepted[k] = 1;
      paints.set(GRAD_BASE + k, buildPaint(kRoot[k], classes, alphaLevels, levelCount, models[k], tMin[k], tMax[k], stopList[k], k));
    }
  }
  if (paints.size === 0) return { classes, paints };
  for (let i = 0; i < n2; i++) {
    if (classes[i] < 0) continue;
    const k = kOf(i);
    if (k >= 0 && accepted[k]) out[i] = GRAD_BASE + k;
  }
  return { classes: out, paints };
}
function buildPaint(root, classes, alphaLevels, levelCount, mdl, tMin, tMax, stops, k) {
  const meanT = mdl.dx * mdl.meanX + mdl.dy * mdl.meanY;
  const x1 = mdl.meanX + mdl.dx * (tMin - meanT);
  const y1 = mdl.meanY + mdl.dy * (tMin - meanT);
  const x2 = mdl.meanX + mdl.dx * (tMax - meanT);
  const y2 = mdl.meanY + mdl.dy * (tMax - meanT);
  let body = "";
  let prev = "";
  for (let s = 0; s < stops.length; s++) {
    const hex3 = shortHex(clamp2552(stops[s][1]), clamp2552(stops[s][2]), clamp2552(stops[s][3]));
    if (hex3 === prev && s !== stops.length - 1) continue;
    prev = hex3;
    body += `<stop offset="${round(stops[s][0], 3)}" stop-color="${hex3}"/>`;
  }
  const id = `pv-g${k}`;
  const def = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(x1, 2)}" y1="${round(y1, 2)}" x2="${round(x2, 2)}" y2="${round(y2, 2)}">${body}</linearGradient>`;
  const alpha = alphaLevels[classes[root] % levelCount] / 255;
  return { def, ref: `url(#${id})`, alpha };
}
function selectStops(curve, weight, fine, maxStops, targetSq) {
  const chosen = [0, fine - 1];
  const rgb = [0, 0, 0];
  const lab = new Float64Array(3);
  for (; ; ) {
    const stops = chosen.map((j) => {
      const [r, g, b] = oklabToSrgb(curve[j * 3], curve[j * 3 + 1], curve[j * 3 + 2]);
      return [j / (fine - 1), r, g, b];
    });
    let worst = -1, worstErr = -1, totE = 0, totW = 0;
    for (let j = 0; j < fine; j++) {
      if (weight[j] <= 0) continue;
      renderStops(stops, j / (fine - 1), rgb);
      srgbToOklab(Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), lab);
      const e = sq(lab[0] - curve[j * 3]) + sq(lab[1] - curve[j * 3 + 1]) + sq(lab[2] - curve[j * 3 + 2]);
      totE += e * weight[j];
      totW += weight[j];
      if (e * weight[j] > worstErr && chosen.indexOf(j) < 0) {
        worstErr = e * weight[j];
        worst = j;
      }
    }
    if (chosen.length >= maxStops || worst < 0 || totW > 0 && totE / totW <= targetSq) {
      return stops;
    }
    chosen.push(worst);
    chosen.sort((a, b) => a - b);
  }
}
function renderStops(stops, off, out) {
  if (off <= stops[0][0]) {
    out[0] = stops[0][1];
    out[1] = stops[0][2];
    out[2] = stops[0][3];
    return;
  }
  const last = stops[stops.length - 1];
  if (off >= last[0]) {
    out[0] = last[1];
    out[1] = last[2];
    out[2] = last[3];
    return;
  }
  for (let s = 1; s < stops.length; s++) {
    const b = stops[s];
    if (off <= b[0]) {
      const a = stops[s - 1];
      const fr = (off - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * fr;
      out[1] = a[2] + (b[2] - a[2]) * fr;
      out[2] = a[3] + (b[3] - a[3]) * fr;
      return;
    }
  }
  out[0] = last[1];
  out[1] = last[2];
  out[2] = last[3];
}
function solve3(m, r0, r1, r2) {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const x = (r0 * (m[4] * m[8] - m[5] * m[7]) - m[1] * (r1 * m[8] - m[5] * r2) + m[2] * (r1 * m[7] - m[4] * r2)) * inv;
  const y = (m[0] * (r1 * m[8] - m[5] * r2) - r0 * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * r2 - r1 * m[6])) * inv;
  const z = (m[0] * (m[4] * r2 - r1 * m[7]) - m[1] * (m[3] * r2 - r1 * m[6]) + r0 * (m[3] * m[7] - m[4] * m[6])) * inv;
  return [x, y, z];
}
function topEigenvector2(a, b, c) {
  if (a + c < 1e-12) return null;
  const disc = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const lambda = (a + c) / 2 + disc;
  let vx, vy;
  if (Math.abs(b) > 1e-12) {
    vx = lambda - c;
    vy = b;
  } else {
    vx = a >= c ? 1 : 0;
    vy = a >= c ? 0 : 1;
  }
  const len = Math.hypot(vx, vy);
  if (len < 1e-12) return null;
  return [vx / len, vy / len];
}
function sq(v) {
  return v * v;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp2552(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}
function round(v, places) {
  const p = 10 ** places;
  return Math.round(v * p) / p;
}

// src/vectorize/primitives.ts
var DEFAULTS = { maxError: 1, minExtent: 3 };
function detectPrimitive(pts, opts = {}) {
  const maxError = opts.maxError ?? DEFAULTS.maxError;
  const minExtent = opts.minExtent ?? DEFAULTS.minExtent;
  const n2 = pts.length >> 1;
  if (n2 < 4) return null;
  const b = bbox(pts, n2);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w < minExtent || h < minExtent) return null;
  const area = Math.abs(shoelace(pts, n2));
  let best = null;
  let bestErr = Infinity;
  const rect = fitRect(pts, n2, b, w, h, area);
  if (rect && rect.err <= maxError) {
    best = rect.prim;
    bestErr = rect.err;
  }
  const circle = fitCircle(pts, n2, area);
  if (circle && circle.err <= maxError && circle.err < bestErr) {
    best = circle.prim;
    bestErr = circle.err;
  }
  if (Math.abs(w - h) > 1) {
    const ell = fitEllipse(pts, n2, b, w, h, area);
    if (ell && ell.err <= maxError && ell.err < bestErr) {
      best = ell.prim;
      bestErr = ell.err;
    }
  }
  return best;
}
function primitiveSvg(prim, attrs, precision = 2) {
  const r = (v) => round2(v, precision);
  switch (prim.kind) {
    case "circle":
      return `<circle cx="${r(prim.cx)}" cy="${r(prim.cy)}" r="${r(prim.r)}"${attrs}/>`;
    case "ellipse":
      return `<ellipse cx="${r(prim.cx)}" cy="${r(prim.cy)}" rx="${r(prim.rx)}" ry="${r(prim.ry)}"${attrs}/>`;
    case "rect":
      return `<rect x="${r(prim.x)}" y="${r(prim.y)}" width="${r(prim.w)}" height="${r(prim.h)}"${attrs}/>`;
  }
}
function fitRect(pts, n2, b, w, h, area) {
  if (area < 0.95 * w * h) return null;
  let err = 0;
  for (let i = 0; i < n2; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    const d = Math.min(x - b.minX, b.maxX - x, y - b.minY, b.maxY - y);
    if (d > err) err = d;
  }
  return { prim: { kind: "rect", x: b.minX, y: b.minY, w, h }, err };
}
function fitCircle(pts, n2, area) {
  if (n2 < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n2; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const sol = solve32(
    sxx,
    sxy,
    sx,
    sxy,
    syy,
    sy,
    sx,
    sy,
    n2,
    sxz,
    syz,
    sz
  );
  if (!sol) return null;
  const [A, B, C] = sol;
  const cx = A / 2, cy = B / 2;
  const rSq = C + cx * cx + cy * cy;
  if (rSq <= 0) return null;
  const r = Math.sqrt(rSq);
  if (area < 0.85 * Math.PI * r * r) return null;
  let maxRes = 0;
  for (let i = 0; i < n2; i++) {
    const dx = pts[i << 1] - cx, dy = pts[(i << 1) + 1] - cy;
    const res = Math.abs(Math.hypot(dx, dy) - r);
    if (res > maxRes) maxRes = res;
  }
  return { prim: { kind: "circle", cx, cy, r }, err: maxRes };
}
function fitEllipse(pts, n2, b, w, h, area) {
  if (n2 < 8) return null;
  const cx = b.minX + w / 2, cy = b.minY + h / 2;
  const rx = w / 2, ry = h / 2;
  if (rx < 1 || ry < 1) return null;
  if (area < 0.85 * Math.PI * rx * ry) return null;
  let maxRes = 0;
  for (let i = 0; i < n2; i++) {
    const px = pts[i << 1], py = pts[(i << 1) + 1];
    const nx = (px - cx) / rx, ny = (py - cy) / ry;
    const f = nx * nx + ny * ny - 1;
    const gx = 2 * (px - cx) / (rx * rx);
    const gy = 2 * (py - cy) / (ry * ry);
    const grad = Math.hypot(gx, gy);
    const res = grad > 1e-9 ? Math.abs(f) / grad : Math.abs(f);
    if (res > maxRes) maxRes = res;
  }
  return { prim: { kind: "ellipse", cx, cy, rx, ry }, err: maxRes };
}
function bbox(pts, n2) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n2; i++) {
    const x = pts[i << 1], y = pts[(i << 1) + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
function shoelace(pts, n2) {
  let a = 0;
  for (let i = 0, j = n2 - 1; i < n2; j = i++) {
    const xi = pts[i << 1], yi = pts[(i << 1) + 1];
    const xj = pts[j << 1], yj = pts[(j << 1) + 1];
    a += xj * yi - xi * yj;
  }
  return a / 2;
}
function solve32(a, b, c, d, e, f, g, h, i, u, v, w) {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const dx = u * (e * i - f * h) - b * (v * i - f * w) + c * (v * h - e * w);
  const dy = a * (v * i - f * w) - u * (d * i - f * g) + c * (d * w - v * g);
  const dz = a * (e * w - v * h) - b * (d * w - v * g) + u * (d * h - e * g);
  return [dx / det, dy / det, dz / det];
}
function round2(value, precision) {
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

// src/vectorize/trace.ts
var TRACE_DEFAULTS = {
  colors: 16,
  alphaLevels: 8,
  minArea: 0,
  // 0.4, not 1.0. A measured diagnosis (scripts/diagnose-photo.mjs) found the
  // curve fitter, not quantisation, is the dominant loss on photographs — 0.11
  // to 0.24 SSIM — and that a 1px tolerance is *strictly worse* than 0.4 on
  // both accuracy and file size across flat art, logos and photos. The old
  // default's curves drifted up to a pixel and flipped boundary pixels while
  // producing *larger* files than a tighter fit. The one thing a large
  // tolerance buys — few smooth curves on a big arc — is preserved by the
  // `logo`/`lineart` presets, which keep a higher value on purpose.
  tolerance: 0.4,
  fitError: 0.4,
  cornerAngle: 75,
  polygonOnly: false,
  primitives: false,
  primitiveError: 1,
  optimize: true,
  precision: 2,
  background: true,
  refineIterations: 4,
  strokeWidth: 0,
  groupByColor: false,
  turnPolicy: "left",
  gradients: false,
  gradientMinArea: 0,
  gradientStepMax: 0.08,
  gradientMargin: 0.1,
  gradientMaxError: 0.1,
  gradientStops: 16
};
function autoMinArea(pixels) {
  return Math.min(16, Math.round(pixels / 5e4));
}
function trace(source, opts = {}) {
  const clean = stripUndefined(opts);
  const o = {
    ...TRACE_DEFAULTS,
    minArea: autoMinArea(source.width * source.height),
    ...clean
  };
  let img = source;
  if (o.blur && o.blur >= 1) {
    img = selectiveBlur(img, { radius: o.blur, delta: o.blurDelta });
  }
  if (opts.threshold !== void 0) {
    img = applyThreshold(img, { threshold: o.threshold, blackOnWhite: o.blackOnWhite }).image;
  }
  const { width, height } = img;
  const n2 = width * height;
  const alphaLevels = quantizeAlpha(img, Math.max(1, o.alphaLevels));
  const palette = quantize(img, o.colors, {
    refineIterations: o.refineIterations,
    fillStrategy: o.fillStrategy,
    fixedPalette: o.fixedPalette
  });
  const nearest = new NearestColor(palette, n2);
  const levelCount = alphaLevels.length;
  let classes = new Int32Array(n2);
  let hasVoid = false;
  for (let i = 0; i < n2; i++) {
    const off = i * 4;
    const aIdx = nearestLevel(alphaLevels, img.data[off + 3]);
    if (alphaLevels[aIdx] === 0) {
      classes[i] = -1;
      hasVoid = true;
      continue;
    }
    const cIdx = nearest.index(img.data[off], img.data[off + 1], img.data[off + 2]);
    classes[i] = cIdx * levelCount + aIdx;
  }
  let gradientPaints = null;
  if (o.gradients) {
    const g = detectGradients(img, classes, palette, alphaLevels, levelCount, width, height, {
      gradients: o.gradients,
      gradientMinArea: o.gradientMinArea,
      gradientStepMax: o.gradientStepMax,
      gradientMargin: o.gradientMargin,
      gradientMaxError: o.gradientMaxError,
      gradientStops: o.gradientStops
    });
    classes = g.classes;
    gradientPaints = g.paints.size > 0 ? g.paints : null;
  }
  let comps = connectedComponents(classes, width, height, -1);
  let despeckled = 0;
  if (o.minArea > 1) {
    for (let pass = 0; pass < 2; pass++) {
      const merged = despeckle(classes, comps, width, height, o.minArea, -1);
      if (merged === 0) break;
      despeckled += merged;
      comps = connectedComponents(classes, width, height, -1);
    }
  }
  const loopsByComponent = traceComponents(comps.labels, width, height, comps.count, o.turnPolicy);
  const classArea = /* @__PURE__ */ new Map();
  const classComponents = /* @__PURE__ */ new Map();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    classArea.set(cls, (classArea.get(cls) ?? 0) + comps.areas[c]);
    let list = classComponents.get(cls);
    if (!list) {
      list = [];
      classComponents.set(cls, list);
    }
    list.push(c);
  }
  const orderedClasses = [...classArea.keys()].sort(
    (a, b) => (classArea.get(b) ?? 0) - (classArea.get(a) ?? 0) || a - b
  );
  const doc = new SvgDoc({
    width,
    height,
    generator: o.generator,
    title: o.title
  });
  const backgroundClass = o.background && !hasVoid && orderedClasses.length > 1 && orderedClasses[0] < GRAD_BASE ? orderedClasses[0] : -1;
  if (backgroundClass >= 0) {
    const bg = classColor(backgroundClass, palette, alphaLevels, levelCount);
    if (o.groupByColor) {
      doc.addLayer(
        `${shortHex(bg.r, bg.g, bg.b)} (background)`,
        "layer-background",
        `<path d="M0 0h${width}v${height}H0z"${fillAttrs(bg)}/>`
      );
    } else {
      doc.addBackground(bg);
    }
  }
  const fitOpts = {
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    polygonOnly: o.polygonOnly,
    optimize: o.optimize,
    optimizeError: o.optimizeError,
    rightAngleEnhance: o.rightAngleEnhance,
    rightAngleThreshold: o.rightAngleThreshold
  };
  const strokeFor = (svgColor) => o.strokeWidth > 0 ? ` stroke="${svgColor}" stroke-width="${o.strokeWidth}"` : "";
  let regions = 0;
  for (const cls of orderedClasses) {
    const components = classComponents.get(cls);
    regions += components.length;
    if (cls === backgroundClass) continue;
    const path = new PathBuilder(o.precision);
    const classLoops = [];
    for (const c of components) {
      for (const loop of loopsByComponent[c]) {
        classLoops.push(loop);
        const fitted = fitLoop(loop.pts, fitOpts);
        if (!fitted) continue;
        path.moveTo(fitted.start.x, fitted.start.y);
        for (const seg of fitted.segments) {
          if (seg.kind === "line") path.lineTo(seg.x, seg.y);
          else path.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
        }
        path.close();
      }
    }
    if (path.isEmpty()) continue;
    let markup;
    let label;
    const paint = gradientPaints?.get(cls);
    if (paint) {
      doc.addDef(paint.def);
      const op = paint.alpha < 1 ? ` fill-opacity="${+paint.alpha.toFixed(3)}"` : "";
      markup = `<path fill-rule="evenodd" d="${path.toString()}" fill="${paint.ref}"${op}/>`;
      label = paint.ref.replace(/^url\(#/, "").replace(/\)$/, "");
    } else {
      const color = classColor(cls, palette, alphaLevels, levelCount);
      const stroke = strokeFor(shortHex(color.r, color.g, color.b));
      const prim = o.primitives && classLoops.length === 1 ? detectPrimitive(classLoops[0].pts, { maxError: o.primitiveError }) : null;
      markup = prim ? primitiveSvg(prim, `${fillAttrs(color)}${stroke}`, o.precision) : `<path fill-rule="evenodd" d="${path.toString()}"${fillAttrs(color)}${stroke}/>`;
      label = color.a < 255 ? `${shortHex(color.r, color.g, color.b)}@${color.a}` : shortHex(color.r, color.g, color.b);
    }
    if (o.groupByColor) {
      doc.addLayer(label, `layer-${cls}`, markup);
    } else {
      doc.add(markup);
    }
  }
  return {
    svg: doc.toString(),
    shapes: doc.childCount,
    colors: classArea.size,
    regions,
    despeckled
  };
}
function traceSeparations(source, opts = {}) {
  const { svg } = trace(source, { ...opts, groupByColor: true });
  const open = svg.match(/<svg [^>]*>/)?.[0] ?? '<svg xmlns="http://www.w3.org/2000/svg">';
  const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "";
  const out = [];
  const re = /<g inkscape:groupmode="layer" inkscape:label="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    out.push({ color: m[1], svg: `${open}${defs}${m[2]}</svg>
` });
  }
  return out;
}
function classColor(cls, palette, alphaLevels, levelCount) {
  const colorIdx = Math.floor(cls / levelCount);
  const alphaIdx = cls % levelCount;
  return {
    r: palette.rgb[colorIdx * 3],
    g: palette.rgb[colorIdx * 3 + 1],
    b: palette.rgb[colorIdx * 3 + 2],
    a: alphaLevels[alphaIdx]
  };
}
function nearestLevel(levels, value) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i] - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    } else if (d > bestD) break;
  }
  return best;
}
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== void 0) out[k] = v;
  }
  return out;
}

// src/vectorize/centerline.ts
var NBRS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
];
function centerlinePolylines(image, opts = {}) {
  const { width, height } = image;
  const cutoff = opts.threshold === void 0 || opts.threshold === "auto" ? otsuThreshold(image) : opts.threshold;
  const blackOnWhite = opts.blackOnWhite ?? true;
  const P = width + 2, Q = height + 2;
  const mask = new Uint8Array(P * Q);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (image.data[o + 3] < 8) continue;
      const lum = luma709(image.data[o], image.data[o + 1], image.data[o + 2]);
      const fg = blackOnWhite ? lum <= cutoff : lum > cutoff;
      if (fg) mask[(y + 1) * P + (x + 1)] = 1;
    }
  }
  zhangSuenThin(mask, P, Q);
  const raw = walkSkeleton(mask, P, Q);
  const minLength = opts.minLength ?? 3;
  const eps = opts.simplify ?? 1;
  const out = [];
  for (const poly of raw) {
    const shifted = poly.map((p) => ({ x: p.x - 1, y: p.y - 1 }));
    const simplified = eps > 0 ? simplify(shifted, eps) : shifted;
    if (simplified.length < 2 || polylineLength(simplified) < minLength) continue;
    out.push(simplified);
  }
  return out;
}
function centerlineTrace(image, opts = {}) {
  const { width, height } = image;
  const polylines = centerlinePolylines(image, opts);
  const doc = new SvgDoc({ width, height, generator: opts.generator, title: opts.title });
  const stroke = opts.stroke ?? "#000";
  const strokeWidth = opts.strokeWidth ?? 1;
  for (const poly of polylines) {
    const path = new PathBuilder(opts.precision ?? 2);
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
    doc.add(
      `<path fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" d="${path.toString()}"/>`
    );
  }
  return { svg: doc.toString(), paths: polylines.length };
}
function zhangSuenThin(m, P, Q) {
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < Q - 1; y++) {
        for (let x = 1; x < P - 1; x++) {
          const i = y * P + x;
          if (!m[i]) continue;
          const p2 = m[i - P], p3 = m[i - P + 1], p4 = m[i + 1], p5 = m[i + P + 1];
          const p6 = m[i + P], p7 = m[i + P - 1], p8 = m[i - 1], p9 = m[i - P - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          del.push(i);
        }
      }
      if (del.length > 0) {
        changed = true;
        for (const i of del) m[i] = 0;
      }
    }
  }
}
var RING_CW = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1]
];
function walkSkeleton(m, P, Q) {
  const fg = (x, y) => m[y * P + x] === 1;
  const crossing = (x, y) => {
    let c = 0;
    for (let k = 0; k < 8; k++) {
      const a = fg(x + RING_CW[k][0], y + RING_CW[k][1]) ? 1 : 0;
      const b = fg(x + RING_CW[(k + 1) % 8][0], y + RING_CW[(k + 1) % 8][1]) ? 1 : 0;
      if (a === 0 && b === 1) c++;
    }
    return c;
  };
  const used = /* @__PURE__ */ new Set();
  const edgeKey = (ax, ay, bx, by) => {
    const a = ay * P + ax, b = by * P + bx;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return lo * P * Q + hi;
  };
  const allowed = (ax, ay, bx, by) => {
    if (Math.abs(ax - bx) === 1 && Math.abs(ay - by) === 1) {
      return !(fg(ax, by) || fg(bx, ay));
    }
    return true;
  };
  const walk = (sx, sy) => {
    const pts = [{ x: sx, y: sy }];
    let cx = sx, cy = sy;
    for (; ; ) {
      let next = null;
      for (const [dx, dy] of NBRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!fg(nx, ny) || !allowed(cx, cy, nx, ny)) continue;
        const key = edgeKey(cx, cy, nx, ny);
        if (used.has(key)) continue;
        next = [nx, ny, key];
        break;
      }
      if (!next) break;
      used.add(next[2]);
      cx = next[0];
      cy = next[1];
      pts.push({ x: cx, y: cy });
      if (crossing(cx, cy) !== 2) break;
    }
    return pts;
  };
  const out = [];
  const hasUnusedEdge = (x, y) => {
    for (const [dx, dy] of NBRS) {
      const nx = x + dx, ny = y + dy;
      if (fg(nx, ny) && allowed(x, y, nx, ny) && !used.has(edgeKey(x, y, nx, ny))) return true;
    }
    return false;
  };
  for (let y = 1; y < Q - 1; y++) {
    for (let x = 1; x < P - 1; x++) {
      if (!fg(x, y)) continue;
      if (crossing(x, y) === 2) continue;
      while (hasUnusedEdge(x, y)) {
        const poly = walk(x, y);
        if (poly.length >= 2) out.push(poly);
      }
    }
  }
  for (let y = 1; y < Q - 1; y++) {
    for (let x = 1; x < P - 1; x++) {
      if (fg(x, y) && hasUnusedEdge(x, y)) {
        const poly = walk(x, y);
        if (poly.length >= 2) out.push(poly);
      }
    }
  }
  return out;
}
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = -1, worstDist = eps;
    const ax = pts[first].x, ay = pts[first].y;
    const bx = pts[last].x, by = pts[last].y;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    for (let i = first + 1; i < last; i++) {
      const dist = len === 0 ? Math.hypot(pts[i].x - ax, pts[i].y - ay) : Math.abs(dy * pts[i].x - dx * pts[i].y + bx * ay - by * ax) / len;
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

// src/io/formats/bytes.ts
function u16le(b, o) {
  return (b[o] ?? 0) | (b[o + 1] ?? 0) << 8;
}
function u16be(b, o) {
  return (b[o] ?? 0) << 8 | (b[o + 1] ?? 0);
}
function u32le(b, o) {
  return (((b[o] ?? 0) | (b[o + 1] ?? 0) << 8 | (b[o + 2] ?? 0) << 16) >>> 0) + (b[o + 3] ?? 0) * 16777216;
}
function i32le(b, o) {
  return (b[o] ?? 0) | (b[o + 1] ?? 0) << 8 | (b[o + 2] ?? 0) << 16 | (b[o + 3] ?? 0) << 24;
}
function latin1(b, start, end) {
  let out = "";
  const stop = Math.min(end, b.length);
  for (let i = start; i < stop; i++) out += String.fromCharCode(b[i]);
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes) {
  let out = "";
  const n2 = bytes.length;
  const remainder = n2 % 3;
  const limit = n2 - remainder;
  for (let i = 0; i < limit; i += 3) {
    const triple = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += BASE64_ALPHABET[triple >> 18 & 63] + BASE64_ALPHABET[triple >> 12 & 63] + BASE64_ALPHABET[triple >> 6 & 63] + BASE64_ALPHABET[triple & 63];
  }
  if (remainder === 1) {
    const chunk = bytes[limit];
    out += BASE64_ALPHABET[chunk >> 2] + BASE64_ALPHABET[chunk << 4 & 63] + "==";
  } else if (remainder === 2) {
    const chunk = bytes[limit] << 8 | bytes[limit + 1];
    out += BASE64_ALPHABET[chunk >> 10] + BASE64_ALPHABET[chunk >> 4 & 63] + BASE64_ALPHABET[chunk << 2 & 63] + "=";
  }
  return out;
}
var BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();
function fromBase64(text) {
  let symbols = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 && BASE64_LOOKUP[c] >= 0) symbols++;
  }
  const out = new Uint8Array(Math.floor(symbols * 3 / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) continue;
    const value = BASE64_LOOKUP[c];
    if (value < 0) continue;
    accumulator = accumulator << 6 | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = accumulator >> bits & 255;
    }
  }
  return written === out.length ? out : out.subarray(0, written);
}

// src/io/formats/bmp.ts
var BI_RGB = 0;
var BI_RLE8 = 1;
var BI_RLE4 = 2;
var BI_BITFIELDS = 3;
var BI_JPEG = 4;
var BI_PNG = 5;
function isBmp(bytes) {
  return bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77;
}
function decodeBmp(bytes, embedded = false) {
  let dibOffset;
  let dataOffset;
  if (embedded) {
    dibOffset = 0;
    dataOffset = -1;
  } else {
    if (!isBmp(bytes)) throw new Error("Not a BMP file");
    dibOffset = 14;
    dataOffset = u32le(bytes, 10);
  }
  const dibSize = u32le(bytes, dibOffset);
  let width;
  let storedHeight;
  let bitCount;
  let compression = BI_RGB;
  let paletteCount = 0;
  if (dibSize === 12) {
    width = u16le(bytes, dibOffset + 4) << 16 >> 16;
    storedHeight = u16le(bytes, dibOffset + 6) << 16 >> 16;
    bitCount = u16le(bytes, dibOffset + 10);
  } else if (dibSize >= 40) {
    width = i32le(bytes, dibOffset + 4);
    storedHeight = i32le(bytes, dibOffset + 8);
    bitCount = u16le(bytes, dibOffset + 14);
    compression = u32le(bytes, dibOffset + 16);
    paletteCount = u32le(bytes, dibOffset + 32);
  } else {
    throw new Error(`Unsupported BMP header size ${dibSize}`);
  }
  if (compression === BI_JPEG || compression === BI_PNG) {
    const start = dataOffset >= 0 ? dataOffset : dibOffset + dibSize;
    return {
      image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
      bitDepth: bitCount,
      delegate: {
        format: compression === BI_PNG ? "png" : "jpeg",
        bytes: bytes.subarray(start)
      }
    };
  }
  const topDown = storedHeight < 0;
  let height = Math.abs(storedHeight);
  if (embedded) height = Math.floor(height / 2);
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw new Error(`Implausible BMP dimensions ${width}x${height}`);
  }
  let maskOffset = dibOffset + dibSize;
  let masks = null;
  if (compression === BI_BITFIELDS) {
    if (dibSize === 40) {
      masks = [
        u32le(bytes, maskOffset),
        u32le(bytes, maskOffset + 4),
        u32le(bytes, maskOffset + 8),
        0
      ];
      maskOffset += 12;
    } else {
      masks = [
        u32le(bytes, dibOffset + 40),
        u32le(bytes, dibOffset + 44),
        u32le(bytes, dibOffset + 48),
        dibSize >= 56 ? u32le(bytes, dibOffset + 52) : 0
      ];
    }
  }
  const entrySize = dibSize === 12 ? 3 : 4;
  const indexed = bitCount <= 8;
  if (indexed && paletteCount === 0) paletteCount = 1 << bitCount;
  const paletteOffset = maskOffset;
  const palette = indexed ? readPalette(bytes, paletteOffset, paletteCount, entrySize) : null;
  if (dataOffset < 0) {
    dataOffset = paletteOffset + (indexed ? paletteCount * entrySize : 0);
  }
  const image = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
  if (compression === BI_RLE8 || compression === BI_RLE4) {
    decodeRle(bytes, dataOffset, image, palette, compression === BI_RLE4, topDown);
  } else {
    decodePacked(bytes, dataOffset, image, bitCount, palette, masks, topDown);
  }
  if (embedded) applyAndMask(bytes, dataOffset, image, bitCount);
  else if (bitCount === 32 && compression === BI_RGB) assumeOpaqueIfNoAlpha(image);
  return { image, bitDepth: bitCount };
}
function readPalette(bytes, offset, count, entrySize) {
  const palette = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = offset + i * entrySize;
    if (o + 2 >= bytes.length) break;
    palette[i * 4] = bytes[o + 2];
    palette[i * 4 + 1] = bytes[o + 1];
    palette[i * 4 + 2] = bytes[o];
    palette[i * 4 + 3] = 255;
  }
  return palette;
}
function decodePacked(bytes, dataOffset, image, bitCount, palette, masks, topDown) {
  const { width, height, data } = image;
  const rowSize = Math.ceil(width * bitCount / 32) * 4;
  const shifts = masks ? masks.map(maskShift) : null;
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcRow * rowSize;
    if (rowStart >= bytes.length) break;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      switch (bitCount) {
        case 1:
        case 4:
        case 8: {
          const bitPos = x * bitCount;
          const byte = bytes[rowStart + (bitPos >> 3)];
          if (byte === void 0) continue;
          const shift = 8 - bitCount - (bitPos & 7);
          const index = byte >> shift & (1 << bitCount) - 1;
          const p = index * 4;
          r = palette[p];
          g = palette[p + 1];
          b = palette[p + 2];
          break;
        }
        case 16: {
          const o = rowStart + x * 2;
          if (o + 1 >= bytes.length) continue;
          const v = u16le(bytes, o);
          if (masks && shifts) {
            r = scaleChannel(v, masks[0], shifts[0]);
            g = scaleChannel(v, masks[1], shifts[1]);
            b = scaleChannel(v, masks[2], shifts[2]);
            if (masks[3]) a = scaleChannel(v, masks[3], shifts[3]);
          } else {
            r = expand5(v >> 10 & 31);
            g = expand5(v >> 5 & 31);
            b = expand5(v & 31);
          }
          break;
        }
        case 24: {
          const o = rowStart + x * 3;
          if (o + 2 >= bytes.length) continue;
          b = bytes[o];
          g = bytes[o + 1];
          r = bytes[o + 2];
          break;
        }
        case 32: {
          const o = rowStart + x * 4;
          if (o + 3 >= bytes.length) continue;
          if (masks && shifts) {
            const v = u32le(bytes, o);
            r = scaleChannel(v, masks[0], shifts[0]);
            g = scaleChannel(v, masks[1], shifts[1]);
            b = scaleChannel(v, masks[2], shifts[2]);
            a = masks[3] ? scaleChannel(v, masks[3], shifts[3]) : 255;
          } else {
            b = bytes[o];
            g = bytes[o + 1];
            r = bytes[o + 2];
            a = bytes[o + 3];
          }
          break;
        }
        default:
          throw new Error(`Unsupported BMP bit depth ${bitCount}`);
      }
      data[out] = r;
      data[out + 1] = g;
      data[out + 2] = b;
      data[out + 3] = a;
    }
  }
}
function decodeRle(bytes, dataOffset, image, palette, is4Bit, topDown) {
  const { width, height, data } = image;
  let p = dataOffset;
  let x = 0;
  let y = 0;
  const put = (index) => {
    if (x >= width || y >= height) return;
    const row = topDown ? y : height - 1 - y;
    const out = (row * width + x) * 4;
    const q = index * 4;
    data[out] = palette[q];
    data[out + 1] = palette[q + 1];
    data[out + 2] = palette[q + 2];
    data[out + 3] = 255;
    x++;
  };
  while (p + 1 < bytes.length && y < height) {
    const count = bytes[p++];
    const value = bytes[p++];
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        put(is4Bit ? i % 2 === 0 ? value >> 4 : value & 15 : value);
      }
      continue;
    }
    if (value === 0) {
      x = 0;
      y++;
    } else if (value === 1) break;
    else if (value === 2) {
      x += bytes[p++] ?? 0;
      y += bytes[p++] ?? 0;
    } else {
      if (is4Bit) {
        for (let i = 0; i < value; i++) {
          const byte = bytes[p + (i >> 1)];
          if (byte === void 0) break;
          put(i % 2 === 0 ? byte >> 4 : byte & 15);
        }
        p += Math.ceil(value / 2);
      } else {
        for (let i = 0; i < value; i++) {
          if (bytes[p + i] === void 0) break;
          put(bytes[p + i]);
        }
        p += value;
      }
      if (p & 1) p++;
    }
  }
}
function applyAndMask(bytes, dataOffset, image, bitCount) {
  const { width, height, data } = image;
  if (bitCount === 32 && hasAnyAlpha(image)) return;
  const colorRowSize = Math.ceil(width * bitCount / 32) * 4;
  const maskOffset = dataOffset + colorRowSize * height;
  const maskRowSize = Math.ceil(width / 32) * 4;
  if (maskOffset + maskRowSize * height > bytes.length) {
    if (bitCount === 32) assumeOpaqueIfNoAlpha(image);
    return;
  }
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const rowStart = maskOffset + srcRow * maskRowSize;
    for (let x = 0; x < width; x++) {
      const byte = bytes[rowStart + (x >> 3)];
      if (byte === void 0) continue;
      const transparent = byte >> 7 - (x & 7) & 1;
      if (transparent) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}
function hasAnyAlpha(image) {
  const d = image.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 0) return true;
  return false;
}
function assumeOpaqueIfNoAlpha(image) {
  if (hasAnyAlpha(image)) return;
  const d = image.data;
  for (let o = 3; o < d.length; o += 4) d[o] = 255;
}
function maskShift(mask) {
  if (mask === 0) return 0;
  let shift = 0;
  while ((mask >>> shift & 1) === 0) shift++;
  return shift;
}
function scaleChannel(value, mask, shift) {
  if (mask === 0) return 0;
  const field = (value & mask) >>> shift;
  const max = mask >>> shift;
  return max === 0 ? 0 : Math.round(field * 255 / max);
}
function expand5(v) {
  return v << 3 | v >> 2;
}

// src/io/formats/ico.ts
var PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function isIco(bytes) {
  if (bytes.length < 6) return false;
  if (u16le(bytes, 0) !== 0) return false;
  const type = u16le(bytes, 2);
  if (type !== 1 && type !== 2) return false;
  const count = u16le(bytes, 4);
  return count > 0 && bytes.length >= 6 + count * 16;
}
function listIcoEntries(bytes) {
  const count = u16le(bytes, 4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > bytes.length) break;
    const width = bytes[o] === 0 ? 256 : bytes[o];
    const height = bytes[o + 1] === 0 ? 256 : bytes[o + 1];
    const bitCount = u16le(bytes, o + 6);
    const length = u32le(bytes, o + 8);
    const offset = u32le(bytes, o + 12);
    if (offset + length > bytes.length) continue;
    entries.push({
      width,
      height,
      bitCount,
      offset,
      length,
      isPng: bytesEqual(bytes.subarray(offset, offset + 8), PNG_SIGNATURE)
    });
  }
  return entries;
}
function decodeIco(bytes, index) {
  if (!isIco(bytes)) throw new Error("Not an ICO/CUR file");
  const entries = listIcoEntries(bytes);
  if (entries.length === 0) throw new Error("ICO contains no usable entries");
  const chosen = index !== void 0 ? entries[index] : [...entries].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount
  )[0];
  if (!chosen) throw new Error(`ICO has no entry at index ${index}`);
  const payload = bytes.subarray(chosen.offset, chosen.offset + chosen.length);
  if (chosen.isPng) {
    return { delegate: payload, entry: chosen, entries };
  }
  const { image } = decodeBmp(payload, true);
  return { image, entry: chosen, entries };
}

// src/io/formats/pnm.ts
function isPnm(bytes) {
  return bytes.length > 2 && bytes[0] === 80 && bytes[1] >= 49 && bytes[1] <= 54;
}
function decodePnm(bytes) {
  if (!isPnm(bytes)) throw new Error("Not a Netpbm file");
  const variant = bytes[1] - 48;
  const reader = new HeaderReader(bytes, 2);
  const width = reader.nextInt();
  const height = reader.nextInt();
  const maxValue = variant === 1 || variant === 4 ? 1 : reader.nextInt();
  if (width <= 0 || height <= 0) throw new Error(`Implausible Netpbm dimensions ${width}x${height}`);
  if (maxValue <= 0 || maxValue > 65535) throw new Error(`Invalid Netpbm maxval ${maxValue}`);
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const wide = maxValue > 255;
  const scale = (v) => Math.round(v / maxValue * 255);
  if (variant <= 3) {
    const ascii = new HeaderReader(bytes, reader.offset);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      if (variant === 1) {
        const v = ascii.nextInt() ? 0 : 255;
        image.data[o] = v;
        image.data[o + 1] = v;
        image.data[o + 2] = v;
      } else if (variant === 2) {
        const v = scale(ascii.nextInt());
        image.data[o] = v;
        image.data[o + 1] = v;
        image.data[o + 2] = v;
      } else {
        image.data[o] = scale(ascii.nextInt());
        image.data[o + 1] = scale(ascii.nextInt());
        image.data[o + 2] = scale(ascii.nextInt());
      }
      image.data[o + 3] = 255;
    }
    return { image, bitDepth: wide ? 16 : 8, variant: `P${variant}` };
  }
  let p = reader.offset;
  if (variant === 4) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = bytes[p + y * rowBytes + (x >> 3)] ?? 0;
        const bit = byte >> 7 - (x & 7) & 1;
        const v = bit ? 0 : 255;
        const o = (y * width + x) * 4;
        image.data[o] = v;
        image.data[o + 1] = v;
        image.data[o + 2] = v;
        image.data[o + 3] = 255;
      }
    }
    return { image, bitDepth: 1, variant: "P4" };
  }
  const channels = variant === 5 ? 1 : 3;
  const step = wide ? 2 : 1;
  const read = (at) => wide ? u16be(bytes, at) : bytes[at] ?? 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const src = p + i * channels * step;
    if (src + channels * step > bytes.length) break;
    if (channels === 1) {
      const v = scale(read(src));
      image.data[o] = v;
      image.data[o + 1] = v;
      image.data[o + 2] = v;
    } else {
      image.data[o] = scale(read(src));
      image.data[o + 1] = scale(read(src + step));
      image.data[o + 2] = scale(read(src + step * 2));
    }
    image.data[o + 3] = 255;
  }
  return { image, bitDepth: wide ? 16 : 8, variant: `P${variant}` };
}
var HeaderReader = class {
  constructor(bytes, offset) {
    this.bytes = bytes;
    this.offset = offset;
  }
  nextInt() {
    this.skipSeparators();
    let value = 0;
    let digits = 0;
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset];
      if (c < 48 || c > 57) break;
      value = value * 10 + (c - 48);
      digits++;
      this.offset++;
    }
    if (digits === 0) throw new Error("Malformed Netpbm header: expected a number");
    if (this.offset < this.bytes.length && isSpace(this.bytes[this.offset])) this.offset++;
    return value;
  }
  skipSeparators() {
    for (; ; ) {
      while (this.offset < this.bytes.length && isSpace(this.bytes[this.offset])) this.offset++;
      if (this.bytes[this.offset] !== 35) return;
      while (this.offset < this.bytes.length && this.bytes[this.offset] !== 10) this.offset++;
    }
  }
};
function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}

// src/io/formats/tga.ts
var NO_IMAGE = 0;
var COLOR_MAPPED = 1;
var TRUE_COLOR = 2;
var GRAYSCALE = 3;
var RLE_COLOR_MAPPED = 9;
var RLE_TRUE_COLOR = 10;
var RLE_GRAYSCALE = 11;
var FOOTER = "TRUEVISION-XFILE.";
function isTga(bytes) {
  if (bytes.length < 18) return false;
  if (bytes.length >= 26) {
    const footer = latin1(bytes, bytes.length - 18, bytes.length - 1);
    if (footer === FOOTER) return true;
  }
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const depth = bytes[16];
  const width = u16le(bytes, 12);
  const height = u16le(bytes, 14);
  if (colorMapType > 1) return false;
  if (![NO_IMAGE, COLOR_MAPPED, TRUE_COLOR, GRAYSCALE, RLE_COLOR_MAPPED, RLE_TRUE_COLOR, RLE_GRAYSCALE].includes(imageType)) return false;
  if (imageType === NO_IMAGE) return false;
  if (![8, 15, 16, 24, 32].includes(depth)) return false;
  if (width === 0 || height === 0) return false;
  if ((imageType === COLOR_MAPPED || imageType === RLE_COLOR_MAPPED) !== (colorMapType === 1)) return false;
  const isRle = imageType >= RLE_COLOR_MAPPED;
  const idLength = bytes[0];
  const mapLength = u16le(bytes, 5);
  const mapEntrySize = bytes[7];
  const headerBytes = 18 + idLength + (colorMapType === 1 ? mapLength * Math.ceil(mapEntrySize / 8) : 0);
  const uncompressed = width * height * Math.ceil(depth / 8);
  return isRle ? bytes.length > headerBytes : bytes.length >= headerBytes + uncompressed;
}
function decodeTga(bytes) {
  if (bytes.length < 18) throw new Error("Truncated TGA header");
  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const mapFirst = u16le(bytes, 3);
  const mapLength = u16le(bytes, 5);
  const mapEntrySize = bytes[7];
  const width = u16le(bytes, 12);
  const height = u16le(bytes, 14);
  const depth = bytes[16];
  const descriptor = bytes[17];
  if (width === 0 || height === 0) throw new Error("TGA has zero dimensions");
  const topDown = (descriptor & 32) !== 0;
  const rightToLeft = (descriptor & 16) !== 0;
  let p = 18 + idLength;
  let colorMap = null;
  if (colorMapType === 1) {
    const entryBytes = Math.ceil(mapEntrySize / 8);
    colorMap = new Uint8Array((mapFirst + mapLength) * 4);
    for (let i = 0; i < mapLength; i++) {
      const o = p + i * entryBytes;
      const q = (mapFirst + i) * 4;
      const px = readPixel(bytes, o, mapEntrySize);
      colorMap[q] = px[0];
      colorMap[q + 1] = px[1];
      colorMap[q + 2] = px[2];
      colorMap[q + 3] = px[3];
    }
    p += mapLength * entryBytes;
  }
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const bytesPerPixel = Math.ceil(depth / 8);
  const isRle = imageType >= RLE_COLOR_MAPPED;
  const isMapped = imageType === COLOR_MAPPED || imageType === RLE_COLOR_MAPPED;
  const isGray = imageType === GRAYSCALE || imageType === RLE_GRAYSCALE;
  const total = width * height;
  const pixels = new Uint8Array(total * 4);
  const emit2 = (at, source) => {
    const q = at * 4;
    if (isMapped) {
      const index = depth === 8 ? bytes[source] : u16le(bytes, source);
      const m = index * 4;
      pixels[q] = colorMap[m];
      pixels[q + 1] = colorMap[m + 1];
      pixels[q + 2] = colorMap[m + 2];
      pixels[q + 3] = colorMap[m + 3];
    } else if (isGray) {
      const v = bytes[source];
      pixels[q] = v;
      pixels[q + 1] = v;
      pixels[q + 2] = v;
      pixels[q + 3] = depth === 16 ? bytes[source + 1] : 255;
    } else {
      const px = readPixel(bytes, source, depth);
      pixels[q] = px[0];
      pixels[q + 1] = px[1];
      pixels[q + 2] = px[2];
      pixels[q + 3] = px[3];
    }
  };
  if (isRle) {
    let written = 0;
    while (written < total && p < bytes.length) {
      const packet = bytes[p++];
      const count = (packet & 127) + 1;
      if (packet & 128) {
        for (let i = 0; i < count && written < total; i++) emit2(written++, p);
        p += bytesPerPixel;
      } else {
        for (let i = 0; i < count && written < total; i++) {
          emit2(written++, p);
          p += bytesPerPixel;
        }
      }
    }
  } else {
    for (let i = 0; i < total; i++) {
      const o = p + i * bytesPerPixel;
      if (o + bytesPerPixel > bytes.length) break;
      emit2(i, o);
    }
  }
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcX = rightToLeft ? width - 1 - x : x;
      const from = (srcY * width + srcX) * 4;
      const to = (y * width + x) * 4;
      image.data[to] = pixels[from];
      image.data[to + 1] = pixels[from + 1];
      image.data[to + 2] = pixels[from + 2];
      image.data[to + 3] = pixels[from + 3];
    }
  }
  return { image, bitDepth: depth };
}
function readPixel(bytes, offset, depth) {
  switch (depth) {
    case 8: {
      const v = bytes[offset] ?? 0;
      return [v, v, v, 255];
    }
    case 15:
    case 16: {
      const v = u16le(bytes, offset);
      const r = v >> 10 & 31, g = v >> 5 & 31, b = v & 31;
      const a = depth === 16 && (v & 32768) === 0 ? 0 : 255;
      return [r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2, a];
    }
    case 24:
      return [bytes[offset + 2] ?? 0, bytes[offset + 1] ?? 0, bytes[offset] ?? 0, 255];
    case 32:
      return [bytes[offset + 2] ?? 0, bytes[offset + 1] ?? 0, bytes[offset] ?? 0, bytes[offset + 3] ?? 255];
    default:
      throw new Error(`Unsupported TGA bit depth ${depth}`);
  }
}

// src/io/formats/encoders.ts
var OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 255 };
function isOpaque2(img) {
  const d = img.data;
  for (let o = 3; o < d.length; o += 4) if (d[o] !== 255) return false;
  return true;
}
function flattenPixel(d, o, bg) {
  const a = d[o + 3] / 255;
  if (a === 1) return [d[o], d[o + 1], d[o + 2]];
  const inv = 1 - a;
  return [
    Math.round(d[o] * a + bg.r * inv),
    Math.round(d[o + 1] * a + bg.g * inv),
    Math.round(d[o + 2] * a + bg.b * inv)
  ];
}
function encodeBmp(img, opts = {}) {
  const { width, height, data } = img;
  const withAlpha = opts.bitDepth ? opts.bitDepth === 32 : !isOpaque2(img);
  const bg = opts.background ?? OPAQUE_WHITE;
  const bitsPerPixel = withAlpha ? 32 : 24;
  const headerSize = withAlpha ? 108 : 40;
  const rowSize = Math.ceil(width * bitsPerPixel / 32) * 4;
  const pixelBytes = rowSize * height;
  const offset = 14 + headerSize;
  const out = new Uint8Array(offset + pixelBytes);
  const view = new DataView(out.buffer);
  out[0] = 66;
  out[1] = 77;
  view.setUint32(2, out.length, true);
  view.setUint32(10, offset, true);
  view.setUint32(14, headerSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, bitsPerPixel, true);
  view.setUint32(30, withAlpha ? 3 : 0, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  if (withAlpha) {
    view.setUint32(54, 16711680, true);
    view.setUint32(58, 65280, true);
    view.setUint32(62, 255, true);
    view.setUint32(66, 4278190080, true);
    view.setUint32(70, 1934772034, true);
  }
  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (sourceRow * width + x) * 4;
      const o = offset + y * rowSize + x * (bitsPerPixel / 8);
      if (withAlpha) {
        out[o] = data[s + 2];
        out[o + 1] = data[s + 1];
        out[o + 2] = data[s];
        out[o + 3] = data[s + 3];
      } else {
        const [r, g, b] = flattenPixel(data, s, bg);
        out[o] = b;
        out[o + 1] = g;
        out[o + 2] = r;
      }
    }
  }
  return out;
}
function encodePnm(img, opts = {}) {
  const { width, height, data } = img;
  const variant = opts.variant ?? "P6";
  const bg = opts.background ?? OPAQUE_WHITE;
  const pixels = width * height;
  const header = new TextEncoder().encode(
    variant === "P4" ? `P4
${width} ${height}
` : `${variant}
${width} ${height}
255
`
  );
  if (variant === "P4") {
    const threshold = opts.threshold ?? 128;
    const rowBytes = Math.ceil(width / 8);
    const out2 = new Uint8Array(header.length + rowBytes * height);
    out2.set(header);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = flattenPixel(data, (y * width + x) * 4, bg);
        if (0.2126 * r + 0.7152 * g + 0.0722 * b < threshold) {
          out2[header.length + y * rowBytes + (x >> 3)] |= 128 >> (x & 7);
        }
      }
    }
    return out2;
  }
  const channels = variant === "P6" ? 3 : 1;
  const out = new Uint8Array(header.length + pixels * channels);
  out.set(header);
  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = flattenPixel(data, i * 4, bg);
    const o = header.length + i * channels;
    if (channels === 3) {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    } else {
      out[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  return out;
}
function encodeTga(img, opts = {}) {
  const { width, height, data } = img;
  const depth = opts.bitDepth ?? (isOpaque2(img) ? 24 : 32);
  const bg = opts.background ?? OPAQUE_WHITE;
  const bytesPerPixel = depth / 8;
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  for (let i = 0; i < width * height; i++) {
    const s = i * 4;
    const o = i * bytesPerPixel;
    if (depth === 32) {
      pixels[o] = data[s + 2];
      pixels[o + 1] = data[s + 1];
      pixels[o + 2] = data[s];
      pixels[o + 3] = data[s + 3];
    } else {
      const [r, g, b] = flattenPixel(data, s, bg);
      pixels[o] = b;
      pixels[o + 1] = g;
      pixels[o + 2] = r;
    }
  }
  const body = opts.rle ? runLengthEncode(pixels, width, height, bytesPerPixel) : pixels;
  const out = new Uint8Array(18 + body.length + 26);
  const view = new DataView(out.buffer);
  out[2] = opts.rle ? 10 : 2;
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  out[16] = depth;
  out[17] = 32 | (depth === 32 ? 8 : 0);
  out.set(body, 18);
  const footer = 18 + body.length;
  out.set(new TextEncoder().encode("TRUEVISION-XFILE."), footer + 8);
  return out;
}
function runLengthEncode(pixels, width, height, bpp) {
  const chunks = [];
  const total = width * height;
  const samePixel = (a, b) => {
    for (let k = 0; k < bpp; k++) if (pixels[a * bpp + k] !== pixels[b * bpp + k]) return false;
    return true;
  };
  let i = 0;
  while (i < total) {
    const rowEnd = (Math.floor(i / width) + 1) * width;
    let run = 1;
    while (i + run < rowEnd && run < 128 && samePixel(i, i + run)) run++;
    if (run >= 2) {
      chunks.push(128 | run - 1);
      for (let k = 0; k < bpp; k++) chunks.push(pixels[i * bpp + k]);
      i += run;
      continue;
    }
    let raw = 1;
    while (i + raw < rowEnd && raw < 128 && !(i + raw + 1 < rowEnd && samePixel(i + raw, i + raw + 1))) raw++;
    chunks.push(raw - 1);
    for (let p = 0; p < raw; p++) {
      for (let k = 0; k < bpp; k++) chunks.push(pixels[(i + p) * bpp + k]);
    }
    i += raw;
  }
  return Uint8Array.from(chunks);
}
function encodeIco(entries) {
  if (entries.length === 0) throw new Error("An ICO needs at least one entry");
  if (entries.length > 255) throw new Error("An ICO cannot hold more than 255 entries");
  const directoryBytes = 6 + entries.length * 16;
  const total = directoryBytes + entries.reduce((sum, e) => sum + e.payload.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  let payloadOffset = directoryBytes;
  entries.forEach((entry, i) => {
    const o = 6 + i * 16;
    out[o] = entry.width >= 256 ? 0 : entry.width;
    out[o + 1] = entry.height >= 256 ? 0 : entry.height;
    out[o + 2] = 0;
    out[o + 3] = 0;
    view.setUint16(o + 4, 1, true);
    view.setUint16(o + 6, entry.bitCount ?? 32, true);
    view.setUint32(o + 8, entry.payload.length, true);
    view.setUint32(o + 12, payloadOffset, true);
    out.set(entry.payload, payloadOffset);
    payloadOffset += entry.payload.length;
  });
  return out;
}
function encodeIcoDib(img) {
  const { width, height, data } = img;
  const rowSize = Math.ceil(width * 32 / 32) * 4;
  const maskRowSize = Math.ceil(width / 32) * 4;
  const out = new Uint8Array(40 + rowSize * height + maskRowSize * height);
  const view = new DataView(out.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, rowSize * height, true);
  for (let y = 0; y < height; y++) {
    const sourceRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (sourceRow * width + x) * 4;
      const o = 40 + y * rowSize + x * 4;
      out[o] = data[s + 2];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s];
      out[o + 3] = data[s + 3];
      if (data[s + 3] === 0) {
        const m = 40 + rowSize * height + y * maskRowSize + (x >> 3);
        out[m] |= 128 >> (x & 7);
      }
    }
  }
  return out;
}

// src/io/formats/index.ts
function sniffFallbackFormat(bytes) {
  if (isBmp(bytes)) return "bmp";
  if (isIco(bytes)) return "ico";
  if (isPnm(bytes)) return "pnm";
  return null;
}
function decodeFallback(bytes) {
  const format = sniffFallbackFormat(bytes);
  if (!format) return null;
  switch (format) {
    case "bmp": {
      const { image, bitDepth, delegate } = decodeBmp(bytes);
      return delegate ? { format, bitDepth, channelDepth: 8, delegate } : { image, format, bitDepth, channelDepth: 8 };
    }
    case "ico": {
      const { image, delegate, entry, entries } = decodeIco(bytes);
      const detail = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}, using ${entry.width}x${entry.height}`;
      return delegate ? { format, bitDepth: entry.bitCount, channelDepth: 8, delegate: { format: "png", bytes: delegate }, detail } : { image, format, bitDepth: entry.bitCount, channelDepth: 8, detail };
    }
    case "pnm": {
      const { image, bitDepth, variant } = decodePnm(bytes);
      return { image, format, bitDepth, channelDepth: bitDepth, detail: variant };
    }
    default: {
      const exhaustive = format;
      throw new Error(`Unhandled fallback format: ${String(exhaustive)}`);
    }
  }
}
function decodeTgaFallback(bytes) {
  if (!isTga(bytes)) return null;
  try {
    const { image, bitDepth } = decodeTga(bytes);
    return { image, format: "tga", bitDepth, channelDepth: 8 };
  } catch {
    return null;
  }
}

// src/codecs.ts
var decoders = [];
var encoders = /* @__PURE__ */ new Map();
function registerDecoder(decoder) {
  decoders.unshift(decoder);
}
function registerEncoder(encoder) {
  encoders.set(encoder.format, encoder);
}
function unregisterDecoder(format) {
  const before = decoders.length;
  for (let i = decoders.length - 1; i >= 0; i--) {
    if (decoders[i].format === format) decoders.splice(i, 1);
  }
  return decoders.length !== before;
}
function unregisterEncoder(format) {
  return encoders.delete(format);
}
function findDecoder(bytes) {
  for (const d of decoders) {
    try {
      if (d.canDecode(bytes)) return d;
    } catch {
    }
  }
  return void 0;
}
function findEncoder(format) {
  return encoders.get(format);
}
function registeredFormats() {
  return {
    decode: [...new Set(decoders.map((d) => d.format))],
    encode: [...encoders.keys()]
  };
}

// src/emit/component.ts
function toComponent(svg, opts) {
  const name = opts.name ?? "Icon";
  const jsx = opts.framework === "react" || opts.framework === "solid";
  let body = svg.replace(/^<!--[\s\S]*?-->\n?/, "").replace(/\s(?:xmlns:(?:inkscape|sodipodi)|(?:inkscape|sodipodi):[\w-]+)="[^"]*"/gi, "").trim();
  if (opts.currentColor) {
    body = body.replace(/(\s(?:fill|stroke)=)"#[0-9a-fA-F]{3,8}"/g, '$1"currentColor"');
  }
  if (jsx) {
    body = body.replace(/\s(xlink:[a-z]+|xmlns:xlink)=/gi, (_m, a) => ` ${a.replace(/[:-]([a-z])/g, (_x, c) => c.toUpperCase())}=`).replace(/\s(?!data-|aria-)([a-z]+(?:-[a-z]+)+)=/g, (_m, attr) => ` ${attr.replace(/-([a-z])/g, (_x, c) => c.toUpperCase())}=`);
  }
  switch (opts.framework) {
    case "react":
      return renderReact(name, injectProps(body, "{...props}"), opts.typescript !== false);
    case "solid":
      return renderSolid(name, injectProps(body, "{...props}"), opts.typescript !== false);
    case "vue":
      return renderVue(name, injectProps(body, 'v-bind="$attrs"'));
    case "svelte":
      return renderSvelte(injectProps(body, "{...$$restProps}"));
  }
}
function injectProps(svg, expr) {
  return svg.replace(/^<svg\b/, (m) => `${m} ${expr}`);
}
function renderReact(name, svg, ts) {
  const sig = ts ? `export function ${name}(props: React.SVGProps<SVGSVGElement>) {` : `export function ${name}(props) {`;
  return `import * as React from 'react';

${sig}
  return (
    ${svg}
  );
}
`;
}
function renderSolid(name, svg, ts) {
  const imp = ts ? `import type { JSX } from 'solid-js';

` : "";
  const sig = ts ? `export function ${name}(props: JSX.SvgSVGAttributes<SVGSVGElement>) {` : `export function ${name}(props) {`;
  return `${imp}${sig}
  return (
    ${svg}
  );
}
`;
}
function renderVue(name, svg) {
  return `<script>
export default { name: ${JSON.stringify(name)}, inheritAttrs: false };
<\/script>

<template>
  ${svg}
</template>
`;
}
function renderSvelte(svg) {
  return `${svg}
`;
}

// src/emit/sprite.ts
function svgSprite(items, opts = {}) {
  const symbols = items.map(({ id, svg }) => {
    const viewBox = svg.match(/viewBox="([^"]*)"/)?.[1] ?? sizeToViewBox(svg) ?? "0 0 24 24";
    const inner = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<\?xml[\s\S]*?\?>/g, "").trim();
    return `<symbol id="${escapeAttr(id)}" viewBox="${viewBox}">${inner}</symbol>`;
  });
  const hide = opts.hidden === false ? "" : ' aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"';
  return `<svg xmlns="http://www.w3.org/2000/svg"${hide}>${symbols.join("")}</svg>
`;
}
function sizeToViewBox(svg) {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? svg;
  const attr = (name) => openTag.match(new RegExp(`[\\s"']${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, "i"))?.[1];
  const w = attr("width");
  const h = attr("height");
  return w && h ? `0 0 ${w} ${h}` : void 0;
}

// src/crop.ts
function smartCrop(image, opts = {}) {
  const { width: W, height: H } = image;
  const aspect = resolveAspect(opts);
  const minScale = clamp(opts.minScale ?? 0.6, 0.1, 1);
  const sizeWeight = opts.sizeWeight ?? 0.12;
  const centerWeight = opts.centerWeight ?? 0.25;
  const satWeight = opts.saturationWeight ?? 0.3;
  let maxW = W;
  let maxH = Math.round(maxW / aspect);
  if (maxH > H) {
    maxH = H;
    maxW = Math.round(maxH * aspect);
  }
  maxW = Math.min(maxW, W);
  maxH = Math.min(maxH, H);
  if (maxW < 1 || maxH < 1) {
    return { x: 0, y: 0, width: W, height: H, score: 0 };
  }
  const importance = importanceMap(image, satWeight);
  const integral = integralImage(importance, W, H);
  const grand = integral[H * (W + 1) + W];
  if (grand <= 1e-6) {
    return {
      x: Math.floor((W - maxW) / 2),
      y: Math.floor((H - maxH) / 2),
      width: maxW,
      height: maxH,
      score: 0
    };
  }
  const total = grand;
  const cx = W / 2;
  const cy = H / 2;
  const maxCenterDist = Math.hypot(cx, cy) || 1;
  let best = { x: 0, y: 0, width: maxW, height: maxH, score: -Infinity };
  const SCALE_STEPS = 6;
  for (let s = 0; s < SCALE_STEPS; s++) {
    const scale = 1 - (1 - minScale) * s / (SCALE_STEPS - 1);
    const winW = Math.max(1, Math.round(maxW * scale));
    const winH = Math.max(1, Math.round(maxH * scale));
    if (winW > W || winH > H) continue;
    const stepX = Math.max(1, Math.round(winW / 16));
    const stepY = Math.max(1, Math.round(winH / 16));
    for (let y = 0; y + winH <= H; y += stepY) {
      for (let x = 0; x + winW <= W; x += stepX) {
        const inside = rectSum(integral, W, x, y, winW, winH);
        const captured = inside / total;
        const area = winW * winH / (W * H);
        const winCx = x + winW / 2;
        const winCy = y + winH / 2;
        const centerDist = Math.hypot(winCx - cx, winCy - cy) / maxCenterDist;
        const score = captured - sizeWeight * area - centerWeight * centerDist * 0.1;
        if (score > best.score) {
          best = { x, y, width: winW, height: winH, score };
        }
      }
    }
  }
  best.x = Math.min(best.x, W - best.width);
  best.y = Math.min(best.y, H - best.height);
  return best;
}
function cropImage(image, rect) {
  const { width: W, height: H, data } = image;
  const x = clampInt(rect.x, 0, W - 1);
  const y = clampInt(rect.y, 0, H - 1);
  const w = clampInt(rect.width, 1, W - x);
  const h = clampInt(rect.height, 1, H - y);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * W + x) * 4;
    out.set(data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}
function resolveAspect(opts) {
  if (opts.width && opts.height) return opts.width / opts.height;
  if (Array.isArray(opts.aspect)) {
    const [w, h] = opts.aspect;
    return h > 0 ? w / h : 1;
  }
  if (typeof opts.aspect === "number" && opts.aspect > 0) return opts.aspect;
  return 1;
}
function importanceMap(image, satWeight) {
  const { width: W, height: H, data } = image;
  const luma = new Float64Array(W * H);
  const sat = new Float64Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3] / 255;
    luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) * a;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    sat[i] = max > 0 ? (max - min) / max * a : 0;
  }
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const x0 = x > 0 ? x - 1 : x, x1 = x < W - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y, y1 = y < H - 1 ? y + 1 : y;
      const tl = luma[y0 * W + x0], tc = luma[y0 * W + x], tr = luma[y0 * W + x1];
      const ml = luma[y * W + x0], mr = luma[y * W + x1];
      const bl = luma[y1 * W + x0], bc = luma[y1 * W + x], br = luma[y1 * W + x1];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const edge = Math.hypot(gx, gy) / 4;
      out[i] = edge + satWeight * sat[i] * 255;
    }
  }
  return out;
}
function integralImage(src, W, H) {
  const iw = W + 1;
  const integral = new Float64Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += src[y * W + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  return integral;
}
function rectSum(integral, W, x, y, w, h) {
  const iw = W + 1;
  const x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  return integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// src/emit/animate.ts
function framesToAnimatedSvg(frames, opts = {}) {
  if (frames.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg"/>\n';
  if (frames.length === 1 || opts.loop === false) {
    return frames[0];
  }
  const n2 = frames.length;
  const duration = opts.duration ?? n2 / (opts.fps ?? 10);
  const viewBox = frames[0].match(/viewBox="([^"]*)"/)?.[1] ?? sizeToViewBox2(frames[0]) ?? "0 0 100 100";
  const reduced = opts.respectReducedMotion !== false;
  const slot = 100 / n2;
  const eps = Math.min(1e-4, slot / 1e3);
  const keyframes = `@keyframes pv-flip{0%,${trim(slot)}%{opacity:1}${trim(slot + eps)}%,100%{opacity:0}}`;
  const delays = Array.from({ length: n2 }, (_, k) => `.pv-f${k}{animation-delay:${trim(-(k * duration) / n2)}s${k === 0 ? ";opacity:1" : ""}}`).join("");
  const reducedCss = reduced ? "@media(prefers-reduced-motion:reduce){.pv-f{animation:none}.pv-f0{opacity:1}}" : "";
  const style = `<style>.pv-f{opacity:0;animation:pv-flip ${trim(duration)}s linear infinite}` + delays + keyframes + reducedCss + `</style>`;
  const groups = frames.map((svg, k) => `<g class="pv-f pv-f${k}">${innerSvg(svg)}</g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${style}${groups}</svg>
`;
}
function innerSvg(svg) {
  return svg.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();
}
function sizeToViewBox2(svg) {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? svg;
  const attr = (name) => openTag.match(new RegExp(`[\\s"']${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, "i"))?.[1];
  const w = attr("width");
  const h = attr("height");
  return w && h ? `0 0 ${w} ${h}` : void 0;
}
function trim(v) {
  return String(Math.round(v * 1e4) / 1e4);
}

// src/placeholder/index.ts
var DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
function encode83(value, length) {
  let out = "";
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    out += DIGITS[digit];
  }
  return out;
}
function signPow(value, exp) {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}
function encodeDC(c) {
  return linearToSrgb(c[0]) * 65536 + linearToSrgb(c[1]) * 256 + linearToSrgb(c[2]);
}
function encodeAC(c, max) {
  const q = (v) => Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / max, 0.5) * 9 + 9.5))));
  return q(c[0]) * 19 * 19 + q(c[1]) * 19 + q(c[2]);
}
function blurHash(image, componentsX = 4, componentsY = 3) {
  const cx = Math.max(1, Math.min(9, componentsX));
  const cy = Math.max(1, Math.min(9, componentsY));
  const { width, height, data } = image;
  if (width < 1 || height < 1 || data.length < width * height * 4) {
    throw new Error("blurHash: image must have positive dimensions and a matching data buffer");
  }
  const factors = [];
  const scale = 1 / (width * height);
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < cx; x++) {
      const norm = x === 0 && y === 0 ? 1 : 2;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++) {
          const basis = norm * Math.cos(Math.PI * x * i / width) * Math.cos(Math.PI * y * j / height);
          const p = (j * width + i) * 4;
          r += basis * srgbToLinear(data[p]);
          g += basis * srgbToLinear(data[p + 1]);
          b += basis * srgbToLinear(data[p + 2]);
        }
      }
      factors.push([r * scale, g * scale, b * scale]);
    }
  }
  const dc = factors[0];
  const ac = factors.slice(1);
  let hash = encode83(cx - 1 + (cy - 1) * 9, 1);
  let maxValue = 1;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.map((f) => Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]))));
    const quantMax = Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5)));
    maxValue = (quantMax + 1) / 166;
    hash += encode83(quantMax, 1);
  } else {
    hash += encode83(0, 1);
  }
  hash += encode83(encodeDC(dc), 4);
  for (const f of ac) hash += encode83(encodeAC(f, maxValue), 2);
  return hash;
}
function lqipSvg(image, opts = {}) {
  const small = subsample(image, opts.maxPixels ?? 1600);
  const blurred = small.width >= 4 && small.height >= 4 ? selectiveBlur(small, { radius: 2, delta: 255 }) : small;
  return trace(blurred, {
    colors: opts.colors ?? 4,
    tolerance: 2,
    fitError: 2,
    minArea: 0,
    refineIterations: 0
  }).svg;
}

// src/io/export/geometry.ts
function traceGeometry(source, opts = {}) {
  const o = { ...TRACE_DEFAULTS, minArea: autoMinArea(source.width * source.height), ...stripUndef(opts) };
  const { width, height, data } = source;
  const n2 = width * height;
  const palette = quantize(source, o.colors, {
    refineIterations: o.refineIterations,
    fillStrategy: o.fillStrategy,
    fixedPalette: o.fixedPalette
  });
  const nearest = new NearestColor(palette, n2);
  const classes = new Int32Array(n2);
  for (let i = 0; i < n2; i++) {
    const off = i * 4;
    if (data[off + 3] < 8) {
      classes[i] = -1;
      continue;
    }
    classes[i] = nearest.index(data[off], data[off + 1], data[off + 2]);
  }
  let comps = connectedComponents(classes, width, height, -1);
  if (o.minArea > 1) {
    for (let pass = 0; pass < 2; pass++) {
      const merged = despeckle(classes, comps, width, height, o.minArea, -1);
      if (merged === 0) break;
      comps = connectedComponents(classes, width, height, -1);
    }
  }
  const loops = traceComponents(comps.labels, width, height, comps.count, o.turnPolicy);
  const byClass = /* @__PURE__ */ new Map();
  const area = /* @__PURE__ */ new Map();
  for (let c = 0; c < comps.count; c++) {
    const cls = comps.classes[c];
    if (cls < 0) continue;
    (byClass.get(cls) ?? byClass.set(cls, []).get(cls)).push(c);
    area.set(cls, (area.get(cls) ?? 0) + comps.areas[c]);
  }
  const ordered = [...byClass.keys()].sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0) || a - b);
  const fitOpts = {
    tolerance: o.tolerance,
    fitError: o.fitError,
    cornerAngle: o.cornerAngle,
    polygonOnly: o.polygonOnly,
    optimize: o.optimize,
    optimizeError: o.optimizeError,
    rightAngleEnhance: o.rightAngleEnhance,
    rightAngleThreshold: o.rightAngleThreshold
  };
  const wantPrimitives = opts.primitives !== false;
  const paths = [];
  for (const cls of ordered) {
    const subpaths = [];
    const primitives = [];
    for (const c of byClass.get(cls)) {
      for (const loop of loops[c]) {
        const fitted = fitLoop(loop.pts, fitOpts);
        if (!fitted) continue;
        subpaths.push(fitted);
        primitives.push(wantPrimitives ? detectPrimitive(loop.pts, { maxError: o.primitiveError }) : null);
      }
    }
    if (subpaths.length === 0) continue;
    paths.push({
      color: { r: palette.rgb[cls * 3], g: palette.rgb[cls * 3 + 1], b: palette.rgb[cls * 3 + 2], a: 255 },
      subpaths,
      ...wantPrimitives ? { primitives } : {}
    });
  }
  return { width, height, paths };
}
function stripUndef(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== void 0) out[k] = v;
  return out;
}

// src/io/export/shared.ts
function sampleCubic(p0, c1, c2, p3, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    out.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
    });
  }
  return out;
}
function flatten(path, steps = 10) {
  const pts = [{ x: path.start.x, y: path.start.y }];
  let cur = { x: path.start.x, y: path.start.y };
  for (const seg of path.segments) {
    if (seg.kind === "line") {
      cur = { x: seg.x, y: seg.y };
      pts.push(cur);
    } else {
      const sampled = sampleCubic(cur, { x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }, { x: seg.x, y: seg.y }, steps);
      for (const p of sampled) pts.push(p);
      cur = { x: seg.x, y: seg.y };
    }
  }
  return pts;
}
function rgbToCmyk(r, g, b) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const k = 1 - Math.max(rf, gf, bf);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - rf - k) / (1 - k), (1 - gf - k) / (1 - k), (1 - bf - k) / (1 - k), k];
}
function n(v, places = 3) {
  return (Math.round(v * 10 ** places) / 10 ** places).toString();
}

// src/io/export/dxf.ts
function toDxf(geometry, opts = {}) {
  const steps = opts.curveSteps ?? 12;
  const H = geometry.height;
  const fy = (y) => H - y;
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (const path of geometry.paths) {
    const layer = `c_${hex2(path.color.r, path.color.g, path.color.b)}`;
    const trueColor = path.color.r << 16 | path.color.g << 8 | path.color.b;
    const aci = String(acadColor(path.color.r, path.color.g, path.color.b));
    path.subpaths.forEach((sub, i) => {
      const prim = path.primitives?.[i];
      if (prim?.kind === "circle") {
        lines.push(
          "0",
          "CIRCLE",
          "8",
          layer,
          "62",
          aci,
          "420",
          String(trueColor),
          "10",
          n(prim.cx),
          "20",
          n(fy(prim.cy)),
          "40",
          n(prim.r)
        );
        return;
      }
      if (prim?.kind === "ellipse") {
        const majorX = prim.rx >= prim.ry ? prim.rx : 0;
        const majorY = prim.rx >= prim.ry ? 0 : prim.ry;
        const ratio = prim.rx >= prim.ry ? prim.ry / prim.rx : prim.rx / prim.ry;
        lines.push(
          "0",
          "ELLIPSE",
          "8",
          layer,
          "62",
          aci,
          "420",
          String(trueColor),
          "10",
          n(prim.cx),
          "20",
          n(fy(prim.cy)),
          "30",
          "0",
          "11",
          n(majorX),
          "21",
          n(-majorY),
          "31",
          "0",
          // End parameter at full precision: n()'s 3-place rounding of 2π would
          // leave a sub-pixel hairline gap instead of a closed ellipse.
          "40",
          n(ratio),
          "41",
          "0",
          "42",
          String(2 * Math.PI)
        );
        return;
      }
      const verts = flatten(sub, steps);
      if (verts.length > 1) {
        const a = verts[0], b = verts[verts.length - 1];
        if (a.x === b.x && a.y === b.y) verts.pop();
      }
      if (verts.length < 2) return;
      lines.push(
        "0",
        "LWPOLYLINE",
        "8",
        layer,
        "62",
        aci,
        "420",
        String(trueColor),
        "90",
        String(verts.length),
        "70",
        "1"
      );
      for (const v of verts) lines.push("10", n(v.x), "20", n(fy(v.y)));
    });
  }
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n") + "\n";
}
function hex2(r, g, b) {
  return [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function acadColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 20) return max > 200 ? 7 : max < 60 ? 250 : 8;
  if (r >= g && r >= b) return g > b ? r - g < 40 ? 2 : 1 : 1;
  if (g >= r && g >= b) return 3;
  return b > r ? 5 : 6;
}

// src/io/export/eps.ts
function toEps(geometry, opts = {}) {
  const { width, height } = geometry;
  const fy = (y) => height - y;
  const out = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    `%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}`,
    "%%Creator: pixvec",
    "%%EndComments"
  ];
  for (const path of geometry.paths) {
    const { r, g, b } = path.color;
    out.push(opts.cmyk ? `${rgbToCmyk(r, g, b).map((v) => n(v)).join(" ")} setcmykcolor` : `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} setrgbcolor`);
    out.push("newpath");
    for (const sub of path.subpaths) {
      out.push(`${n(sub.start.x)} ${n(fy(sub.start.y))} moveto`);
      let cx = sub.start.x, cy = sub.start.y;
      for (const seg of sub.segments) {
        if (seg.kind === "line") {
          out.push(`${n(seg.x)} ${n(fy(seg.y))} lineto`);
          cx = seg.x;
          cy = seg.y;
        } else {
          out.push(
            `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} curveto`
          );
          cx = seg.x;
          cy = seg.y;
        }
      }
      out.push("closepath");
    }
    out.push("eofill");
  }
  out.push("%%EOF");
  return out.join("\n") + "\n";
}

// src/io/export/pdf.ts
function toPdf(geometry, opts = {}) {
  const w = Math.ceil(geometry.width);
  const h = Math.ceil(geometry.height);
  const fy = (y) => geometry.height - y;
  const ops = [];
  for (const path of geometry.paths) {
    const { r, g, b } = path.color;
    ops.push(opts.cmyk ? `${rgbToCmyk(r, g, b).map((v) => n(v)).join(" ")} k` : `${n(r / 255)} ${n(g / 255)} ${n(b / 255)} rg`);
    for (const sub of path.subpaths) {
      ops.push(`${n(sub.start.x)} ${n(fy(sub.start.y))} m`);
      for (const seg of sub.segments) {
        ops.push(seg.kind === "line" ? `${n(seg.x)} ${n(fy(seg.y))} l` : `${n(seg.x1)} ${n(fy(seg.y1))} ${n(seg.x2)} ${n(fy(seg.y2))} ${n(seg.x)} ${n(fy(seg.y))} c`);
      }
      ops.push("h");
    }
    ops.push("f*");
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>
stream
${content}
endstream`
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj
${body}
endobj
`;
  });
  const xrefPos = pdf.length;
  pdf += `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n 
`;
  pdf += `trailer
<< /Size ${objects.length + 1} /Root 1 0 R >>
startxref
${xrefPos}
%%EOF
`;
  return new TextEncoder().encode(pdf);
}

// src/io/export/gcode.ts
function toGcode(polylines, opts = {}) {
  const mode = opts.mode ?? "laser";
  const feed = opts.feed ?? 1e3;
  const travelFeed = opts.travelFeed ?? 3e3;
  const power = opts.power ?? 1e3;
  const s = opts.scale ?? 1;
  const H = opts.height ?? 0;
  const coord = (p) => `X${n(p.x * s)} Y${n((H - p.y) * s)}`;
  const toolOff = mode === "laser" ? "M5" : `G0 Z${n(opts.penUp ?? 5)}`;
  const toolOn = mode === "laser" ? `M3 S${power}` : `G1 Z${n(opts.penDown ?? 0)} F${feed}`;
  const lines = [
    "; pixvec G-code",
    `; mode=${mode} feed=${feed} ${opts.units ?? "mm"}`,
    opts.units === "in" ? "G20" : "G21",
    "G90",
    "G0 F" + travelFeed,
    toolOff
  ];
  for (const poly of polylines) {
    if (poly.length < 2) continue;
    lines.push(`G0 ${coord(poly[0])}`);
    lines.push(toolOn);
    lines.push(`G1 ${coord(poly[1])} F${feed}`);
    for (let i = 2; i < poly.length; i++) lines.push(`G1 ${coord(poly[i])}`);
    lines.push(toolOff);
  }
  lines.push("G0 X0 Y0", mode === "laser" ? "M5" : `G0 Z${n(opts.penUp ?? 5)}`, "M2");
  return lines.join("\n") + "\n";
}

// src/core.ts
var VERSION = "1.18.0";
export {
  GRADIENT_DEFAULTS,
  GRAD_BASE,
  NearestColor,
  PathBuilder,
  SvgDoc,
  TRACE_DEFAULTS,
  VERSION,
  applyThreshold,
  autoMinArea,
  blurHash,
  bytesEqual,
  centerlinePolylines,
  centerlineTrace,
  colorHistogram,
  compareImages,
  compositeOver,
  connectedComponents,
  countDistinctColors,
  createImage,
  cropImage,
  decodeBmp,
  decodeFallback,
  decodeIco,
  decodePnm,
  decodeTga,
  decodeTgaFallback,
  deltaE2000,
  despeckle,
  detectBackgroundColor,
  detectGradients,
  detectPrimitive,
  dominantColor,
  encodeBmp,
  encodeIco,
  encodeIcoDib,
  encodePnm,
  encodeTga,
  escapeAttr,
  escapeText,
  extractPalette,
  fillAttrs,
  findDecoder,
  findEncoder,
  fitLoop,
  framesToAnimatedSvg,
  fromBase64,
  hex,
  isBmp,
  isIco,
  isOpaque,
  isPnm,
  isTga,
  latin1,
  linearToSrgb,
  listIcoEntries,
  lqipSvg,
  luma709,
  num,
  oklabToSrgb,
  optimizeSvg,
  otsuThreshold,
  packRgba,
  paletteToCssVars,
  parseCssColor,
  premultiply,
  primitiveSvg,
  quantize,
  quantizeAlpha,
  registerDecoder,
  registerEncoder,
  registeredFormats,
  removeBackground,
  sameSize,
  selectiveBlur,
  shortHex,
  smartCrop,
  sniffFallbackFormat,
  srgbToLab,
  srgbToLinear,
  srgbToOklab,
  ssimPlane,
  subsample,
  svgSprite,
  toBase64,
  toComponent,
  toDxf,
  toEps,
  toGcode,
  toPdf,
  trace,
  traceComponents,
  traceGeometry,
  traceSeparations,
  unpackRgba,
  unregisterDecoder,
  unregisterEncoder,
  vectorizeExact,
  vectorizeExactContours,
  vectorizePixels
};
