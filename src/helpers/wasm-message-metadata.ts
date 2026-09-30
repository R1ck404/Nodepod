// Structured clone carries compiled WASM code but loses WeakMap metadata.
// Process messages attach the known memory requirements beside that code;
// structured clone preserves the module identity shared by payload + metadata.
import {
  rememberWasmMemoryRequirements,
  wasmMemoryRequirements,
  type WasmMemoryImport,
} from "./wasm-memory-clamp";

const FIELD = "__nodepodWasmMemoryMetadata";
type Annotation = [WebAssembly.Module, WasmMemoryImport[] | null];
const isObject = (value: unknown): value is object => value !== null && typeof value === "object";

export function attachWasmMessageMetadata<T extends { type: string }>(message: T): T {
  if (typeof WebAssembly === "undefined") return message;
  // File transfers, stdout and timer traffic do not carry modules. Inspect
  // only fields that carry application objects, not entire VFS manifests.
  const payload = message as T & { data?: unknown; workerData?: unknown; module?: unknown };
  if (!isObject(payload.data) && !isObject(payload.workerData) && !isObject(payload.module)) return message;
  const pending: unknown[] = [payload.data, payload.workerData, payload.module];
  const seen = new WeakSet<object>();
  const annotations: Annotation[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof WebAssembly.Module) {
      const requirements = wasmMemoryRequirements(value);
      if (requirements !== undefined) annotations.push([value, requirements]);
      continue;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) continue;
    if (value instanceof Map) {
      for (const [key, item] of Map.prototype.entries.call(value)) pending.push(key, item);
    } else if (value instanceof Set) {
      for (const item of Set.prototype.values.call(value)) pending.push(item);
    } else {
      // Avoid invoking application getters an extra time before postMessage.
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.enumerable && "value" in descriptor) pending.push(descriptor.value);
      }
    }
  }
  return annotations.length ? { ...message, [FIELD]: annotations } : message;
}

export function receiveWasmMessageMetadata<T>(message: T): T {
  if (typeof WebAssembly === "undefined" || !message || typeof message !== "object") return message;
  const metadata = (message as Record<string, unknown>)[FIELD];
  if (!Array.isArray(metadata)) return message;
  for (const entry of metadata as Annotation[]) {
    if (!Array.isArray(entry) || !(entry[0] instanceof WebAssembly.Module)) continue;
    if (entry[1] === null || Array.isArray(entry[1])) rememberWasmMemoryRequirements(entry[0], entry[1]);
  }
  delete (message as Record<string, unknown>)[FIELD];
  return message;
}
