import { describe, it, expect } from "vitest";
import * as nativeV8 from "node:v8";

import v8Module, { serialize, deserialize } from "../polyfills/v8";
import { Buffer } from "../polyfills/buffer";

const roundTrip = (value: unknown) => deserialize(serialize(value));
const nativeRoundTrip = (value: unknown) => nativeV8.deserialize(nativeV8.serialize(value));

describe("v8.serialize / v8.deserialize", () => {
  it("returns a Buffer", () => {
    expect(Buffer.isBuffer(serialize({ a: 1 }))).toBe(true);
    expect(v8Module.serialize).toBe(serialize);
    expect(v8Module.deserialize).toBe(deserialize);
  });

  it("keeps the values JSON loses, as Node does", () => {
    const values: unknown[] = [
      undefined, NaN, Infinity, -Infinity, -0, 0, 12.5, "text", true, null,
      123n, -(2n ** 70n),
      [1, undefined, "x"],
      { a: undefined, b: NaN, nested: { c: [Infinity] } },
    ];
    for (const value of values) {
      const ours = roundTrip(value);
      expect(ours).toEqual(nativeRoundTrip(value));
      if (typeof value === "number") expect(Object.is(ours, value)).toBe(true);
    }
  });

  it("keeps Date, RegExp, Map and Set", () => {
    const date = new Date("2024-01-02T03:04:05.006Z");
    const out = roundTrip({
      date,
      re: /a+b/gi,
      map: new Map<unknown, unknown>([["k", 1], [2, new Set(["v"])]]),
      set: new Set([1, "two", 3n]),
    }) as Record<string, any>;
    expect(out.date).toBeInstanceOf(Date);
    expect(out.date.getTime()).toBe(date.getTime());
    expect(out.re).toBeInstanceOf(RegExp);
    expect([out.re.source, out.re.flags]).toEqual(["a+b", "gi"]);
    expect(out.map).toBeInstanceOf(Map);
    expect(out.map.get("k")).toBe(1);
    expect(out.map.get(2)).toEqual(new Set(["v"]));
    expect(out.set).toEqual(new Set([1, "two", 3n]));
  });

  it("keeps ArrayBuffer, typed arrays, DataView and Buffer, with their types", () => {
    const out = roundTrip({
      ab: new Uint8Array([1, 2, 3]).buffer,
      u8: new Uint8Array([255, 0]),
      i16: new Int16Array([-2, 300]),
      f64: new Float64Array([1.5, -0]),
      big: new BigInt64Array([-5n]),
      view: new DataView(new Uint8Array([9, 8]).buffer),
      buf: Buffer.from("hello"),
      slice: new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 3),
    }) as Record<string, any>;
    expect(out.ab).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out.ab)]).toEqual([1, 2, 3]);
    expect(out.u8).toBeInstanceOf(Uint8Array);
    expect([...out.u8]).toEqual([255, 0]);
    expect(out.i16).toBeInstanceOf(Int16Array);
    expect([...out.i16]).toEqual([-2, 300]);
    expect(out.f64).toBeInstanceOf(Float64Array);
    expect(Object.is(out.f64[1], -0)).toBe(true);
    expect(out.big).toBeInstanceOf(BigInt64Array);
    expect(out.big[0]).toBe(-5n);
    expect(out.view).toBeInstanceOf(DataView);
    expect(out.view.getUint8(1)).toBe(8);
    expect(Buffer.isBuffer(out.buf)).toBe(true);
    expect(out.buf.toString()).toBe("hello");
    expect([...out.slice]).toEqual([1, 2]);
  });

  it("keeps errors: subclass, message, stack, cause and own properties", () => {
    const cause = new RangeError("inner");
    const err = Object.assign(new TypeError("outer", { cause }), { code: "E_X" });
    const out = roundTrip(err) as TypeError & { code: string; cause: Error };
    expect(out).toBeInstanceOf(TypeError);
    expect(out.message).toBe("outer");
    expect(out.stack).toBe(err.stack);
    expect(out.code).toBe("E_X");
    expect(out.cause).toBeInstanceOf(RangeError);
    expect(out.cause.message).toBe("inner");
  });

  it("keeps shared and circular references", () => {
    const shared = { n: 1 };
    const root: Record<string, any> = { a: shared, b: shared, list: [shared] };
    root.self = root;
    const out = roundTrip(root) as Record<string, any>;
    expect(out.a).toBe(out.b);
    expect(out.list[0]).toBe(out.a);
    expect(out.self).toBe(out);
  });

  it("throws DataCloneError for functions and symbols, as Node does", () => {
    for (const value of [() => 1, Symbol("s")]) {
      expect(() => nativeV8.serialize(value)).toThrow();
      expect(() => serialize(value)).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    }
  });

  it("deserializes a Buffer that crossed a JSON channel as {type, data}", () => {
    // A JSON-mode IPC channel (child_process.fork without serialization: "advanced") delivers
    // a serialized Buffer as its toJSON() form; tinypool's worker messages travel this way.
    const sent = serialize({ when: new Date(0), missing: undefined });
    const received = JSON.parse(JSON.stringify(sent));
    expect(received.type).toBe("Buffer");
    expect(deserialize(received)).toEqual({ when: new Date(0), missing: undefined });
  });

  it("still reads plain JSON bytes", () => {
    expect(deserialize(new TextEncoder().encode('{"a":[1,2]}'))).toEqual({ a: [1, 2] });
  });
});
