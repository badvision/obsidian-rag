import * as zlib from 'zlib';

/**
 * Lossless vector codec for the GCF index: `f64le-deflate-base64`.
 *
 * Each vector is written as explicit IEEE 754 binary64 little-endian — every
 * JavaScript number is preserved bit-for-bit, including -0, denormals, and
 * non-f32 doubles. The bytes are then compressed with a zlib DEFLATE stream
 * (RFC 1950 wrapper, default level) and base64-encoded (standard alphabet).
 *
 * No precision is ever reduced, cast, or quantized. DEFLATE is lossless and
 * simply exploits the trailing-zero-byte redundancy of f32-origin doubles
 * (the low 32 bits of every f64 are zero when the value came from an f32).
 *
 * The base64 alphabet (A-Z a-z 0-9 + / =) contains no GCF special characters,
 * so a vector cell stays an unquoted bare token on the wire.
 */
export const VECTOR_CODEC = 'f64le-deflate-base64';

export function encodeVector(values: ArrayLike<number>): string {
  if (values.length === 0) return '';
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(i * 8, values[i], true); // little-endian
  }
  return zlib.deflateSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString('base64');
}

export function decodeVector(cell: string): Float64Array {
  if (cell === '') return new Float64Array(0);
  const bytes = zlib.inflateSync(Buffer.from(cell, 'base64'));
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
}
