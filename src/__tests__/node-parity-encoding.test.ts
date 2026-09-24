import { describe, expect, it } from "vitest";
import { Buffer } from "../polyfills/buffer";
import { createHash } from "../polyfills/crypto";

// expected values produced by Node 24
describe("Buffer base64 decoding matches node's leniency", () => {
  const cases: Array<[string, string]> = [
    ["-_-_", "fbffbf"],
    ["aGVsbG8*!!", "68656c6c6f"],
    ["YQ==YQ==", "61"],
    ["YQ=", "61"],
    ["a", ""],
    ["aGVs bG8=\n", "68656c6c6f"],
    ["aGVsbG8=====", "68656c6c6f"],
    ["Y Q", "61"],
    ["@@@", ""],
    ["aGVsbG8gd29ybGQ", "68656c6c6f20776f726c64"],
    ["aGVs=bG8", "68656c"],
  ];
  for (const [input, hex] of cases) {
    it(JSON.stringify(input), () => {
      expect(Buffer.from(input, "base64").toString("hex")).toBe(hex);
    });
  }
});

describe("Hash after digest", () => {
  it("throws node's error when updated after digest", () => {
    const h = createHash("sha256");
    h.update("abc");
    expect(h.digest("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let code: string | undefined;
    try {
      h.update("x");
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("ERR_CRYPTO_HASH_FINALIZED");
  });
});
