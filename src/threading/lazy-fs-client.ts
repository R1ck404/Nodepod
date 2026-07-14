// Synchronous fs proxy client for lean spawn mode. The process worker blocks
// on a SAB + Atomics.wait round-trip to the main thread, which services the
// request with handleFsProxy (same wire protocol as the WASI fs proxy in
// napi-wasm-worker.ts):
//   request:  port.postMessage({ __fs__: { sab: Int32Array, type, payload } })
//   header:   [0] status (-1 pending, 0 ok, 1 err)  [1] result type
//             [2] payload byte length               [3] request sequence
//   payload:  bytes after the 16-byte header
// Result types: 0=undefined 1=null 2=bool 3=number 4=string 5=buffer 6=json 9=bigint

import type { VolumeMissHandler } from "../memory-volume";

const HEADER_BYTES = 16;
const DEFAULT_PAYLOAD = 256 * 1024;
const MAX_RETAINED_PAYLOAD = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 5000;
const WASM_RECOVERY_TIMEOUT_MS = 120000;

interface ProxyResult {
  ok: boolean;
  resultType: number;
  bytes: Uint8Array; // copied out of the SAB
  truncated: boolean;
  fullLength: number;
}

interface CallState {
  sab: SharedArrayBuffer | null;
  capacity: number;
  sequence: number;
}

function nextCapacity(required: number): number {
  let capacity = DEFAULT_PAYLOAD;
  while (capacity < required && capacity < MAX_RETAINED_PAYLOAD) capacity *= 2;
  return Math.max(required, capacity);
}

function call(
  state: CallState,
  port: MessagePort,
  type: string,
  payload: unknown[],
  payloadCapacity: number,
): ProxyResult | null {
  let sab: SharedArrayBuffer;
  const retained = payloadCapacity <= MAX_RETAINED_PAYLOAD;
  try {
    if (retained && (!state.sab || state.capacity < payloadCapacity)) {
      state.capacity = nextCapacity(payloadCapacity);
      state.sab = new SharedArrayBuffer(HEADER_BYTES + state.capacity);
    }
    sab = retained
      ? state.sab!
      : new SharedArrayBuffer(HEADER_BYTES + payloadCapacity);
  } catch {
    return null;
  }
  const ctrl = new Int32Array(sab, 0, 4);
  ctrl.fill(0);
  Atomics.store(ctrl, 0, -1);
  Atomics.store(ctrl, 3, ++state.sequence);

  try {
    port.postMessage({ __fs__: { sab: ctrl, type, payload } });
  } catch {
    return null;
  }

  const target = payload[0];
  const timeout = typeof target === "string"
    && target.endsWith(".wasm")
    && target.includes("/node_modules/")
    ? WASM_RECOVERY_TIMEOUT_MS
    : CALL_TIMEOUT_MS;
  const waited = Atomics.wait(ctrl, 0, -1, timeout);
  if (waited === "timed-out") {
    if (retained && state.sab === sab) {
      state.sab = null;
      state.capacity = 0;
    }
    return null;
  }

  const status = Atomics.load(ctrl, 0);
  const resultType = Atomics.load(ctrl, 1);
  const fullLength = Atomics.load(ctrl, 2);
  const actualCapacity = sab.byteLength - HEADER_BYTES;
  const available = Math.min(fullLength, actualCapacity);
  const bytes = new Uint8Array(available);
  bytes.set(new Uint8Array(sab, HEADER_BYTES, available));

  return {
    ok: status === 0,
    resultType,
    bytes,
    truncated: fullLength > actualCapacity,
    fullLength,
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// Builds a VolumeMissHandler backed by a dedicated MessagePort to the tab's
// fs bridge. All methods return null on any failure (treated as a miss).
export function createLazyFsClient(port: MessagePort): VolumeMissHandler {
  const state: CallState = { sab: null, capacity: 0, sequence: 0 };
  const knownSizes = new Map<string, number>();
  return {
    stat(path: string) {
      const res = call(state, port, "statSync", [path], DEFAULT_PAYLOAD);
      if (!res || !res.ok) return null;
      const st = decodeJson(res.bytes) as
        | { _isFile?: boolean; _isDir?: boolean; size?: number }
        | null;
      if (!st) return null;
      const stat = {
        isFile: !!st._isFile,
        isDirectory: !!st._isDir,
        size: st.size ?? 0,
      };
      if (stat.isFile) knownSizes.set(path, stat.size);
      return stat;
    },

    statMany(paths: string[]) {
      let res = call(state, port, "statMany", [paths], DEFAULT_PAYLOAD);
      if (res && res.ok && res.truncated) {
        res = call(state, port, "statMany", [paths], res.fullLength + 1024);
      }
      if (!res || !res.ok) return null;
      const stats = decodeJson(res.bytes) as Array<{
        _isFile?: boolean;
        _isDir?: boolean;
        size?: number;
      } | null> | null;
      if (!Array.isArray(stats)) return null;
      return stats.map((stat, index) => {
        if (!stat) return null;
        const value = {
          isFile: !!stat._isFile,
          isDirectory: !!stat._isDir,
          size: stat.size ?? 0,
        };
        if (value.isFile && paths[index]) knownSizes.set(paths[index]!, value.size);
        return value;
      });
    },

    readFile(path: string) {
      const knownSize = knownSizes.get(path) ?? 0;
      let res = call(
        state,
        port,
        "readFileSync",
        [path],
        knownSize > DEFAULT_PAYLOAD ? knownSize + 1024 : DEFAULT_PAYLOAD,
      );
      if (res && res.ok && res.truncated) {
        // retry with a buffer sized to the reported full length
        res = call(state, port, "readFileSync", [path], res.fullLength + 1024);
      }
      if (!res || !res.ok) return null;
      // buffer (5) or string (4) — the bridge returns bytes for no-encoding reads
      if (res.resultType === 5 || res.resultType === 4) return res.bytes;
      return null;
    },

    readdir(path: string) {
      let res = call(state, port, "readdirWithTypes", [path], DEFAULT_PAYLOAD);
      if (res && res.ok && res.truncated) {
        res = call(state, port, "readdirWithTypes", [path], res.fullLength + 1024);
      }
      if (!res || !res.ok) return null;
      const entries = decodeJson(res.bytes) as
        | Array<{ name?: string; _isDir?: boolean; size?: number }>
        | null;
      if (!Array.isArray(entries)) return null;
      const out: Array<{ name: string; isDirectory: boolean; size?: number }> = [];
      for (const e of entries) {
        if (!e || typeof e.name !== "string") continue;
        const entry = { name: e.name, isDirectory: !!e._isDir, size: e.size };
        out.push(entry);
        if (!entry.isDirectory && entry.size !== undefined) {
          const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
          knownSizes.set(child, entry.size);
        }
      }
      return out;
    },
  };
}
