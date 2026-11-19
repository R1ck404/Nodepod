// heap and coverage functions are stubs: they are not available in the browser

import { Buffer } from "./buffer.js";

export function getHeapStatistics() {
  return {
    total_heap_size: 0,
    total_heap_size_executable: 0,
    total_physical_size: 0,
    total_available_size: 0,
    used_heap_size: 0,
    heap_size_limit: 0,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
  };
}

export function getHeapSpaceStatistics(): unknown[] {
  return [];
}

export function getHeapCodeStatistics() {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
  };
}

export function getHeapSnapshot(): null { return null; }
export function writeHeapSnapshot(): string { return ''; }


export function setFlagsFromString(_flags: string): void {}
export function takeCoverage(): void {}
export function stopCoverage(): void {}

export function cachedDataVersionTag(): number {
  return 0;
}

/*
 * v8.serialize / v8.deserialize
 *
 * Node's structured serializer keeps types that JSON loses. This encoder keeps the ones programs
 * rely on when passing data between processes (Vitest's worker RPC, for example): undefined, NaN,
 * ±Infinity, -0, BigInt, Date, RegExp, Map, Set, Error, ArrayBuffer, typed arrays, Buffer and
 * shared or circular references. The result is a Buffer, as in Node.
 */
const V8_MAGIC = "\u0000nodepod-v8:1\u0000";
type Enc = unknown;

const TYPED: Record<string, { new (b: ArrayBuffer): ArrayBufferView }> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
} as unknown as Record<string, { new (b: ArrayBuffer): ArrayBufferView }>;

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeValue(value: unknown, seen: Map<object, number>): Enc {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isNaN(value)) return { $t: "n", v: "NaN" };
      if (value === Infinity) return { $t: "n", v: "Infinity" };
      if (value === -Infinity) return { $t: "n", v: "-Infinity" };
      if (Object.is(value, -0)) return { $t: "n", v: "-0" };
      return value;
    case "undefined":
      return { $t: "u" };
    case "bigint":
      return { $t: "bi", v: value.toString() };
    case "function":
    case "symbol": {
      const err = new Error(`${String(value)} could not be cloned.`);
      err.name = "DataCloneError";
      throw err;
    }
  }
  if (value === null) return null;
  const obj = value as object;
  const ref = seen.get(obj);
  if (ref !== undefined) return { $t: "r", id: ref };
  const id = seen.size;
  seen.set(obj, id);

  if (obj instanceof Date) return { $t: "d", id, v: obj.getTime() };
  if (obj instanceof RegExp) return { $t: "re", id, s: obj.source, f: obj.flags };
  if (obj instanceof ArrayBuffer) return { $t: "ab", id, v: bytesToB64(new Uint8Array(obj)) };
  if (ArrayBuffer.isView(obj)) {
    const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    const kind = Buffer.isBuffer(obj) ? "Buffer" : obj instanceof DataView ? "DataView" : (obj.constructor as { name: string }).name;
    return { $t: "ta", id, k: kind, v: bytesToB64(bytes) };
  }
  if (obj instanceof Map) {
    return { $t: "m", id, v: [...obj].map(([k, v]) => [encodeValue(k, seen), encodeValue(v, seen)]) };
  }
  if (obj instanceof Set) return { $t: "s", id, v: [...obj].map((v) => encodeValue(v, seen)) };
  if (obj instanceof Error) {
    const e = obj as Error & Record<string, unknown>;
    const extra: Record<string, Enc> = {};
    for (const k of Object.keys(e)) extra[k] = encodeValue(e[k], seen);
    if (e.cause !== undefined && !("cause" in extra)) extra.cause = encodeValue(e.cause, seen);
    return { $t: "e", id, n: e.name, m: e.message, st: e.stack, x: extra };
  }
  if (Array.isArray(obj)) return { $t: "a", id, v: obj.map((v) => encodeValue(v, seen)) };
  const out: Record<string, Enc> = {};
  for (const k of Object.keys(obj)) out[k] = encodeValue((obj as Record<string, unknown>)[k], seen);
  return { $t: "o", id, v: out };
}

function decodeValue(enc: Enc, refs: Map<number, unknown>): unknown {
  if (enc === null || typeof enc !== "object") return enc;
  const e = enc as Record<string, any>;
  switch (e.$t) {
    case "n":
      return e.v === "NaN" ? NaN : e.v === "Infinity" ? Infinity : e.v === "-Infinity" ? -Infinity : -0;
    case "u":
      return undefined;
    case "bi":
      return BigInt(e.v);
    case "r":
      return refs.get(e.id);
    case "d": {
      const d = new Date(e.v);
      refs.set(e.id, d);
      return d;
    }
    case "re": {
      const r = new RegExp(e.s, e.f);
      refs.set(e.id, r);
      return r;
    }
    case "ab": {
      const ab = b64ToBytes(e.v).buffer;
      refs.set(e.id, ab);
      return ab;
    }
    case "ta": {
      const bytes = b64ToBytes(e.v);
      let view: unknown;
      if (e.k === "Buffer") view = Buffer.from(bytes);
      else if (e.k === "DataView") view = new DataView(bytes.buffer as ArrayBuffer);
      else view = new (TYPED[e.k] ?? Uint8Array)(bytes.buffer as ArrayBuffer);
      refs.set(e.id, view);
      return view;
    }
    case "m": {
      const m = new Map();
      refs.set(e.id, m);
      for (const [k, v] of e.v) m.set(decodeValue(k, refs), decodeValue(v, refs));
      return m;
    }
    case "s": {
      const set = new Set();
      refs.set(e.id, set);
      for (const v of e.v) set.add(decodeValue(v, refs));
      return set;
    }
    case "e": {
      const Ctor = (globalThis as Record<string, unknown>)[e.n];
      const err = (
        typeof Ctor === "function" && (Ctor as { prototype?: unknown }).prototype instanceof Error
          ? new (Ctor as ErrorConstructor)(e.m)
          : new Error(e.m)
      ) as Error & Record<string, unknown>;
      if (err.name !== e.n) err.name = e.n;
      if (e.st !== undefined) err.stack = e.st;
      refs.set(e.id, err);
      for (const k of Object.keys(e.x ?? {})) err[k] = decodeValue(e.x[k], refs);
      return err;
    }
    case "a": {
      const arr: unknown[] = [];
      refs.set(e.id, arr);
      for (const v of e.v) arr.push(decodeValue(v, refs));
      return arr;
    }
    case "o": {
      const o: Record<string, unknown> = {};
      refs.set(e.id, o);
      for (const k of Object.keys(e.v)) o[k] = decodeValue(e.v[k], refs);
      return o;
    }
    default:
      return enc;
  }
}

export function serialize(value: unknown): Buffer {
  const json = V8_MAGIC + JSON.stringify(encodeValue(value, new Map()));
  return Buffer.from(new TextEncoder().encode(json));
}

/** Accepts the bytes from serialize(), including a Buffer that crossed a JSON channel as {type, data}. */
export function deserialize(input: Uint8Array | ArrayBuffer | { type: "Buffer"; data: number[] }): unknown {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input && (input as { type?: string }).type === "Buffer") bytes = Uint8Array.from((input as { data: number[] }).data);
  else bytes = Uint8Array.from(Object.values(input as unknown as Record<string, number>));
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith(V8_MAGIC)) return JSON.parse(text);
  return decodeValue(JSON.parse(text.slice(V8_MAGIC.length)), new Map());
}

export interface Serializer {
  writeHeader(): void;
  writeValue(_v: unknown): void;
  releaseBuffer(): Uint8Array;
}

export const Serializer = function Serializer(this: any) {
  if (!this) return;
} as unknown as { new(): Serializer; prototype: any };

Serializer.prototype.writeHeader = function writeHeader(): void {};
Serializer.prototype.writeValue = function writeValue(_v: unknown): void {};
Serializer.prototype.releaseBuffer = function releaseBuffer(): Uint8Array { return new Uint8Array(0); };

export interface Deserializer {
  readHeader(): boolean;
  readValue(): unknown;
}

export const Deserializer = function Deserializer(this: any, _buf: Uint8Array) {
  if (!this) return;
} as unknown as { new(_buf: Uint8Array): Deserializer; prototype: any };

Deserializer.prototype.readHeader = function readHeader(): boolean { return true; };
Deserializer.prototype.readValue = function readValue(): unknown { return null; };

export interface DefaultSerializer extends Serializer {}

export const DefaultSerializer = function DefaultSerializer(this: any) {
  if (!this) return;
  (Serializer as any).call(this);
} as unknown as { new(): DefaultSerializer; prototype: any };

Object.setPrototypeOf(DefaultSerializer.prototype, Serializer.prototype);

export interface DefaultDeserializer extends Deserializer {}

export const DefaultDeserializer = function DefaultDeserializer(this: any, _buf: Uint8Array) {
  if (!this) return;
  (Deserializer as any).call(this, _buf);
} as unknown as { new(_buf: Uint8Array): DefaultDeserializer; prototype: any };

Object.setPrototypeOf(DefaultDeserializer.prototype, Deserializer.prototype);


export function promiseHooks() {
  return {
    onInit: () => {},
    onSettled: () => {},
    onBefore: () => {},
    onAfter: () => {},
    createHook: () => ({ enable: () => {}, disable: () => {} }),
  };
}


export default {
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  getHeapSnapshot,
  writeHeapSnapshot,
  setFlagsFromString,
  takeCoverage,
  stopCoverage,
  cachedDataVersionTag,
  serialize,
  deserialize,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  promiseHooks,
};
