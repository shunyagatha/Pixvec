import sharp from 'sharp';
import type { RasterImage } from '../src/types.js';

/**
 * Synthetic fixtures, generated rather than committed.
 *
 * Binary test assets rot: nobody can review a diff of them, and a resampling
 * change in an image library silently invalidates every expectation built on
 * them. Generating deterministic images from code keeps the test suite readable
 * and makes it obvious what property each case is probing.
 */

export function createImage(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function setPixel(
  img: RasterImage, x: number, y: number,
  r: number, g: number, b: number, a = 255,
): void {
  const o = (y * img.width + x) * 4;
  img.data[o] = r;
  img.data[o + 1] = g;
  img.data[o + 2] = b;
  img.data[o + 3] = a;
}

/** Deterministic pseudo-random source; no dependency on the platform's RNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat-colour artwork: a few large regions, one of them with a hole. */
export function flatArtwork(width = 120, height = 90): RasterImage {
  const img = createImage(width, height);
  const cx = width / 2, cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < 18) setPixel(img, x, y, 250, 244, 232);        // hole in the disc
      else if (d < 34) setPixel(img, x, y, 214, 69, 65);      // disc
      else if (x < width / 3) setPixel(img, x, y, 32, 96, 160);
      else if (x < (2 * width) / 3) setPixel(img, x, y, 250, 244, 232);
      else setPixel(img, x, y, 40, 150, 110);
    }
  }
  return img;
}

/** Hard-edged pixel art with a small palette. */
export function pixelArt(scale = 1): RasterImage {
  const pattern = [
    '..GGGG..',
    '.GRRRRG.',
    'GRWRRWRG',
    'GRRRRRRG',
    'GRWRRWRG',
    'GRRWWRRG',
    '.GRRRRG.',
    '..GGGG..',
  ];
  const palette: Record<string, [number, number, number, number]> = {
    '.': [0, 0, 0, 0],
    G: [24, 32, 48, 255],
    R: [222, 88, 72, 255],
    W: [255, 255, 255, 255],
  };

  const w = pattern[0].length * scale;
  const h = pattern.length * scale;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = palette[pattern[Math.floor(y / scale)][Math.floor(x / scale)]];
      setPixel(img, x, y, c[0], c[1], c[2], c[3]);
    }
  }
  return img;
}

/** Smooth gradients plus noise — the photographic case. */
export function photoLike(width = 96, height = 72, seed = 7): RasterImage {
  const img = createImage(width, height);
  const rand = mulberry32(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1), v = y / (height - 1);
      const r = 40 + 180 * u + 20 * Math.sin(v * 9) + rand() * 12;
      const g = 30 + 150 * v + 30 * Math.cos(u * 7) + rand() * 12;
      const b = 200 - 120 * u * v + rand() * 12;
      setPixel(img, x, y, clamp(r), clamp(g), clamp(b), 255);
    }
  }
  return img;
}

/** Soft-edged shape over transparency, for the alpha paths. */
export function alphaBlob(width = 64, height = 64): RasterImage {
  const img = createImage(width, height);
  const cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = d > 26 ? 0 : d > 18 ? Math.round(255 * (1 - (d - 18) / 8)) : 255;
      setPixel(img, x, y, 30, 110, 200, a);
    }
  }
  return img;
}

/** A region that winds around and touches itself diagonally. */
export function diagonalPinch(): RasterImage {
  // The two shaded arms meet only at a single lattice point; the tracer has to
  // keep them as separate loops rather than crossing the boundary through it.
  const pattern = [
    'XX..',
    'XX..',
    '..XX',
    '..XX',
  ];
  const img = createImage(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (pattern[y][x] === 'X') setPixel(img, x, y, 0, 0, 0, 255);
      else setPixel(img, x, y, 255, 255, 255, 255);
    }
  }
  return img;
}

function clamp(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** Encode a fixture so decoders and format handling can be exercised. */
export function encode(
  img: RasterImage,
  format: 'png' | 'jpeg' | 'webp' | 'tiff' | 'avif',
  opts: Record<string, unknown> = {},
): Promise<Buffer> {
  const pipeline = sharp(
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    { raw: { width: img.width, height: img.height, channels: 4 } },
  );
  switch (format) {
    case 'png': return pipeline.png({ compressionLevel: 9, palette: false, ...opts }).toBuffer();
    case 'jpeg': return pipeline.jpeg({ quality: 95, ...opts }).toBuffer();
    case 'webp': return pipeline.webp({ lossless: true, ...opts }).toBuffer();
    case 'tiff': return pipeline.tiff({ compression: 'deflate', ...opts }).toBuffer();
    case 'avif': return pipeline.avif({ quality: 80, ...opts }).toBuffer();
  }
}
