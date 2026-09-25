// Chunked to avoid blowing the call stack on large buffers
const SEGMENT_SIZE = 0x8000;

// Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 (native, no
// intermediate binary string). Vite base64-encodes an inline sourcemap into
// every module it serves, so this is on the dev-server hot path.
const nativeToBase64 = (Uint8Array.prototype as { toBase64?: () => string }).toBase64;
const nativeFromBase64 = (Uint8Array as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

function bytesToBinaryString(data: Uint8Array): string {
  if (data.length <= SEGMENT_SIZE) {
    return String.fromCharCode.apply(null, data as unknown as number[]);
  }
  const segments: string[] = [];
  for (let offset = 0; offset < data.length; offset += SEGMENT_SIZE) {
    segments.push(
      String.fromCharCode.apply(null, data.subarray(offset, offset + SEGMENT_SIZE) as unknown as number[]),
    );
  }
  return segments.join('');
}

export function bytesToBase64(data: Uint8Array): string {
  if (nativeToBase64) {
    try {
      return nativeToBase64.call(data);
    } catch {
      /* e.g. a view the native method rejects: use the portable path */
    }
  }
  return btoa(bytesToBinaryString(data));
}

export function base64ToBytes(encoded: string): Uint8Array {
  if (nativeFromBase64) {
    try {
      return nativeFromBase64(encoded);
    } catch {
      /* atob below reports invalid input the way it always has */
    }
  }
  const raw = atob(encoded);
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    result[i] = raw.charCodeAt(i);
  }
  return result;
}

// Pre-computed hex lookup table
const HEX_TABLE: string[] = new Array(256);
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = (i < 16 ? '0' : '') + i.toString(16);
}

export function bytesToHex(data: Uint8Array): string {
  const chars = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    chars[i] = HEX_TABLE[data[i]];
  }
  return chars.join('');
}

export function bytesToLatin1(data: Uint8Array): string {
  return bytesToBinaryString(data);
}

// A native TextDecoder call costs more than decoding an identifier-sized
// string in JS, and parsers decode one per name (Rollup: every string in
// its AST). Short all-ASCII input is the same in UTF-8 as in ASCII.
const SHORT_ASCII_MAX = 64;

/** The string for short all-ASCII bytes, or null (use a TextDecoder). */
export function decodeShortAscii(data: Uint8Array): string | null {
  const n = data.length;
  if (n > SHORT_ASCII_MAX) return null;
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = data[i]!;
    if (c > 0x7f) return null;
    out += String.fromCharCode(c);
  }
  return out;
}
