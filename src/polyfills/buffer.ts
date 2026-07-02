// Buffer polyfill extending Uint8Array with Node.js Buffer API


import { bytesToBase64, base64ToBytes, bytesToHex, bytesToLatin1 } from '../helpers/byte-encoding';

const textEnc = new TextEncoder();
const textDec = new TextDecoder('utf-8');

// Pre-computed hex char → nibble value lookup (0-255 for valid hex chars, 0 for invalid)
const HEX_DECODE = new Uint8Array(128);
for (let i = 0; i < 10; i++) HEX_DECODE[48 + i] = i;         // '0'-'9'
for (let i = 0; i < 6; i++) { HEX_DECODE[65 + i] = 10 + i; HEX_DECODE[97 + i] = 10 + i; } // 'A'-'F', 'a'-'f'

// ---- The main BufferPolyfill class ----

class BufferPolyfill extends Uint8Array {
  static readonly BYTES_PER_ELEMENT = 1;

  // Overloads matching Node.js Buffer.from
  static from(
    source: string | ArrayBuffer | SharedArrayBuffer | Uint8Array | number[] | ArrayLike<number> | Iterable<number>,
    encOrMapper?: string | number | ((v: unknown, i: number) => number),
    ctx?: unknown
  ): BufferPolyfill {
    // Handle typed-array style mapper
    if (typeof encOrMapper === 'function') {
      const items = Array.from(source as ArrayLike<number>, encOrMapper as (v: number, i: number) => number, ctx);
      return new BufferPolyfill(items);
    }

    const encoding = encOrMapper as string | undefined;

    if (Array.isArray(source)) {
      return new BufferPolyfill(source);
    }

    if (typeof source === 'string') {
      const enc = (encoding || 'utf8').toLowerCase();

      if (enc === 'base64' || enc === 'base64url') {
        let b64 = source;
        if (enc === 'base64url') {
          b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4 !== 0) b64 += '=';
        }
        return new BufferPolyfill(base64ToBytes(b64));
      }

      if (enc === 'hex') {
        const octets = new Uint8Array(source.length >>> 1);
        for (let i = 0; i < source.length; i += 2) {
          octets[i >>> 1] = (HEX_DECODE[source.charCodeAt(i)] << 4) | HEX_DECODE[source.charCodeAt(i + 1)];
        }
        return new BufferPolyfill(octets);
      }

      if (enc === 'latin1' || enc === 'binary') {
        const octets = new Uint8Array(source.length);
        for (let i = 0; i < source.length; i++) {
          octets[i] = source.charCodeAt(i) & 0xff;
        }
        return new BufferPolyfill(octets);
      }

      // utf-8 default
      return new BufferPolyfill(textEnc.encode(source));
    }

    if (source instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer)) {
      // napi-rs uses Buffer.from(arrayBuffer, byteOffset, length) to view WebAssembly.Memory.buffer
      if (typeof encOrMapper === 'number') {
        const offset = encOrMapper;
        const length = ctx as number | undefined;
        return new BufferPolyfill(source as ArrayBuffer, offset, length);
      }
      return new BufferPolyfill(source as ArrayBuffer);
    }

    return new BufferPolyfill(source as Uint8Array);
  }

  static alloc(len: number, fillValue?: number): BufferPolyfill {
    const buf = new BufferPolyfill(len);
    if (fillValue !== undefined) {
      buf.fill(fillValue);
    }
    return buf;
  }

  static allocUnsafe(len: number): BufferPolyfill {
    return new BufferPolyfill(len);
  }

  static allocUnsafeSlow(len: number): BufferPolyfill {
    return new BufferPolyfill(len);
  }

  static concat(list: (Uint8Array | BufferPolyfill)[]): BufferPolyfill {
    let totalLen = 0;
    for (const chunk of list) totalLen += chunk.length;
    const merged = new BufferPolyfill(totalLen);
    let pos = 0;
    for (const chunk of list) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    return merged;
  }

  static isBuffer(candidate: unknown): candidate is BufferPolyfill {
    return candidate instanceof BufferPolyfill || candidate instanceof Uint8Array;
  }

  static isEncoding(enc: string): boolean {
    const lower = enc.toLowerCase();
    return ['utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'base64', 'base64url', 'hex'].includes(lower);
  }

  static byteLength(text: string, enc?: string): number {
    const lower = (enc || 'utf8').toLowerCase();
    if (lower === 'base64' || lower === 'base64url') {
      const stripped = text.replace(/[=]/g, '');
      return Math.floor(stripped.length * 3 / 4);
    }
    if (lower === 'hex') {
      return text.length >>> 1;
    }
    return textEnc.encode(text).length;
  }

  // ---- Instance methods ----

  toString(enc: BufferEncoding = 'utf8', start?: number, end?: number): string {
    const lower = (enc || 'utf8').toLowerCase();

    // Node supports toString(encoding, start, end) — webpack's wasm-hash
    // relies on it to read a small hex digest out of a whole-memory Buffer view
    let view: BufferPolyfill = this;
    if (start !== undefined || end !== undefined) {
      const from = Math.max(0, Math.min(this.length, start ?? 0));
      const to = Math.max(from, Math.min(this.length, end ?? this.length));
      view = this.subarray(from, to);
    }

    if (lower === 'base64') return bytesToBase64(view);

    if (lower === 'base64url') {
      return bytesToBase64(view).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    if (lower === 'hex') return bytesToHex(view);

    if (lower === 'latin1' || lower === 'binary') return bytesToLatin1(view);

    // copy into fresh buffer, TextDecoder.decode() rejects SharedArrayBuffer views (napi-rs/WASI over shared memory)
    if (typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer) {
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      return textDec.decode(copy);
    }
    return textDec.decode(view);
  }

  slice(begin?: number, end?: number): BufferPolyfill {
    return this.subarray(begin, end);
  }

  subarray(begin?: number, end?: number): BufferPolyfill {
    const view = super.subarray(begin, end);
    return Object.setPrototypeOf(view, BufferPolyfill.prototype) as BufferPolyfill;
  }

  write(string: string, encoding?: BufferEncoding): number;
  write(string: string, offset: number, encoding?: BufferEncoding): number;
  write(string: string, offset: number, length: number, encoding?: BufferEncoding): number;
  write(string: string, offsetOrEncoding?: number | BufferEncoding, lengthOrEncoding?: number | BufferEncoding, encoding?: BufferEncoding): number {
    const offset = typeof offsetOrEncoding === "number" ? offsetOrEncoding : 0;
    let enc: BufferEncoding | undefined;
    if (typeof offsetOrEncoding === "string") enc = offsetOrEncoding;
    else if (typeof lengthOrEncoding === "string") enc = lengthOrEncoding;
    else enc = encoding;
    // webpack's wasm-hash writes binary strings with "latin1"; utf8-encoding
    // those would expand chars >= 0x80 to two bytes and corrupt the hash state
    const encoded = BufferPolyfill.from(string, enc || "utf8");
    let len = typeof lengthOrEncoding === "number" ? Math.min(lengthOrEncoding, encoded.length) : encoded.length;
    len = Math.min(len, this.length - offset);
    this.set(encoded.subarray(0, len), offset);
    return len;
  }

  copy(dest: BufferPolyfill, destStart?: number, srcStart?: number, srcEnd?: number): number {
    const segment = this.subarray(srcStart || 0, srcEnd);
    dest.set(segment, destStart || 0);
    return segment.length;
  }

  compare(other: Uint8Array): number {
    const bound = Math.min(this.length, other.length);
    for (let i = 0; i < bound; i++) {
      if (this[i] < other[i]) return -1;
      if (this[i] > other[i]) return 1;
    }
    if (this.length < other.length) return -1;
    if (this.length > other.length) return 1;
    return 0;
  }

  equals(other: Uint8Array): boolean {
    return this.compare(other) === 0;
  }

  toJSON(): { type: string; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  hasOwnProperty(key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(this, key);
  }

  indexOf(needle: number | Uint8Array | string, fromIndex?: number): number {
    const start = fromIndex || 0;
    if (typeof needle === 'number') {
      for (let i = start; i < this.length; i++) {
        if (this[i] === needle) return i;
      }
      return -1;
    }
    const search = typeof needle === 'string' ? BufferPolyfill.from(needle) : needle;
    for (let i = start; i <= this.length - search.length; i++) {
      let match = true;
      for (let j = 0; j < search.length; j++) {
        if (this[i + j] !== search[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  includes(needle: number | Uint8Array | string, fromIndex?: number): boolean {
    return this.indexOf(needle, fromIndex) !== -1;
  }

  // ---- Unsigned integer reads ----

  readUInt8(pos: number): number {
    return this[pos];
  }

  readUInt16BE(pos: number): number {
    return (this[pos] << 8) | this[pos + 1];
  }

  readUInt16LE(pos: number): number {
    return this[pos] | (this[pos + 1] << 8);
  }

  readUInt32BE(pos: number): number {
    return ((this[pos] << 24) | (this[pos + 1] << 16) | (this[pos + 2] << 8) | this[pos + 3]) >>> 0;
  }

  readUInt32LE(pos: number): number {
    return ((this[pos]) | (this[pos + 1] << 8) | (this[pos + 2] << 16) | (this[pos + 3] << 24)) >>> 0;
  }

  // ---- Unsigned integer writes ----

  writeUInt8(val: number, pos: number): number {
    this[pos] = val & 0xff;
    return pos + 1;
  }

  writeUInt16BE(val: number, pos: number): number {
    this[pos] = (val >>> 8) & 0xff;
    this[pos + 1] = val & 0xff;
    return pos + 2;
  }

  writeUInt16LE(val: number, pos: number): number {
    this[pos] = val & 0xff;
    this[pos + 1] = (val >>> 8) & 0xff;
    return pos + 2;
  }

  writeUInt32BE(val: number, pos: number): number {
    this[pos] = (val >>> 24) & 0xff;
    this[pos + 1] = (val >>> 16) & 0xff;
    this[pos + 2] = (val >>> 8) & 0xff;
    this[pos + 3] = val & 0xff;
    return pos + 4;
  }

  writeUInt32LE(val: number, pos: number): number {
    this[pos] = val & 0xff;
    this[pos + 1] = (val >>> 8) & 0xff;
    this[pos + 2] = (val >>> 16) & 0xff;
    this[pos + 3] = (val >>> 24) & 0xff;
    return pos + 4;
  }

  // ---- Lowercase aliases ----
  readUint8(pos: number): number { return this.readUInt8(pos); }
  readUint16BE(pos: number): number { return this.readUInt16BE(pos); }
  readUint16LE(pos: number): number { return this.readUInt16LE(pos); }
  readUint32BE(pos: number): number { return this.readUInt32BE(pos); }
  readUint32LE(pos: number): number { return this.readUInt32LE(pos); }
  writeUint8(val: number, pos: number): number { return this.writeUInt8(val, pos); }
  writeUint16BE(val: number, pos: number): number { return this.writeUInt16BE(val, pos); }
  writeUint16LE(val: number, pos: number): number { return this.writeUInt16LE(val, pos); }
  writeUint32BE(val: number, pos: number): number { return this.writeUInt32BE(val, pos); }
  writeUint32LE(val: number, pos: number): number { return this.writeUInt32LE(val, pos); }

  // ---- Signed integer reads ----

  readInt8(pos: number): number {
    const raw = this[pos];
    return raw & 0x80 ? raw - 0x100 : raw;
  }

  readInt16BE(pos: number): number {
    const raw = this.readUInt16BE(pos);
    return raw & 0x8000 ? raw - 0x10000 : raw;
  }

  readInt16LE(pos: number): number {
    const raw = this.readUInt16LE(pos);
    return raw & 0x8000 ? raw - 0x10000 : raw;
  }

  readInt32BE(pos: number): number {
    return this.readUInt32BE(pos) | 0;
  }

  readInt32LE(pos: number): number {
    return this.readUInt32LE(pos) | 0;
  }

  // ---- Signed integer writes ----

  writeInt8(val: number, pos: number): number {
    this[pos] = val & 0xff;
    return pos + 1;
  }

  writeInt16BE(val: number, pos: number): number {
    return this.writeUInt16BE(val & 0xffff, pos);
  }

  writeInt16LE(val: number, pos: number): number {
    return this.writeUInt16LE(val & 0xffff, pos);
  }

  writeInt32BE(val: number, pos: number): number {
    return this.writeUInt32BE(val >>> 0, pos);
  }

  writeInt32LE(val: number, pos: number): number {
    return this.writeUInt32LE(val >>> 0, pos);
  }

  // ---- BigInt 64-bit reads ----

  readBigUInt64LE(pos: number): bigint {
    const lo = BigInt(this[pos] | (this[pos + 1] << 8) | (this[pos + 2] << 16) | (this[pos + 3] << 24)) & 0xffffffffn;
    const hi = BigInt(this[pos + 4] | (this[pos + 5] << 8) | (this[pos + 6] << 16) | (this[pos + 7] << 24)) & 0xffffffffn;
    return lo | (hi << 32n);
  }

  readBigUInt64BE(pos: number): bigint {
    const hi = BigInt(this[pos] << 24 | this[pos + 1] << 16 | this[pos + 2] << 8 | this[pos + 3]) & 0xffffffffn;
    const lo = BigInt(this[pos + 4] << 24 | this[pos + 5] << 16 | this[pos + 6] << 8 | this[pos + 7]) & 0xffffffffn;
    return lo | (hi << 32n);
  }

  readBigInt64LE(pos: number): bigint {
    const unsigned = this.readBigUInt64LE(pos);
    return unsigned >= 0x8000000000000000n ? unsigned - 0x10000000000000000n : unsigned;
  }

  readBigInt64BE(pos: number): bigint {
    const unsigned = this.readBigUInt64BE(pos);
    return unsigned >= 0x8000000000000000n ? unsigned - 0x10000000000000000n : unsigned;
  }

  // ---- BigInt 64-bit writes ----

  writeBigUInt64LE(val: bigint, pos: number): number {
    const lo = val & 0xffffffffn;
    const hi = (val >> 32n) & 0xffffffffn;
    this[pos] = Number(lo & 0xffn);
    this[pos + 1] = Number((lo >> 8n) & 0xffn);
    this[pos + 2] = Number((lo >> 16n) & 0xffn);
    this[pos + 3] = Number((lo >> 24n) & 0xffn);
    this[pos + 4] = Number(hi & 0xffn);
    this[pos + 5] = Number((hi >> 8n) & 0xffn);
    this[pos + 6] = Number((hi >> 16n) & 0xffn);
    this[pos + 7] = Number((hi >> 24n) & 0xffn);
    return pos + 8;
  }

  writeBigUInt64BE(val: bigint, pos: number): number {
    const lo = val & 0xffffffffn;
    const hi = (val >> 32n) & 0xffffffffn;
    this[pos] = Number((hi >> 24n) & 0xffn);
    this[pos + 1] = Number((hi >> 16n) & 0xffn);
    this[pos + 2] = Number((hi >> 8n) & 0xffn);
    this[pos + 3] = Number(hi & 0xffn);
    this[pos + 4] = Number((lo >> 24n) & 0xffn);
    this[pos + 5] = Number((lo >> 16n) & 0xffn);
    this[pos + 6] = Number((lo >> 8n) & 0xffn);
    this[pos + 7] = Number(lo & 0xffn);
    return pos + 8;
  }

  writeBigInt64LE(val: bigint, pos: number): number {
    const unsigned = val < 0n ? val + 0x10000000000000000n : val;
    return this.writeBigUInt64LE(unsigned, pos);
  }

  writeBigInt64BE(val: bigint, pos: number): number {
    const unsigned = val < 0n ? val + 0x10000000000000000n : val;
    return this.writeBigUInt64BE(unsigned, pos);
  }

  // Lowercase BigInt aliases
  readBigUint64LE(pos: number): bigint { return this.readBigUInt64LE(pos); }
  readBigUint64BE(pos: number): bigint { return this.readBigUInt64BE(pos); }
  writeBigUint64LE(val: bigint, pos: number): number { return this.writeBigUInt64LE(val, pos); }
  writeBigUint64BE(val: bigint, pos: number): number { return this.writeBigUInt64BE(val, pos); }

  // ---- Float / Double reads ----

  readFloatLE(pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 4);
    return dv.getFloat32(0, true);
  }

  readFloatBE(pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 4);
    return dv.getFloat32(0, false);
  }

  readDoubleLE(pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 8);
    return dv.getFloat64(0, true);
  }

  readDoubleBE(pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 8);
    return dv.getFloat64(0, false);
  }

  // ---- Float / Double writes ----

  writeFloatLE(val: number, pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 4);
    dv.setFloat32(0, val, true);
    return pos + 4;
  }

  writeFloatBE(val: number, pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 4);
    dv.setFloat32(0, val, false);
    return pos + 4;
  }

  writeDoubleLE(val: number, pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 8);
    dv.setFloat64(0, val, true);
    return pos + 8;
  }

  writeDoubleBE(val: number, pos: number): number {
    const dv = new DataView(this.buffer, this.byteOffset + pos, 8);
    dv.setFloat64(0, val, false);
    return pos + 8;
  }

  // ---- Variable-length integer reads ----

  readUIntLE(pos: number, width: number): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < width; i++) {
      result += this[pos + i] * factor;
      factor *= 0x100;
    }
    return result;
  }

  readUintLE(pos: number, width: number): number { return this.readUIntLE(pos, width); }

  readUIntBE(pos: number, width: number): number {
    let result = 0;
    let factor = 1;
    for (let i = width - 1; i >= 0; i--) {
      result += this[pos + i] * factor;
      factor *= 0x100;
    }
    return result;
  }

  readUintBE(pos: number, width: number): number { return this.readUIntBE(pos, width); }

  readIntLE(pos: number, width: number): number {
    let raw = this.readUIntLE(pos, width);
    const threshold = Math.pow(2, (width * 8) - 1);
    if (raw >= threshold) raw -= Math.pow(2, width * 8);
    return raw;
  }

  readIntBE(pos: number, width: number): number {
    let raw = this.readUIntBE(pos, width);
    const threshold = Math.pow(2, (width * 8) - 1);
    if (raw >= threshold) raw -= Math.pow(2, width * 8);
    return raw;
  }

  // ---- Variable-length integer writes ----

  writeUIntLE(val: number, pos: number, width: number): number {
    let remaining = val;
    for (let i = 0; i < width; i++) {
      this[pos + i] = remaining & 0xff;
      remaining = Math.floor(remaining / 0x100);
    }
    return pos + width;
  }

  writeUintLE(val: number, pos: number, width: number): number { return this.writeUIntLE(val, pos, width); }

  writeUIntBE(val: number, pos: number, width: number): number {
    let remaining = val;
    for (let i = width - 1; i >= 0; i--) {
      this[pos + i] = remaining & 0xff;
      remaining = Math.floor(remaining / 0x100);
    }
    return pos + width;
  }

  writeUintBE(val: number, pos: number, width: number): number { return this.writeUIntBE(val, pos, width); }

  writeIntLE(val: number, pos: number, width: number): number {
    let adjusted = val;
    if (adjusted < 0) adjusted += Math.pow(2, width * 8);
    return this.writeUIntLE(adjusted, pos, width);
  }

  writeIntBE(val: number, pos: number, width: number): number {
    let adjusted = val;
    if (adjusted < 0) adjusted += Math.pow(2, width * 8);
    return this.writeUIntBE(adjusted, pos, width);
  }

  // ---- Byte swap methods ----

  swap16(): this {
    if (this.length % 2 !== 0) throw new RangeError('Buffer size must be a multiple of 16-bits');
    for (let i = 0; i < this.length; i += 2) {
      const tmp = this[i];
      this[i] = this[i + 1];
      this[i + 1] = tmp;
    }
    return this;
  }

  swap32(): this {
    if (this.length % 4 !== 0) throw new RangeError('Buffer size must be a multiple of 32-bits');
    for (let i = 0; i < this.length; i += 4) {
      const a = this[i], b = this[i + 1];
      this[i] = this[i + 3];
      this[i + 1] = this[i + 2];
      this[i + 2] = b;
      this[i + 3] = a;
    }
    return this;
  }

  swap64(): this {
    if (this.length % 8 !== 0) throw new RangeError('Buffer size must be a multiple of 64-bits');
    for (let i = 0; i < this.length; i += 8) {
      const a = this[i], b = this[i + 1], c = this[i + 2], d = this[i + 3];
      this[i] = this[i + 7]; this[i + 1] = this[i + 6];
      this[i + 2] = this[i + 5]; this[i + 3] = this[i + 4];
      this[i + 4] = d; this[i + 5] = c;
      this[i + 6] = b; this[i + 7] = a;
    }
    return this;
  }
}

// Wrap BufferPolyfill so it can be called without `new` (like Node.js's deprecated Buffer())
// Cast to BufferConstructor so downstream code sees Node.js-compatible Buffer types.
const Buffer = new Proxy(BufferPolyfill, {
  apply(_target, _thisArg, args) {
    // Buffer(string, encoding) or Buffer(size) or Buffer(array) — deprecated but still works in Node
    return (BufferPolyfill as any).from(...args);
  },
}) as unknown as BufferConstructor & typeof BufferPolyfill;

// Install on globalThis if missing
if (typeof globalThis.Buffer === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Buffer = Buffer;
}

export { Buffer };

// Secondary exports matching Node.js `buffer` module surface
export const SlowBuffer = Buffer;
export const kMaxLength = 2147483647;
export const INSPECT_MAX_BYTES = 50;

export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: 536870888,
};

export function transcode(
  src: Uint8Array,
  _fromEnc: string,
  _toEnc: string
): InstanceType<typeof BufferPolyfill> {
  return BufferPolyfill.from(src);
}

export function resolveObjectURL(_id: string): undefined {
  return undefined;
}

export function atob(data: string): string {
  return globalThis.atob(data);
}

export function btoa(data: string): string {
  return globalThis.btoa(data);
}

const bufferModule: Record<string, unknown> = {
  Buffer: BufferPolyfill,
  SlowBuffer,
  kMaxLength,
  INSPECT_MAX_BYTES,
  constants,
  transcode,
  resolveObjectURL,
  atob,
  btoa,
};

Object.defineProperty(bufferModule, 'hasOwnProperty', {
  value: Object.prototype.hasOwnProperty,
  enumerable: false,
  configurable: true,
  writable: true,
});

export default bufferModule;
