import { afterEach, describe, expect, it } from 'vitest';
import {
  registerDecoder, registerEncoder, unregisterDecoder, unregisterEncoder,
  findDecoder, findEncoder, registeredFormats,
} from '../src/codecs.js';
import { decodeRaster } from '../src/io/decode.js';
import { encodeRaster } from '../src/io/encode.js';
import { compareImages } from '../src/metrics/index.js';
import { flatArtwork } from './fixtures.js';
import type { RasterImage } from '../src/types.js';

/**
 * A toy codec used to exercise the registry socket without pulling in a real
 * WASM decoder. Its container is `PIXT` + width + height + raw RGBA, which is
 * enough to prove that a registered format decodes and encodes through the same
 * pipeline every built-in format uses.
 */
const MAGIC = [0x50, 0x49, 0x58, 0x54]; // 'PIXT'

function encodeToy(img: RasterImage): Uint8Array {
  const out = new Uint8Array(12 + img.data.length);
  out.set(MAGIC);
  const view = new DataView(out.buffer);
  view.setUint32(4, img.width);
  view.setUint32(8, img.height);
  out.set(img.data, 12);
  return out;
}

function registerToy(): void {
  registerDecoder({
    format: 'toy',
    canDecode: (b) => b.length > 12 && MAGIC.every((m, i) => b[i] === m),
    decode: (b) => {
      const view = new DataView(b.buffer, b.byteOffset);
      const width = view.getUint32(4);
      const height = view.getUint32(8);
      return { width, height, data: new Uint8ClampedArray(b.buffer, b.byteOffset + 12, width * height * 4) };
    },
  });
  registerEncoder({ format: 'toy', encode: encodeToy });
}

afterEach(() => {
  unregisterDecoder('toy');
  unregisterEncoder('toy');
});

describe('codec registry', () => {
  it('starts empty', () => {
    expect(registeredFormats()).toEqual({ decode: [], encode: [] });
  });

  it('registers and reports a codec', () => {
    registerToy();
    const formats = registeredFormats();
    expect(formats.decode).toContain('toy');
    expect(formats.encode).toContain('toy');
  });

  it('finds a decoder by signature and an encoder by name', () => {
    registerToy();
    expect(findDecoder(encodeToy(flatArtwork(4, 4)))?.format).toBe('toy');
    expect(findEncoder('toy')?.format).toBe('toy');
    expect(findDecoder(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });

  it('round-trips a registered format bit-exactly through decode/encode', async () => {
    registerToy();
    const source = flatArtwork(24, 18);
    const encoded = await encodeRaster(source, { format: 'toy' });
    const { image, meta } = await decodeRaster(encoded);
    expect(meta.format).toBe('toy');
    expect(compareImages(source, image).lossless).toBe(true);
  });

  it('a registered decoder wins over sharp for its signature', async () => {
    // The toy magic is not a real image signature, so this only proves routing:
    // registering makes those bytes decodable where they were not before.
    const bytes = encodeToy(flatArtwork(8, 8));
    await expect(decodeRaster(bytes)).rejects.toThrow();
    registerToy();
    const { meta } = await decodeRaster(bytes);
    expect(meta.format).toBe('toy');
  });

  it('unregisters cleanly', () => {
    registerToy();
    expect(unregisterDecoder('toy')).toBe(true);
    expect(unregisterEncoder('toy')).toBe(true);
    expect(registeredFormats()).toEqual({ decode: [], encode: [] });
    expect(unregisterDecoder('toy')).toBe(false);
  });

  it('rejects a decoder that returns the wrong byte count', async () => {
    registerDecoder({
      format: 'broken',
      canDecode: (b) => b.length > 3 && b[0] === 0xbb,
      decode: () => ({ width: 10, height: 10, data: new Uint8ClampedArray(4) }),
    });
    try {
      await expect(decodeRaster(new Uint8Array([0xbb, 0, 0, 0]))).rejects.toThrow(/expected 400/);
    } finally {
      unregisterDecoder('broken');
    }
  });

  it('names the socket when encoding an unregistered format', async () => {
    await expect(encodeRaster(flatArtwork(4, 4), { format: 'jxl' }))
      .rejects.toThrow(/graver\/codecs/);
  });

  it('a misbehaving signature check does not sink the decode path', async () => {
    registerDecoder({
      format: 'throws',
      canDecode: () => { throw new Error('boom'); },
      decode: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    });
    try {
      // A normal PNG must still decode despite the throwing signature check.
      const png = await (await import('./fixtures.js')).encode(flatArtwork(8, 8), 'png');
      const { image } = await decodeRaster(png);
      expect(image.width).toBe(8);
    } finally {
      unregisterDecoder('throws');
    }
  });
});
