import { describe, expect, it } from "vitest";
import {
  rememberWasmMemoryRequirements,
  wasmMemoryRequirements,
} from "../helpers/wasm-memory-clamp";
import {
  attachWasmMessageMetadata,
  receiveWasmMessageMetadata,
} from "../helpers/wasm-message-metadata";

const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const requirements = [{ module: "env", name: "memory", minPages: 32 }];

describe("WASM message metadata", () => {
  it("retains import requirements through cyclic maps, sets and forwarding", () => {
    const module = new WebAssembly.Module(emptyWasm);
    rememberWasmMemoryRequirements(module, requirements);
    const data: { module: WebAssembly.Module; self?: unknown; nested: Map<unknown, unknown> } = {
      module, nested: new Map([[module, new Set([module])]]),
    };
    data.self = data;
    const message = attachWasmMessageMetadata({ type: "worker-message", data });
    const received = receiveWasmMessageMetadata(structuredClone(message));
    expect(received.data.self).toBe(received.data);
    expect(received.data.module).not.toBe(module);
    expect(wasmMemoryRequirements(received.data.module)).toEqual(requirements);
    expect(received.data.nested.has(received.data.module)).toBe(true);
    expect(Object.keys(received)).toEqual(["type", "data"]);
    const forwarded = receiveWasmMessageMetadata(structuredClone(attachWasmMessageMetadata(received)));
    expect(wasmMemoryRequirements(forwarded.data.module)).toEqual(requirements);
  });

  it("retains empty and unsupported metadata without inventing unknown requirements", () => {
    const empty = new WebAssembly.Module(emptyWasm);
    const unsupported = new WebAssembly.Module(emptyWasm);
    const unknown = new WebAssembly.Module(emptyWasm);
    rememberWasmMemoryRequirements(empty, []);
    rememberWasmMemoryRequirements(unsupported, null);
    const received = receiveWasmMessageMetadata(structuredClone(attachWasmMessageMetadata({
      type: "init", workerData: [empty, unsupported, unknown],
    })));
    expect(wasmMemoryRequirements(received.workerData[0])).toEqual([]);
    expect(wasmMemoryRequirements(received.workerData[1])).toBeNull();
    expect(wasmMemoryRequirements(received.workerData[2])).toBeUndefined();
  });

  it("does not invoke application getters or traverse binary payloads", () => {
    let reads = 0;
    const data = { get value() { reads++; throw new Error("getter invoked"); } };
    const message = { type: "worker-message", data };
    expect(attachWasmMessageMetadata(message)).toBe(message);
    expect(reads).toBe(0);
    const bytes = new Uint8Array(1024);
    Object.defineProperty(bytes, "extra", { get() { throw new Error("binary inspected"); } });
    const binaryMessage = { type: "worker-message", data: bytes };
    expect(attachWasmMessageMetadata(binaryMessage)).toBe(binaryMessage);
  });

  it("leaves stdout, file manifests and unknown modules untouched", () => {
    const stdout = { type: "stdout", data: "text" };
    expect(attachWasmMessageMetadata(stdout)).toBe(stdout);
    const module = new WebAssembly.Module(emptyWasm);
    rememberWasmMemoryRequirements(module, requirements);
    const manifest = { type: "init", files: { module } };
    expect(attachWasmMessageMetadata(manifest)).toBe(manifest);
    const unknown = { type: "worker-message", data: new WebAssembly.Module(emptyWasm) };
    expect(attachWasmMessageMetadata(unknown)).toBe(unknown);
  });

  it("ignores non-enumerable modules and uses intrinsic collection iterators", () => {
    const module = new WebAssembly.Module(emptyWasm);
    rememberWasmMemoryRequirements(module, requirements);
    const hidden = Object.defineProperty({}, "module", { value: module });
    const hiddenMessage = { type: "worker-message", data: hidden };
    expect(attachWasmMessageMetadata(hiddenMessage)).toBe(hiddenMessage);
    const data = new Map([["code", module]]);
    data[Symbol.iterator] = () => { throw new Error("application iterator invoked"); };
    const received = receiveWasmMessageMetadata(structuredClone(attachWasmMessageMetadata({
      type: "worker-message", data,
    })));
    expect(wasmMemoryRequirements(received.data.get("code")!)).toEqual(requirements);
  });
});
