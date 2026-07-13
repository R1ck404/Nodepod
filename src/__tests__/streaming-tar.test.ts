import { describe, expect, it } from "vitest";
import { parseTarStream } from "../threading/offload-worker";

function tarFile(name: string, contents: string): Uint8Array {
  const encoder = new TextEncoder();
  const data = encoder.encode(contents);
  const padded = Math.ceil(data.length / 512) * 512;
  const tar = new Uint8Array(512 + padded + 1024);
  tar.set(encoder.encode(name), 0);
  tar.set(encoder.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
  tar[156] = "0".charCodeAt(0);
  tar.set(data, 512);
  return tar;
}

function chunkedStream(data: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      let index = 0;
      while (offset < data.length) {
        const size = sizes[index++ % sizes.length];
        controller.enqueue(data.subarray(offset, Math.min(data.length, offset + size)));
        offset += size;
      }
      controller.close();
    },
  });
}

describe("streaming tar parser", () => {
  it("parses headers and payloads split across arbitrary chunks", async () => {
    const entries = [];
    for await (const entry of parseTarStream(
      chunkedStream(tarFile("package/index.js", "module.exports = 1"), [1, 7, 509, 13]),
    )) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].filepath).toBe("package/index.js");
    expect(new TextDecoder().decode(entries[0].payload)).toBe("module.exports = 1");
  });

  it("rejects a truncated payload", async () => {
    const full = tarFile("package/a.txt", "content");
    const truncated = full.subarray(0, 515);
    await expect(async () => {
      for await (const _entry of parseTarStream(chunkedStream(truncated, [3, 11]))) {
        // consume the stream
      }
    }).rejects.toThrow(/Truncated tar archive/);
  });
});
