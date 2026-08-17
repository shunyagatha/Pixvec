/**
 * Byte-level reads over plain `Uint8Array`.
 *
 * The format decoders originally used Node's `Buffer` methods, which tied the
 * whole pure-TypeScript half of this library to Node. `Buffer` *is* a
 * `Uint8Array`, so accepting the base type costs Node callers nothing and lets
 * the same code run in a browser, Deno, Bun, or an edge runtime.
 *
 * These are written as plain arithmetic rather than `DataView` calls: the
 * decoders read one field at a time from varying offsets, where constructing a
 * view per read would cost more than the read itself.
 */

export function u8(b: Uint8Array, o: number): number {
  return b[o] ?? 0;
}

export function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

export function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}

export function i16le(b: Uint8Array, o: number): number {
  // Shift into the sign bit and back, so the result is correctly negative.
  return (u16le(b, o) << 16) >> 16;
}

/** Big-endian u32. PNG and every chunk length inside it are big-endian. */
export function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
}

export function u32le(b: Uint8Array, o: number): number {
  // The final byte is added rather than shifted: `<< 24` would produce a signed
  // result, turning any value above 2^31 negative.
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)) >>> 0
  ) + (b[o + 3] ?? 0) * 0x1000000;
}

export function i32le(b: Uint8Array, o: number): number {
  return (
    (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)
  );
}

/** Decode a byte range as Latin-1, which maps each byte to the same code point. */
export function latin1(b: Uint8Array, start: number, end: number): string {
  let out = '';
  const stop = Math.min(end, b.length);
  for (let i = start; i < stop; i++) out += String.fromCharCode(b[i]);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode without `Buffer` or `btoa`.
 *
 * `btoa` is absent in Node and mishandles bytes above 0x7F when fed a string;
 * `Buffer` is absent everywhere else. Encoding here keeps data URIs working in
 * every runtime, which is the whole point of the portable core.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  const remainder = n % 3;
  const limit = n - remainder;

  for (let i = 0; i < limit; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64_ALPHABET[(triple >> 18) & 63] +
      BASE64_ALPHABET[(triple >> 12) & 63] +
      BASE64_ALPHABET[(triple >> 6) & 63] +
      BASE64_ALPHABET[triple & 63];
  }

  if (remainder === 1) {
    const chunk = bytes[limit];
    out += BASE64_ALPHABET[chunk >> 2] + BASE64_ALPHABET[(chunk << 4) & 63] + '==';
  } else if (remainder === 2) {
    const chunk = (bytes[limit] << 8) | bytes[limit + 1];
    out +=
      BASE64_ALPHABET[chunk >> 10] +
      BASE64_ALPHABET[(chunk >> 4) & 63] +
      BASE64_ALPHABET[(chunk << 2) & 63] +
      '=';
  }

  return out;
}

const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Decode base64, ignoring whitespace (legal inside a data URI) and padding. */
export function fromBase64(text: string): Uint8Array {
  // Size the output from the count of real symbols, not the raw string length.
  let symbols = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 && BASE64_LOOKUP[c] >= 0) symbols++;
  }

  const out = new Uint8Array(Math.floor((symbols * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) continue;
    const value = BASE64_LOOKUP[c];
    if (value < 0) continue;

    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (accumulator >> bits) & 0xff;
    }
  }

  return written === out.length ? out : out.subarray(0, written);
}
