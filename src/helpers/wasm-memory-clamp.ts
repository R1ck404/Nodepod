// napi-rs WASI loaders create their shared (threads) memory with a large
// fixed initial size: rolldown's asks for 16384 pages, 1 GiB committed in
// every process that loads it, although its module only declares 998 pages
// (62 MiB) and grows on demand. Here such memories start small and are grown
// to the importing module's declared minimum when it is instantiated, which
// is all the module needs to link. A module whose minimum can't be read
// (compiled from a stream, or received from another thread) gets the size
// the loader asked for, so nothing links against a smaller memory than before.
//
// Only memories that may grow are clamped (a fixed-size heap is sized on
// purpose), and a clamped memory whose buffer is touched, or which is grown,
// before any module imported it gets the size the loader asked for first:
// code that builds views over the memory up front sees what it expects.

const WASM_PAGE = 65536;
// only large up-front reservations are worth deferring
const CLAMP_FROM_PAGES = 1024;
const PLACEHOLDER_PAGES = 64;
const MAX_PAGES = 65536;

interface ClampedInfo {
  requestedPages: number;
  maximumPages: number;
}

const clamped = new WeakMap<WebAssembly.Memory, ClampedInfo>();
const moduleMinPages = new WeakMap<WebAssembly.Module, number>();
let installed = false;

// unsigned LEB128 of any length (u64 limits included); precise up to 2^53
function readLeb(bytes: Uint8Array, state: { p: number }): number {
  let result = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (state.p >= bytes.length) throw new Error("truncated");
    const b = bytes[state.p++];
    result += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return result;
    scale *= 128;
  }
  throw new Error("LEB128 too long");
}

// a value/reference type: one byte, or (typed references / GC) a nullable or
// non-null reference prefix followed by a heap type (signed LEB)
function skipValType(bytes: Uint8Array, state: { p: number }): void {
  const t = bytes[state.p++];
  if (t === 0x63 || t === 0x64) readLeb(bytes, state);
}

/** Minimum pages of the module's imported memory, or null if none/unknown. */
export function importedMemoryMinPages(source: ArrayBuffer | ArrayBufferView): number | null {
  let bytes: Uint8Array;
  if (source instanceof Uint8Array) bytes = source;
  else if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else bytes = new Uint8Array(source as ArrayBuffer);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  const st = { p: 8 };
  try {
    while (st.p < bytes.length) {
      const id = bytes[st.p++];
      const size = readLeb(bytes, st);
      const end = st.p + size;
      if (id === 2) {
        const count = readLeb(bytes, st);
        for (let i = 0; i < count; i++) {
          // module and field names (read the length first: it advances p)
          const moduleNameLength = readLeb(bytes, st);
          st.p += moduleNameLength;
          const fieldNameLength = readLeb(bytes, st);
          st.p += fieldNameLength;
          const kind = bytes[st.p++];
          if (kind === 0) {
            readLeb(bytes, st); // type index
          } else if (kind === 1) {
            skipValType(bytes, st); // table element type
            const flags = bytes[st.p++];
            readLeb(bytes, st);
            if (flags & 1) readLeb(bytes, st);
          } else if (kind === 2) {
            st.p++; // limits flags
            const min = readLeb(bytes, st);
            return min <= MAX_PAGES ? min : null;
          } else if (kind === 3) {
            skipValType(bytes, st);
            st.p++; // mutability
          } else if (kind === 4) {
            st.p++; // tag attribute
            readLeb(bytes, st);
          } else {
            return null;
          }
          if (st.p > end) return null;
        }
        return null;
      }
      // imports precede every section that could matter; stop at code
      if (id > 2 && id !== 0) return null;
      st.p = end;
    }
  } catch {
    /* malformed: unknown */
  }
  return null;
}

let nativeBuffer: (this: WebAssembly.Memory) => ArrayBuffer = function (this: WebAssembly.Memory) {
  return this.buffer;
};
let nativeGrow: (this: WebAssembly.Memory, delta: number) => number = function (this: WebAssembly.Memory, delta: number) {
  return this.grow(delta);
};

function pagesOf(memory: WebAssembly.Memory): number {
  return nativeBuffer.call(memory).byteLength / WASM_PAGE;
}

// back to a plain memory of at least `pages`
function unclamp(memory: WebAssembly.Memory, pages: number): void {
  const info = clamped.get(memory);
  if (!info) return;
  clamped.delete(memory);
  delete (memory as unknown as Record<string, unknown>).buffer;
  delete (memory as unknown as Record<string, unknown>).grow;
  const target = Math.min(pages, info.maximumPages);
  const current = pagesOf(memory);
  if (current < target) nativeGrow.call(memory, target - current);
}

function fixImports(minPages: number | null, imports: unknown): void {
  if (!imports || typeof imports !== "object") return;
  for (const ns of Object.values(imports as Record<string, unknown>)) {
    if (!ns || typeof ns !== "object") continue;
    for (const value of Object.values(ns as Record<string, unknown>)) {
      if (!(value instanceof WebAssembly.Memory)) continue;
      const info = clamped.get(value);
      if (info) unclamp(value, minPages ?? info.requestedPages);
    }
  }
}

function hasClampedImport(imports: unknown): boolean {
  if (!imports || typeof imports !== "object") return false;
  for (const ns of Object.values(imports as Record<string, unknown>)) {
    if (!ns || typeof ns !== "object") continue;
    for (const value of Object.values(ns as Record<string, unknown>)) {
      if (value instanceof WebAssembly.Memory && clamped.has(value)) return true;
    }
  }
  return false;
}

/** Install the clamp on this realm's WebAssembly namespace (idempotent). */
export function installWasmMemoryClamp(): void {
  if (installed || typeof WebAssembly === "undefined") return;
  installed = true;
  const W = WebAssembly as unknown as Record<string, any>;
  const NativeMemory = W.Memory as typeof WebAssembly.Memory;
  const NativeModule = W.Module as typeof WebAssembly.Module;
  const NativeInstance = W.Instance as typeof WebAssembly.Instance;
  const nativeCompile = W.compile as typeof WebAssembly.compile;
  const nativeInstantiate = W.instantiate as typeof WebAssembly.instantiate;
  const nativeInstantiateStreaming = W.instantiateStreaming as typeof WebAssembly.instantiateStreaming | undefined;
  const bufferGetter = Object.getOwnPropertyDescriptor(NativeMemory.prototype, "buffer")?.get;
  if (bufferGetter) nativeBuffer = bufferGetter as typeof nativeBuffer;
  nativeGrow = NativeMemory.prototype.grow as typeof nativeGrow;

  const Memory = function Memory(this: unknown, descriptor: WebAssembly.MemoryDescriptor) {
    if (
      descriptor &&
      descriptor.shared &&
      typeof descriptor.initial === "number" &&
      descriptor.initial >= CLAMP_FROM_PAGES &&
      typeof descriptor.maximum === "number" &&
      descriptor.maximum > descriptor.initial
    ) {
      const memory = new NativeMemory({ ...descriptor, initial: PLACEHOLDER_PAGES });
      const info: ClampedInfo = { requestedPages: descriptor.initial, maximumPages: descriptor.maximum };
      clamped.set(memory, info);
      // touched before any module imported it: the loader works with the
      // memory directly, so give it the size it asked for
      Object.defineProperty(memory, "buffer", {
        configurable: true,
        get() {
          unclamp(memory, info.requestedPages);
          return nativeBuffer.call(memory);
        },
      });
      Object.defineProperty(memory, "grow", {
        configurable: true,
        writable: true,
        value(delta: number) {
          unclamp(memory, info.requestedPages);
          return nativeGrow.call(memory, delta);
        },
      });
      return memory;
    }
    return new NativeMemory(descriptor);
  } as unknown as typeof WebAssembly.Memory;
  Memory.prototype = NativeMemory.prototype;
  W.Memory = Memory;

  const record = (module: WebAssembly.Module, bytes: BufferSource): void => {
    const min = importedMemoryMinPages(bytes);
    if (min !== null) moduleMinPages.set(module, min);
  };

  const Module = function Module(this: unknown, bytes: BufferSource) {
    const module = new NativeModule(bytes);
    record(module, bytes);
    return module;
  } as unknown as typeof WebAssembly.Module;
  Module.prototype = NativeModule.prototype;
  (Module as any).imports = NativeModule.imports.bind(NativeModule);
  (Module as any).exports = NativeModule.exports.bind(NativeModule);
  (Module as any).customSections = NativeModule.customSections.bind(NativeModule);
  W.Module = Module;

  W.compile = async (bytes: BufferSource) => {
    const module = await nativeCompile(bytes);
    record(module, bytes);
    return module;
  };

  const Instance = function Instance(
    this: unknown,
    module: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) {
    fixImports(moduleMinPages.get(module) ?? null, imports);
    return new NativeInstance(module, imports);
  } as unknown as typeof WebAssembly.Instance;
  Instance.prototype = NativeInstance.prototype;
  W.Instance = Instance;

  W.instantiate = (source: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) => {
    try {
      if (source instanceof NativeModule) {
        fixImports(moduleMinPages.get(source) ?? null, imports);
      } else {
        fixImports(importedMemoryMinPages(source as BufferSource), imports);
      }
    } catch (err) {
      // e.g. growing past the memory's maximum: reject like instantiate would
      return Promise.reject(err);
    }
    return (nativeInstantiate as any)(source, imports);
  };

  if (nativeInstantiateStreaming) {
    // a clamped memory needs the module's bytes to size it: fetch them
    // whole in that (rare) case, stream everything else as before
    W.instantiateStreaming = async (source: Response | PromiseLike<Response>, imports?: WebAssembly.Imports) => {
      if (!hasClampedImport(imports)) return nativeInstantiateStreaming(source, imports);
      const response = await source;
      return W.instantiate(await response.arrayBuffer(), imports);
    };
  }
}
