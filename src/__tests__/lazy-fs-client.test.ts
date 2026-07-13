import { describe, expect, it } from "vitest";
import { createLazyFsClient } from "../threading/lazy-fs-client";

function fakePort(
  respond: (type: string, payload: unknown[]) => { type: number; bytes: Uint8Array },
) {
  const buffers: SharedArrayBuffer[] = [];
  const sequences: number[] = [];
  const port = {
    postMessage(message: any) {
      const ctrl = message.__fs__.sab as Int32Array;
      const sab = ctrl.buffer as SharedArrayBuffer;
      buffers.push(sab);
      sequences.push(Atomics.load(ctrl, 3));
      const result = respond(message.__fs__.type, message.__fs__.payload);
      new Uint8Array(sab, 16).set(result.bytes);
      Atomics.store(ctrl, 1, result.type);
      Atomics.store(ctrl, 2, result.bytes.byteLength);
      Atomics.store(ctrl, 0, 0);
      Atomics.notify(ctrl, 0);
    },
  } as unknown as MessagePort;
  return { port, buffers, sequences };
}

describe("lazy filesystem SAB client", () => {
  it("reuses its retained buffer and advances the request sequence", () => {
    const encoder = new TextEncoder();
    const fake = fakePort(() => ({
      type: 6,
      bytes: encoder.encode(JSON.stringify({ _isFile: true, size: 12 })),
    }));
    const client = createLazyFsClient(fake.port);

    expect(client.stat("/a")?.size).toBe(12);
    expect(client.stat("/b")?.size).toBe(12);
    expect(fake.buffers[1]).toBe(fake.buffers[0]);
    expect(fake.sequences).toEqual([1, 2]);
  });

  it("uses stat size to avoid a truncated large-file round trip", () => {
    const encoder = new TextEncoder();
    const payload = new Uint8Array(300 * 1024).fill(7);
    const fake = fakePort((type) => type === "statSync"
      ? { type: 6, bytes: encoder.encode(JSON.stringify({ _isFile: true, size: payload.length })) }
      : { type: 5, bytes: payload });
    const client = createLazyFsClient(fake.port);

    client.stat("/large.bin");
    expect(client.readFile("/large.bin")?.byteLength).toBe(payload.length);
    expect(fake.buffers).toHaveLength(2);
    expect(fake.buffers[1].byteLength).toBeGreaterThan(payload.length);
  });

  it("uses batched metadata operations for directory scans", () => {
    const encoder = new TextEncoder();
    const calls: string[] = [];
    const fake = fakePort((type) => {
      calls.push(type);
      if (type === "readdirWithTypes") {
        return {
          type: 6,
          bytes: encoder.encode(JSON.stringify([
            { name: "package.json", _isFile: true, _isDir: false, size: 42 },
            { name: "dist", _isFile: false, _isDir: true, size: 0 },
          ])),
        };
      }
      return {
        type: 6,
        bytes: encoder.encode(JSON.stringify([
          { _isFile: true, _isDir: false, size: 42 },
          null,
        ])),
      };
    });
    const client = createLazyFsClient(fake.port);

    expect(client.readdir("/pkg")).toEqual([
      { name: "package.json", isDirectory: false, size: 42 },
      { name: "dist", isDirectory: true, size: 0 },
    ]);
    expect(client.statMany?.(["/pkg/package.json", "/missing"])).toEqual([
      { isFile: true, isDirectory: false, size: 42 },
      null,
    ]);
    expect(calls).toEqual(["readdirWithTypes", "statMany"]);
  });
});
