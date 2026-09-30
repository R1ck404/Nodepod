import { describe, expect, it } from "vitest";
import { serializeIpcMessage } from "../helpers/ipc-serialization";
import { Buffer } from "../polyfills/buffer";

describe("child-process IPC serialization", () => {
  it("applies JSON semantics to callbacks, dates, buffers and undefined properties", () => {
    const input = { callback: () => null, date: new Date(123), bytes: Buffer.from([1, 2]),
      absent: undefined, list: [undefined, () => null, NaN] };
    expect(serializeIpcMessage(input, "json")).toEqual({
      date: "1970-01-01T00:00:00.123Z", bytes: { type: "Buffer", data: [1, 2] },
      list: [null, null, null],
    });
  });

  it("rejects JSON cycles and big integers before transport", () => {
    const cycle: any = {}; cycle.self = cycle;
    expect(() => serializeIpcMessage(cycle, "json")).toThrow(TypeError);
    expect(() => serializeIpcMessage({ value: 1n }, "json")).toThrow(TypeError);
  });

  it("leaves rich advanced messages for the structured-clone transport", () => {
    const input: any = { values: new Map([["answer", 1n]]) }; input.self = input;
    const output: any = structuredClone(serializeIpcMessage(input, "advanced"));
    expect(output.self).toBe(output);
    expect(output.values.get("answer")).toBe(1n);
    expect(() => structuredClone(serializeIpcMessage({ fn() {} }, "advanced"))).toThrow();
  });

  it("rejects invalid top-level messages", () => {
    for (const value of [null, undefined, () => 1, Symbol("message"), 1n]) {
      expect(() => serializeIpcMessage(value, "json")).toThrow(TypeError);
    }
  });
});
