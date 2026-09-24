// real blocking execSync/spawnSync via SharedArrayBuffer + Atomics
// worker allocates a slot, posts spawn-sync, blocks on Atomics.wait()
// main thread runs the child, writes result to the slot, calls Atomics.notify()

import { isSharedArrayBufferAvailable } from "./shared-vfs";

// shared memory layout
// per-slot (16KB = 4096 Int32s):
//   [0] status (0=pending, 1=complete, 2=error)
//   [1] exit code
//   [2] total stdout byte length
//   [3] total stderr byte length
//   [4] offset of this chunk in stdout+stderr
//   [5] byte length of this chunk
//   [6..4095] chunk data
// a result bigger than one slot arrives in chunks: after reading one the
// worker marks the slot pending again and asks for the next ("sync-more").
// metadata after all slots (shared free-list + generations — no %64 reuse):
//   [FREE_HEAD] free-list head index (-1 if empty)
//   [FREE_LIST_BASE .. +MAX_SLOTS) next pointers
//   [GEN_BASE .. +MAX_SLOTS) per-slot generation counters
export const SLOT_SIZE = 4096; // 4096 Int32s = 16KB per slot
export const MAX_SLOTS = 64;
const STATUS_PENDING = 0;
const STATUS_COMPLETE = 1;
const STATUS_ERROR = 2;

const HEADER_INTS = 6;
const CHUNK_BYTES = (SLOT_SIZE - HEADER_INTS) * 4;

const FREE_HEAD_INDEX = MAX_SLOTS * SLOT_SIZE;
const FREE_LIST_BASE = FREE_HEAD_INDEX + 1;
const GEN_BASE = FREE_LIST_BASE + MAX_SLOTS;
const META_INTS = 1 + MAX_SLOTS + MAX_SLOTS;

const DEFAULT_SYNC_BUFFER_SIZE = (MAX_SLOTS * SLOT_SIZE + META_INTS) * 4;

/** Pack slot index + generation into the opaque syncSlot handle posted to main. */
export function encodeSyncSlot(slot: number, generation: number): number {
  return ((generation & 0xffff) << 16) | (slot & 0xffff);
}

/** Unpack opaque syncSlot handle into SAB index + generation. */
export function decodeSyncSlot(handle: number): { slot: number; generation: number } {
  return {
    slot: handle & 0xffff,
    generation: (handle >>> 16) & 0xffff,
  };
}

function initFreeList(int32: Int32Array): void {
  Atomics.store(int32, FREE_HEAD_INDEX, 0);
  for (let i = 0; i < MAX_SLOTS - 1; i++) {
    Atomics.store(int32, FREE_LIST_BASE + i, i + 1);
  }
  Atomics.store(int32, FREE_LIST_BASE + MAX_SLOTS - 1, -1);
  for (let i = 0; i < MAX_SLOTS; i++) {
    Atomics.store(int32, GEN_BASE + i, 0);
    Atomics.store(int32, i * SLOT_SIZE, STATUS_PENDING);
  }
}

function generationMatches(int32: Int32Array, slot: number, generation: number): boolean {
  return (Atomics.load(int32, GEN_BASE + slot) & 0xffff) === (generation & 0xffff);
}

function releaseSlot(int32: Int32Array, slot: number): void {
  for (;;) {
    const head = Atomics.load(int32, FREE_HEAD_INDEX);
    Atomics.store(int32, FREE_LIST_BASE + slot, head);
    if (Atomics.compareExchange(int32, FREE_HEAD_INDEX, head, slot) === head) {
      Atomics.notify(int32, FREE_HEAD_INDEX);
      return;
    }
  }
}

/**
 * Main-thread writer for one sync result: stdout and stderr go out as one
 * byte stream, a slot-sized chunk per writeNext(). Returns false from
 * writeNext() once the worker has everything.
 */
export class SyncResultWriter {
  private readonly _int32: Int32Array;
  private readonly _uint8: Uint8Array;
  private readonly _bytes: Uint8Array;
  private readonly _stdoutLen: number;
  private readonly _stderrLen: number;
  private _offset = 0;

  constructor(
    buffer: SharedArrayBuffer,
    private readonly _syncSlot: number,
    private readonly _exitCode: number,
    stdout: string,
    stderr: string,
    private readonly _status: number = STATUS_COMPLETE,
  ) {
    this._int32 = new Int32Array(buffer);
    this._uint8 = new Uint8Array(buffer);
    const encoder = new TextEncoder();
    const out = encoder.encode(stdout);
    const err = encoder.encode(stderr);
    this._stdoutLen = out.byteLength;
    this._stderrLen = err.byteLength;
    this._bytes = new Uint8Array(out.byteLength + err.byteLength);
    this._bytes.set(out, 0);
    this._bytes.set(err, out.byteLength);
  }

  /** Write the next chunk and wake the worker. True if more chunks remain. */
  writeNext(): boolean {
    const { slot, generation } = decodeSyncSlot(this._syncSlot);
    if (slot < 0 || slot >= MAX_SLOTS) return false;
    // the worker gave up (timeout) or the slot moved on: nobody is reading
    if (!generationMatches(this._int32, slot, generation)) return false;

    const base = slot * SLOT_SIZE;
    const len = Math.min(CHUNK_BYTES, this._bytes.byteLength - this._offset);
    Atomics.store(this._int32, base + 1, this._exitCode);
    Atomics.store(this._int32, base + 2, this._stdoutLen);
    Atomics.store(this._int32, base + 3, this._stderrLen);
    Atomics.store(this._int32, base + 4, this._offset);
    Atomics.store(this._int32, base + 5, len);
    this._uint8.set(
      this._bytes.subarray(this._offset, this._offset + len),
      (base + HEADER_INTS) * 4,
    );
    this._offset += len;

    // last store wakes the waiting worker
    Atomics.store(this._int32, base, this._status);
    Atomics.notify(this._int32, base);
    return this._offset < this._bytes.byteLength;
  }
}

// main thread side
export class SyncChannelController {
  private _buffer: SharedArrayBuffer;

  constructor(bufferSize: number = DEFAULT_SYNC_BUFFER_SIZE) {
    if (!isSharedArrayBufferAvailable()) {
      throw new Error("SharedArrayBuffer not available. Ensure COOP/COEP headers are set.");
    }

    const minSize = (MAX_SLOTS * SLOT_SIZE + META_INTS) * 4;
    this._buffer = new SharedArrayBuffer(Math.max(bufferSize, minSize));

    initFreeList(new Int32Array(this._buffer));
  }

  get buffer(): SharedArrayBuffer {
    return this._buffer;
  }

  /** Write a result; returns a writer to send further chunks, or null if it fit. */
  writeResult(syncSlot: number, exitCode: number, stdout: string, stderr = ""): SyncResultWriter | null {
    const writer = new SyncResultWriter(this._buffer, syncSlot, exitCode, stdout, stderr);
    return writer.writeNext() ? writer : null;
  }

  writeError(syncSlot: number, exitCode: number, errorMessage: string): void {
    new SyncResultWriter(this._buffer, syncSlot, exitCode, errorMessage, "", STATUS_ERROR).writeNext();
  }
}

/** Status used by main for a result it could not produce (spawn failed). */
export const SYNC_STATUS_ERROR = STATUS_ERROR;

// worker thread side
export class SyncChannelWorker {
  private _int32: Int32Array;
  private _uint8: Uint8Array;

  constructor(buffer: SharedArrayBuffer) {
    this._int32 = new Int32Array(buffer);
    this._uint8 = new Uint8Array(buffer);
  }

  /** Allocate a free slot; returns opaque handle (slot + generation). Never reuses in-flight slots. */
  allocateSlot(): number {
    for (let attempt = 0; attempt < 100_000; attempt++) {
      const head = Atomics.load(this._int32, FREE_HEAD_INDEX);
      if (head < 0) {
        Atomics.wait(this._int32, FREE_HEAD_INDEX, -1, 1);
        continue;
      }
      const next = Atomics.load(this._int32, FREE_LIST_BASE + head);
      if (Atomics.compareExchange(this._int32, FREE_HEAD_INDEX, head, next) !== head) {
        continue;
      }
      const oldGen = Atomics.add(this._int32, GEN_BASE + head, 1);
      const generation = (oldGen + 1) & 0xffff;
      Atomics.store(this._int32, head * SLOT_SIZE, STATUS_PENDING);
      return encodeSyncSlot(head, generation);
    }
    throw new Error("SyncChannel: no free slots");
  }

  /**
   * Block until main writes the result. `requestMore` asks main for the next
   * chunk of a result bigger than one slot; without it, only what fits in
   * the first chunk is returned.
   */
  waitForResult(
    syncSlot: number,
    timeoutMs: number = 120_000,
    requestMore?: () => void,
  ): { exitCode: number; stdout: string; stderr: string } {
    const { slot, generation } = decodeSyncSlot(syncSlot);
    if (slot < 0 || slot >= MAX_SLOTS) {
      throw new Error("SyncChannel: invalid slot handle");
    }
    const base = slot * SLOT_SIZE;
    let shouldRelease = false;
    const deadline = Date.now() + timeoutMs;

    try {
      if (!generationMatches(this._int32, slot, generation)) {
        throw new Error("SyncChannel: stale slot generation");
      }
      shouldRelease = true;

      let bytes: Uint8Array | null = null;
      let received = 0;
      let status = STATUS_PENDING;
      let exitCode = 0;
      let stdoutLen = 0;
      let stderrLen = 0;

      for (;;) {
        const result = Atomics.wait(
          this._int32,
          base,
          STATUS_PENDING,
          Math.max(0, deadline - Date.now()),
        );
        if (result === "timed-out") {
          // invalidate so a late main write cannot corrupt the next borrower
          Atomics.add(this._int32, GEN_BASE + slot, 1);
          throw new Error("execSync timed out");
        }
        if (!generationMatches(this._int32, slot, generation)) {
          shouldRelease = false;
          throw new Error("SyncChannel: slot reused during wait");
        }

        status = Atomics.load(this._int32, base);
        exitCode = Atomics.load(this._int32, base + 1);
        stdoutLen = Atomics.load(this._int32, base + 2);
        stderrLen = Atomics.load(this._int32, base + 3);
        const offset = Atomics.load(this._int32, base + 4);
        const len = Atomics.load(this._int32, base + 5);
        // copy out of shared memory: TextDecoder rejects SAB-backed views
        if (!bytes) bytes = new Uint8Array(stdoutLen + stderrLen);
        const dataOffset = (base + HEADER_INTS) * 4;
        bytes.set(this._uint8.subarray(dataOffset, dataOffset + len), offset);
        received = offset + len;

        if (received >= bytes.byteLength || !requestMore) break;
        // pending before asking, so the answer can't race past the wait
        Atomics.store(this._int32, base, STATUS_PENDING);
        requestMore();
      }

      const decoder = new TextDecoder();
      const all = bytes ?? new Uint8Array(0);
      const stdout = decoder.decode(all.subarray(0, Math.min(stdoutLen, received)));
      const stderr = received > stdoutLen ? decoder.decode(all.subarray(stdoutLen, received)) : "";

      if (status === STATUS_ERROR) {
        const err = new Error(`Command failed with exit code ${exitCode}\n${stdout}`);
        (err as any).status = exitCode;
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        throw err;
      }

      return { exitCode, stdout, stderr };
    } finally {
      if (shouldRelease) releaseSlot(this._int32, slot);
    }
  }
}
