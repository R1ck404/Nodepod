// Synchronous fs proxy client for lean spawn mode. The process worker blocks
// on a SAB + Atomics.wait round-trip to the main thread, which services the
// request with handleFsProxy (same wire protocol as the WASI fs proxy in
// napi-wasm-worker.ts):
//   request:  port.postMessage({ __fs__: { sab: Int32Array, type, payload } })
//   header:   [0] status (-1 pending, 0 ok, 1 err)  [1] result type
//             [2] payload byte length               [3] reserved
//   payload:  bytes after the 16-byte header
// Result types: 0=undefined 1=null 2=bool 3=number 4=string 5=buffer 6=json 9=bigint

import type { VolumeMissHandler } from "../memory-volume";

const HEADER_BYTES = 16;
const DEFAULT_PAYLOAD = 64 * 1024;
const CALL_TIMEOUT_MS = 5000;

interface ProxyResult {
  ok: boolean;
  resultType: number;
  bytes: Uint8Array; // copied out of the SAB
  truncated: boolean;
  fullLength: number;
}

function call(
  port: MessagePort,
  type: string,
  payload: unknown[],
  payloadCapacity: number,
): ProxyResult | null {
  let sab: SharedArrayBuffer;
  try {
    sab = new SharedArrayBuffer(HEADER_BYTES + payloadCapacity);
  } catch {
    return null;
  }
  const ctrl = new Int32Array(sab, 0, 4);
  Atomics.store(ctrl, 0, -1);

  try {
    port.postMessage({ __fs__: { sab: ctrl, type, payload } });
  } catch {
    return null;
  }

  const waited = Atomics.wait(ctrl, 0, -1, CALL_TIMEOUT_MS);
  if (waited === "timed-out") return null;

  const status = Atomics.load(ctrl, 0);
  const resultType = Atomics.load(ctrl, 1);
  const fullLength = Atomics.load(ctrl, 2);
  const available = Math.min(fullLength, payloadCapacity);
  const bytes = new Uint8Array(available);
  bytes.set(new Uint8Array(sab, HEADER_BYTES, available));

  return {
    ok: status === 0,
    resultType,
    bytes,
    truncated: fullLength > payloadCapacity,
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
  return {
    stat(path: string) {
      const res = call(port, "statSync", [path], DEFAULT_PAYLOAD);
      if (!res || !res.ok) return null;
      const st = decodeJson(res.bytes) as
        | { _isFile?: boolean; _isDir?: boolean; size?: number }
        | null;
      if (!st) return null;
      return {
        isFile: !!st._isFile,
        isDirectory: !!st._isDir,
        size: st.size ?? 0,
      };
    },

    readFile(path: string) {
      let res = call(port, "readFileSync", [path], DEFAULT_PAYLOAD);
      if (res && res.ok && res.truncated) {
        // retry with a buffer sized to the reported full length
        res = call(port, "readFileSync", [path], res.fullLength + 1024);
      }
      if (!res || !res.ok) return null;
      // buffer (5) or string (4) — the bridge returns bytes for no-encoding reads
      if (res.resultType === 5 || res.resultType === 4) return res.bytes;
      return null;
    },

    readdir(path: string) {
      let res = call(port, "readdirSync", [path, { withFileTypes: true }], DEFAULT_PAYLOAD);
      if (res && res.ok && res.truncated) {
        res = call(port, "readdirSync", [path, { withFileTypes: true }], res.fullLength + 1024);
      }
      if (!res || !res.ok) return null;
      const entries = decodeJson(res.bytes) as
        | Array<{ name?: string; _isDir?: boolean }>
        | null;
      if (!Array.isArray(entries)) return null;
      const out: Array<{ name: string; isDirectory: boolean }> = [];
      for (const e of entries) {
        if (!e || typeof e.name !== "string") continue;
        out.push({ name: e.name, isDirectory: !!e._isDir });
      }
      return out;
    },
  };
}
