import { describe, it, expect } from "vitest";
import { createHash, createHmac, pbkdf2Sync } from "../polyfills/crypto";

describe("crypto sync digests", () => {
  it("SHA-256 of 'abc'", () => {
    expect(createHash("sha256").update("abc").digest("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("SHA-256 of empty string", () => {
    expect(createHash("sha256").update("").digest("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("SHA-1 of 'abc'", () => {
    expect(createHash("sha1").update("abc").digest("hex")).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("SHA-512 of 'abc'", () => {
    expect(createHash("sha512").update("abc").digest("hex")).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("MD5 of 'abc'", () => {
    expect(createHash("md5").update("abc").digest("hex")).toBe(
      "900150983cd24fb0d6963f7d28e17f72",
    );
  });

  it("HMAC-SHA256 RFC 4231 test case 2", () => {
    expect(
      createHmac("sha256", "Jefe")
        .update("what do ya want for nothing?")
        .digest("hex"),
    ).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("SHA-256 multibyte UTF-8 bytes", () => {
    const utf8 = new Uint8Array([0xe6, 0x97, 0xa5, 0xe6, 0x9c, 0xac, 0xe8, 0xaa, 0x9e]);
    expect(createHash("sha256").update(utf8).digest("hex")).toBe(
      "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
    );
  });

  it("SHA-256 string matches UTF-8 bytes", async () => {
    const h = createHash("sha256").update("日本語");
    const sync = h.digest("hex");
    const async_ = await createHash("sha256").update("日本語").digestAsync("hex");
    expect(sync).toBe(async_);
  });

  it("pbkdf2Sync SHA-1", () => {
    expect(
      pbkdf2Sync("password", "salt", 1, 20, "sha1").toString("hex"),
    ).toBe("0c60c80f961f0e71f3a9b524af6012062fe037a6");
  });

  it("sync and async SHA-256 agree", async () => {
    const h = createHash("sha256").update("hello");
    const sync = h.digest("hex");
    const async_ = await h.digestAsync("hex");
    expect(sync).toBe(async_);
  });
});
