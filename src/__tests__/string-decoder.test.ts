import { describe, it, expect } from "vitest";
import { StringDecoder } from "../polyfills/string_decoder";

describe("StringDecoder", () => {
  it("preserves multibyte UTF-8 split across writes", () => {
    const dec = new StringDecoder("utf8");
    const part1 = dec.write(Uint8Array.of(0xe2, 0x82));
    const part2 = dec.write(Uint8Array.of(0xac));
    expect(part1 + part2).toBe("€");
    expect(part1 + part2).not.toContain("\uFFFD");
  });

  it("preserves emoji split across writes", () => {
    const dec = new StringDecoder("utf8");
    const a = dec.write(Uint8Array.of(0xf0, 0x9f));
    const b = dec.write(Uint8Array.of(0x98, 0x80));
    expect(a + b).toBe("😀");
  });

  it("decodes ASCII in one write", () => {
    const dec = new StringDecoder("utf8");
    expect(dec.write(Buffer.from("hello"))).toBe("hello");
  });
});
