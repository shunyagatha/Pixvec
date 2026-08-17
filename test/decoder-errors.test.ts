import { describe, expect, it } from 'vitest';
import { explainCodecFailure, tidyCodecMessage } from '../src/io/decode.js';

/**
 * Every string here was captured verbatim from the real decoders against the
 * files that produce them, not invented. A paraphrase would let the matcher
 * drift away from the text it has to recognise without any test noticing.
 */

const TIFF_TILED_PLANAR = [
  'tiff2vips: tiled separate planes not supported',
  'tiffload_buffer: load error',
  'tiffload_buffer: load error',
  'tiffload_buffer: load error',
  'tiffload_buffer: load error',
].join('\n');

const AVIF_LAYERED = [
  'source: bad seek to 86685',
  'source: bad seek to 86658',
  'source: bad seek to 86654',
  'heif: Memory allocation error: Security limit exceeded: Memory allocation error: ' +
    'Security limit exceeded: Allocating an image of size 1436x730 exceeds the ' +
    'security limit of 151280 pixels (6.1000)',
].join('\n');

const HEIC_NO_HEVC = [
  'source: bad seek to 113829',
  'source: bad seek to 113813',
  'source: bad seek to 113805',
  'source: bad seek to 113801',
  'source: bad seek to 113799',
  'source: bad seek to 113798',
  'heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)',
].join('\n');

describe('tidyCodecMessage', () => {
  it('drops the seek probes libheif emits while finding its way around', () => {
    const out = tidyCodecMessage(HEIC_NO_HEVC);
    expect(out).not.toMatch(/bad seek/);
    expect(out).toMatch(/has not been built in/);
  });

  it('collapses a diagnostic repeated once per attempted load', () => {
    const out = tidyCodecMessage(TIFF_TILED_PLANAR);
    // Four identical "load error" lines become one.
    expect(out.match(/tiffload_buffer: load error/g)).toHaveLength(1);
    expect(out).toMatch(/tiled separate planes not supported/);
  });

  it('collapses a prefix libheif concatenated onto its own message', () => {
    const out = tidyCodecMessage(AVIF_LAYERED);
    expect(out.match(/Memory allocation error: Security limit exceeded: /g)).toHaveLength(1);
    // The part that actually identifies the failure survives.
    expect(out).toMatch(/exceeds the security limit of 151280 pixels/);
  });

  it('leaves an ordinary message alone', () => {
    expect(tidyCodecMessage('Input buffer contains unsupported image format'))
      .toBe('Input buffer contains unsupported image format');
  });
});

describe('explainCodecFailure', () => {
  it('names the TIFF combination libvips will not read, and how to convert it', () => {
    const out = explainCodecFailure(TIFF_TILED_PLANAR);
    expect(out).toMatch(/PLANARCONFIG_SEPARATE/);
    expect(out).toMatch(/tiffcp -p contig/);
  });

  it('says an HEVC decoder is missing rather than forwarding a plugin error', () => {
    const out = explainCodecFailure(HEIC_NO_HEVC);
    expect(out).toMatch(/HEVC decoder/);
    expect(out).toMatch(/sips|ImageMagick/);
  });

  /**
   * The raw text reads as a memory failure, which sends the reader looking for
   * a memory setting that does not exist. It is libheif declining on principle:
   * the other AVIFs in the format corpus decode at comparable sizes and only
   * the layered one trips it.
   */
  it('does not describe libheif\'s security limit as running out of memory', () => {
    const out = explainCodecFailure(AVIF_LAYERED);
    expect(out).toMatch(/layered/i);
    expect(out).not.toMatch(/out of memory|allocation failed/i);
  });

  it('returns null for anything it does not recognise, so the generic path runs', () => {
    expect(explainCodecFailure('Input buffer contains unsupported image format')).toBeNull();
    expect(explainCodecFailure('VipsJpeg: Premature end of JPEG file')).toBeNull();
    expect(explainCodecFailure('')).toBeNull();
  });
});
