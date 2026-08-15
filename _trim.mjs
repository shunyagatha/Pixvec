import { loadRaster } from './dist/esm/api.js';
import { removeBackground, cropImage } from './dist/esm/core.js';
import { encodeRaster } from './dist/esm/io/encode.js';
import { readFile, writeFile } from 'node:fs/promises';

const [src, out, tolArg, padArg] = process.argv.slice(2);
const { image } = await loadRaster(await readFile(src));
console.log('source', image.width + 'x' + image.height);

// JPEG rings every edge with compression noise, so the flood fill needs more
// slack than a PNG would — but not so much that it eats the pale teal tip.
const r = removeBackground(image, { tolerance: Number(tolArg), feather: false });

const { width: w, height: h, data } = r.image;
let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  if (data[(y*w+x)*4+3] > 24) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
if (maxX < 0) { console.log('nothing survived — tolerance too high'); process.exit(1); }
const pad = Number(padArg || 0);
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
const cropped = cropImage(r.image, { x: minX, y: minY, width: maxX-minX+1, height: maxY-minY+1 });
await writeFile(out, await encodeRaster(cropped, { format: 'png' }));

// How much of the frame was empty space?
const kept = (cropped.width*cropped.height)/(w*h);
console.log(`trimmed → ${cropped.width}x${cropped.height}  (${(100*(1-kept)).toFixed(0)}% of the frame was background)`);
