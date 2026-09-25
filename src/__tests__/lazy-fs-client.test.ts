import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
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
  it("keeps waiting for its answer when woken before it", async () => {
    // answers from another thread, after waking the call for nothing a few
    // times (the late notify of the call before it)
    const answerer = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", ({ ctrl, bytes }) => {
        const until = Date.now() + 30;
        while (Date.now() < until) Atomics.notify(ctrl, 0);
        new Uint8Array(ctrl.buffer, 16).set(bytes);
        Atomics.store(ctrl, 1, 5);
        Atomics.store(ctrl, 2, bytes.byteLength);
        Atomics.store(ctrl, 0, 0);
        Atomics.notify(ctrl, 0);
      });
      parentPort.postMessage("ready");
      `,
      { eval: true },
    );
    await new Promise((resolve) => answerer.once("message", resolve));
    try {
      const port = {
        postMessage: (message: any) => answerer.postMessage({ ctrl: message.__fs__.sab, bytes: new Uint8Array([1, 2, 3]) }),
      } as unknown as MessagePort;
      const client = createLazyFsClient(port);
      expect(Array.from(client.readFile("/f") ?? [])).toEqual([1, 2, 3]);
    } finally {
      await answerer.terminate();
    }
  });

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
            { name: "linked", _isFile: false, _isDir: false, _isSymlink: true, _target: "../other", size: 0 },
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
      { name: "linked", isDirectory: false, size: 0, isSymlink: true, target: "../other" },
    ]);
    expect(client.statMany?.(["/pkg/package.json", "/missing"])).toEqual([
      { isFile: true, isDirectory: false, size: 42 },
      null,
    ]);
    expect(calls).toEqual(["readdirWithTypes", "statMany"]);
  });
});

describe("lazy filesystem SAB client, replies that don't fit", () => {
  it("asks again with room for a reply bigger than its buffer", () => {
    const payload = new Uint8Array(300 * 1024).fill(9);
    const sizes: number[] = [];
    const port = {
      postMessage(message: any) {
        const ctrl = message.__fs__.sab as Int32Array;
        const sab = ctrl.buffer as SharedArrayBuffer;
        sizes.push(sab.byteLength);
        Atomics.store(ctrl, 2, payload.byteLength);
        if (sab.byteLength - 16 < payload.byteLength) {
          // like handleFsProxy: status 2 = too big, with the length needed
          Atomics.store(ctrl, 0, 2);
        } else {
          new Uint8Array(sab, 16).set(payload);
          Atomics.store(ctrl, 1, 5);
          Atomics.store(ctrl, 0, 0);
        }
        Atomics.notify(ctrl, 0);
      },
    } as unknown as MessagePort;
    const client = createLazyFsClient(port);
    // no stat or listing first: the size isn't known
    expect(client.readFile("/unlisted.bin")?.byteLength).toBe(payload.length);
    expect(sizes).toHaveLength(2);
    expect(sizes[1] - 16).toBeGreaterThanOrEqual(payload.length);
  });
});
