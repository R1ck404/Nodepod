import { describe, it, expect } from "vitest";

import { Buffer } from "../polyfills/buffer";

describe("Buffer", () => {
  describe("Buffer.from(string)", () => {
    it("creates buffer from utf8 string", () => {
      const buf = Buffer.from("hello");
      expect(buf.toString()).toBe("hello");
      expect(buf.length).toBe(5);
    });

    it("creates buffer from hex string", () => {
      const buf = Buffer.from("48656c6c6f", "hex");
      expect(buf.toString()).toBe("Hello");
    });

    it("creates buffer from base64 string", () => {
      const buf = Buffer.from("SGVsbG8=", "base64");
      expect(buf.toString()).toBe("Hello");
    });

    it("creates buffer from latin1 string", () => {
      const buf = Buffer.from("hello", "latin1");
      expect(buf.toString()).toBe("hello");
    });

    it("creates buffer from utf16le string", () => {
      const buf = Buffer.from("A\u{1f642}", "utf16le");
      expect(Array.from(buf)).toEqual([0x41, 0x00, 0x3d, 0xd8, 0x42, 0xde]);
      expect(buf.toString("utf16le")).toBe("A\u{1f642}");
      expect(Buffer.byteLength("A\u{1f642}", "utf16le")).toBe(6);
    });

    it("creates buffer from base64url", () => {
      const buf = Buffer.from("SGVsbG8", "base64url");
      expect(buf.toString()).toBe("Hello");
    });
  });

  describe("Buffer.from(array/Uint8Array)", () => {
    it("creates buffer from number array", () => {
      const buf = Buffer.from([72, 101, 108, 108, 111]);
      expect(buf.toString()).toBe("Hello");
    });

    it("creates buffer from Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const buf = Buffer.from(arr);
      expect(buf.length).toBe(3);
      expect(buf[0]).toBe(1);
    });
  });

  describe("Buffer.alloc", () => {
    it("creates zero-filled buffer", () => {
      const buf = Buffer.alloc(10);
      expect(buf.length).toBe(10);
      expect(buf.every((b: number) => b === 0)).toBe(true);
    });

    it("creates buffer filled with specified value", () => {
      const buf = Buffer.alloc(5, 0xff);
      expect(buf.every((b: number) => b === 255)).toBe(true);
    });
  });

  describe("Buffer.write", () => {
    it("writes utf16le into a shared ArrayBuffer view", () => {
      const memory = new ArrayBuffer(16);
      const view = Buffer.from(memory, 4, 8);

      expect(view.write("react", "utf16le")).toBe(8);
      expect(Array.from(new Uint8Array(memory))).toEqual([
        0, 0, 0, 0,
        0x72, 0, 0x65, 0, 0x61, 0, 0x63, 0,
        0, 0, 0, 0,
      ]);
    });
  });

  describe("Buffer.concat", () => {
    it("concatenates multiple buffers", () => {
      const result = Buffer.concat([Buffer.from("hel"), Buffer.from("lo")]);
      expect(result.toString()).toBe("hello");
    });

    it("handles empty array", () => {
      const result = Buffer.concat([]);
      expect(result.length).toBe(0);
    });

    it("handles single buffer", () => {
      const buf = Buffer.from("only");
      const result = Buffer.concat([buf]);
      expect(result.toString()).toBe("only");
    });
  });

  describe("toString", () => {
    it("defaults to utf8", () => {
      expect(Buffer.from("test").toString()).toBe("test");
    });

    it("encodes as hex", () => {
      expect(Buffer.from("Hello").toString("hex")).toBe("48656c6c6f");
    });

    it("encodes as base64", () => {
      expect(Buffer.from("Hello").toString("base64")).toBe("SGVsbG8=");
    });

    it("encodes as latin1", () => {
      const buf = Buffer.from([0xe9]);
      expect(buf.toString("latin1")).toBe("\xe9");
    });

    // webpack's wasm-hash reads a small digest out of a whole-memory Buffer
    // view via toString("latin1", 0, len); ignoring the range corrupted every
    // [hash] placeholder (e.g. next/font emitted garbage into CSS urls)
    it("honors start/end range arguments", () => {
      const buf = Buffer.from("0123456789abcdef-GARBAGE-AFTER");
      expect(buf.toString("utf8", 0, 16)).toBe("0123456789abcdef");
      expect(buf.toString("latin1", 0, 16)).toBe("0123456789abcdef");
      expect(buf.toString("utf8", 17, 24)).toBe("GARBAGE");
      expect(buf.toString("hex", 0, 2)).toBe("3031");
    });

    it("clamps out-of-range start/end", () => {
      const buf = Buffer.from("abc");
      expect(buf.toString("utf8", 0, 100)).toBe("abc");
      expect(buf.toString("utf8", 2, 1)).toBe("");
    });
  });

  describe("slice / subarray", () => {
    it("returns a sub-buffer", () => {
      const buf = Buffer.from("hello");
      expect(buf.slice(1, 3).toString()).toBe("el");
    });

    it("slice aliases parent memory", () => {
      const buf = Buffer.from([1, 2, 3, 4]);
      const s = buf.slice(1, 3);
      s[0] = 99;
      expect(buf[1]).toBe(99);
    });
  });

  describe("compare / equals", () => {
    it("returns 0 for equal buffers", () => {
      expect(Buffer.from("abc").compare(Buffer.from("abc"))).toBe(0);
    });

    it("returns negative for lesser buffer", () => {
      expect(Buffer.from("abc").compare(Buffer.from("abd"))).toBeLessThan(0);
    });

    it("returns positive for greater buffer", () => {
      expect(Buffer.from("abd").compare(Buffer.from("abc"))).toBeGreaterThan(0);
    });

    it("equals returns true for same content", () => {
      expect(Buffer.from("test").equals(Buffer.from("test"))).toBe(true);
    });

    it("equals returns false for different content", () => {
      expect(Buffer.from("test").equals(Buffer.from("nope"))).toBe(false);
    });
  });

  describe("indexOf", () => {
    it("finds byte in buffer", () => {
      const buf = Buffer.from([1, 2, 3, 4, 5]);
      expect(buf.indexOf(3)).toBe(2);
    });

    it("returns -1 when not found", () => {
      const buf = Buffer.from([1, 2, 3]);
      expect(buf.indexOf(99)).toBe(-1);
    });
  });

  describe("write", () => {
    it("writes string into buffer at offset", () => {
      const buf = Buffer.alloc(10);
      buf.write("hi", 0);
      expect(buf.slice(0, 2).toString()).toBe("hi");
    });

    it("returns number of bytes written", () => {
      const buf = Buffer.alloc(10);
      const written = buf.write("hello", 0);
      expect(written).toBe(5);
    });
  });

  describe("copy", () => {
    it("copies bytes between buffers", () => {
      const src = Buffer.from("hello");
      const dst = Buffer.alloc(5);
      src.copy(dst);
      expect(dst.toString()).toBe("hello");
    });
  });

  describe("integer read/write", () => {
    it("readUInt8 / writeUInt8 round-trip", () => {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(200, 0);
      expect(buf.readUInt8(0)).toBe(200);
    });

    it("readUInt16BE / writeUInt16BE round-trip", () => {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(0x1234, 0);
      expect(buf.readUInt16BE(0)).toBe(0x1234);
    });

    it("readUInt32LE / writeUInt32LE round-trip", () => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(0xdeadbeef, 0);
      expect(buf.readUInt32LE(0)).toBe(0xdeadbeef);
    });

    it("readInt8 handles signed values", () => {
      const buf = Buffer.alloc(1);
      buf.writeInt8(-42, 0);
      expect(buf.readInt8(0)).toBe(-42);
    });

    it("readInt16BE handles negative values", () => {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(-1000, 0);
      expect(buf.readInt16BE(0)).toBe(-1000);
    });
  });

  describe("Float/Double read/write", () => {
    it("readFloatLE / writeFloatLE round-trip", () => {
      const buf = Buffer.alloc(4);
      buf.writeFloatLE(3.14, 0);
      expect(buf.readFloatLE(0)).toBeCloseTo(3.14, 2);
    });

    it("readDoubleLE / writeDoubleLE round-trip", () => {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(Math.PI, 0);
      expect(buf.readDoubleLE(0)).toBeCloseTo(Math.PI, 10);
    });
  });

  describe("swap methods", () => {
    it("swap16 swaps pairs of bytes", () => {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      buf.swap16();
      expect(Array.from(buf)).toEqual([0x02, 0x01, 0x04, 0x03]);
    });

    it("swap32 reverses 4-byte groups", () => {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      buf.swap32();
      expect(Array.from(buf)).toEqual([0x04, 0x03, 0x02, 0x01]);
    });

    it("swap16 throws on odd-length buffer", () => {
      const buf = Buffer.from([1, 2, 3]);
      expect(() => buf.swap16()).toThrow();
    });
  });

  describe("static methods", () => {
    it("isBuffer returns true for Buffer instances", () => {
      expect(Buffer.isBuffer(Buffer.from("x"))).toBe(true);
    });

    // Node semantics: a plain Uint8Array is NOT a Buffer. Callers use this to
    // decide whether Buffer-only methods (subsequence indexOf etc.) exist.
    it("isBuffer returns false for plain Uint8Array", () => {
      expect(Buffer.isBuffer(new Uint8Array(1))).toBe(false);
    });

    it("isEncoding returns true for valid encodings", () => {
      expect(Buffer.isEncoding("utf8")).toBe(true);
      expect(Buffer.isEncoding("hex")).toBe(true);
      expect(Buffer.isEncoding("base64")).toBe(true);
    });

    it("isEncoding returns false for invalid encoding", () => {
      expect(Buffer.isEncoding("garbage")).toBe(false);
    });

    it("byteLength returns correct length for utf8", () => {
      expect(Buffer.byteLength("hello", "utf8")).toBe(5);
    });

    it("byteLength returns correct length for hex", () => {
      expect(Buffer.byteLength("aabb", "hex")).toBe(2);
    });

    it("byteLength returns correct length for base64", () => {
      expect(Buffer.byteLength("SGVsbG8=", "base64")).toBe(5);
    });
  });

  describe("toJSON", () => {
    it('returns { type: "Buffer", data: [...] }', () => {
      const buf = Buffer.from([1, 2, 3]);
      const json = buf.toJSON();
      expect(json.type).toBe("Buffer");
      expect(json.data).toEqual([1, 2, 3]);
    });
  });
});
