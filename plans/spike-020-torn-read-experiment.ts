// THROWAWAY — Plan 020 spike experiment (kept as a reference artifact; not
// part of the test suite). Results recorded in 020-cow-vfs-spike.RESULTS.md.
// To re-run: copy into src/__tests__/ with a .test.ts name and fix the import.
//
// Q4: can a cross-thread reader observe torn/corrupt data while the main
// thread rewrites + compacts the SharedVFS? Readers take no locks today.

import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { SharedVFSController } from "../src/threading/shared-vfs";

const READER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const HEADER_SIZE = 32;
const ENTRY_SIZE = 272;
const ENTRY_CONTENT_OFFSET = 4;
const ENTRY_CONTENT_LENGTH = 8;
const ENTRY_PATH_OFFSET = 20;
const ENTRY_PATH_MAX = 248;
const DATA_OFFSET = HEADER_SIZE + 16384 * ENTRY_SIZE;
const FLAG_ACTIVE = 1;

const buf = workerData.buffer;
const view = new DataView(buf);   // entry fields are written big-endian via DataView
const int32 = new Int32Array(buf); // header slots 0/1 use Atomics (native endian)
const uint8 = new Uint8Array(buf);
const enc = new TextEncoder();

function findEntry(path) {
  const target = enc.encode(path);
  const count = Atomics.load(int32, 1);
  for (let i = 0; i < count; i++) {
    const base = HEADER_SIZE + i * ENTRY_SIZE;
    const flags = view.getUint32(base);
    if (!(flags & FLAG_ACTIVE)) continue;
    let match = true;
    for (let j = 0; j < target.length; j++) {
      if (uint8[base + ENTRY_PATH_OFFSET + j] !== target[j]) { match = false; break; }
    }
    if (match && uint8[base + ENTRY_PATH_OFFSET + target.length] === 0) return base;
  }
  return -1;
}

function readFile(path) {
  const base = findEntry(path);
  if (base < 0) return null;
  const offset = view.getUint32(base + ENTRY_CONTENT_OFFSET);
  const length = view.getUint32(base + ENTRY_CONTENT_LENGTH);
  const copy = new Uint8Array(length);
  copy.set(uint8.subarray(DATA_OFFSET + offset, DATA_OFFSET + offset + length));
  return copy;
}

// tight loop: read /target.bin, validate every byte is 0x41 or 0x42 and uniform
let reads = 0, torn = 0, wrongLen = 0;
const deadline = Date.now() + workerData.durationMs;
while (Date.now() < deadline) {
  const bytes = readFile("/target.bin");
  if (!bytes) continue;
  reads++;
  if (bytes.length !== workerData.payloadLen) { wrongLen++; continue; }
  const first = bytes[0];
  if (first !== 0x41 && first !== 0x42) { torn++; continue; }
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] !== first) { torn++; break; }
  }
}
parentPort.postMessage({ reads, torn, wrongLen });
`;

describe("spike 020: torn reads under rewrite + compaction", () => {
  it("measures corrupt reads while main churns and compacts", async () => {
    const ctrl = new SharedVFSController(32 * 1024 * 1024);
    const PAYLOAD_LEN = 256 * 1024;
    const A = new Uint8Array(PAYLOAD_LEN).fill(0x41);
    const B = new Uint8Array(PAYLOAD_LEN).fill(0x42);
    ctrl.writeFile("/target.bin", A);

    const DURATION_MS = 3000;
    const worker = new Worker(READER_SRC, {
      eval: true,
      workerData: { buffer: ctrl.buffer, durationMs: DURATION_MS, payloadLen: PAYLOAD_LEN },
    });

    const resultPromise = new Promise<{ reads: number; torn: number; wrongLen: number }>(
      (resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      },
    );

    // churn: alternate target payload, write+delete filler to build waste,
    // and force compactions so the data region relocates under the reader
    const deadline = Date.now() + DURATION_MS;
    let writes = 0;
    let compactions = 0;
    const filler = new Uint8Array(512 * 1024).fill(0x7a);
    while (Date.now() < deadline) {
      ctrl.writeFile("/target.bin", writes % 2 === 0 ? B : A);
      writes++;
      ctrl.writeFile("/filler.bin", filler);
      ctrl.deleteFile("/filler.bin");
      if (writes % 5 === 0) {
        ctrl.compact();
        compactions++;
      }
      // yield so the loop doesn't starve the JS thread entirely
      if (writes % 50 === 0) await new Promise((r) => setImmediate(r));
    }

    const result = await resultPromise;
    await worker.terminate();

    // Record, don't assert cleanliness — the point is to measure.
    console.log(
      `[spike-020] writes=${writes} compactions=${compactions} ` +
        `reads=${result.reads} torn=${result.torn} wrongLen=${result.wrongLen} ` +
        `cleanReads=${result.reads - result.torn - result.wrongLen}`,
    );
    expect(result.reads).toBeGreaterThan(0);
  }, 30_000);
});
