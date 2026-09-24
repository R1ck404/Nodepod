import { describe, it, expect } from "vitest";
import {
  SyncChannelController,
  SyncChannelWorker,
  SyncResultWriter,
  encodeSyncSlot,
  decodeSyncSlot,
  MAX_SLOTS,
} from "../threading/sync-channel";

describe("SyncChannel free-list + generation", () => {
  it("encode/decode round-trips slot and generation", () => {
    const handle = encodeSyncSlot(7, 42);
    expect(decodeSyncSlot(handle)).toEqual({ slot: 7, generation: 42 });
  });

  it("allocate/wait/release reuses slots only after wait completes", () => {
    const ctrl = new SyncChannelController();
    const worker = new SyncChannelWorker(ctrl.buffer);

    const handles: number[] = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      handles.push(worker.allocateSlot());
    }
    const slots = handles.map((h) => decodeSyncSlot(h).slot).sort((a, b) => a - b);
    expect(slots).toEqual([...Array(MAX_SLOTS).keys()]);

    // write before wait — same-thread Atomics.wait cannot run microtasks while blocked
    const first = handles[0];
    ctrl.writeResult(first, 0, "done");
    const result = worker.waitForResult(first, 5_000);
    expect(result).toEqual({ exitCode: 0, stdout: "done", stderr: "" });

    const reused = worker.allocateSlot();
    expect(decodeSyncSlot(reused).slot).toBe(decodeSyncSlot(first).slot);
    expect(decodeSyncSlot(reused).generation).toBeGreaterThan(decodeSyncSlot(first).generation);

    for (let i = 1; i < handles.length; i++) {
      const h = handles[i];
      ctrl.writeResult(h, 0, "");
      worker.waitForResult(h, 5_000);
    }
    ctrl.writeResult(reused, 0, "");
    worker.waitForResult(reused, 5_000);
  });

  it("stale writeResult with old generation is ignored", () => {
    const ctrl = new SyncChannelController();
    const worker = new SyncChannelWorker(ctrl.buffer);

    const handle = worker.allocateSlot();
    ctrl.writeResult(handle, 0, "v1");
    expect(worker.waitForResult(handle, 5_000).stdout).toBe("v1");

    const next = worker.allocateSlot();
    expect(decodeSyncSlot(next).slot).toBe(decodeSyncSlot(handle).slot);

    // stale write for the old handle must not complete the new lease
    ctrl.writeResult(handle, 99, "stale");
    ctrl.writeResult(next, 0, "fresh");
    expect(worker.waitForResult(next, 5_000)).toEqual({ exitCode: 0, stdout: "fresh", stderr: "" });
  });

  it("carries stderr next to stdout", () => {
    const ctrl = new SyncChannelController();
    const worker = new SyncChannelWorker(ctrl.buffer);
    const handle = worker.allocateSlot();
    ctrl.writeResult(handle, 1, "out", "npm error: nope");
    expect(worker.waitForResult(handle, 5_000)).toEqual({ exitCode: 1, stdout: "out", stderr: "npm error: nope" });
  });

  it("hands over output bigger than a slot in chunks", () => {
    const ctrl = new SyncChannelController();
    const worker = new SyncChannelWorker(ctrl.buffer);
    const handle = worker.allocateSlot();
    // multi-byte characters so chunk boundaries fall inside one
    const stdout = "é".repeat(40_000) + "end-of-stdout";
    const stderr = "warn ".repeat(10_000);
    const writer = new SyncResultWriter(ctrl.buffer, handle, 0, stdout, stderr);
    let requests = 0;
    expect(writer.writeNext()).toBe(true);
    // single thread: answer each request right away, before the next wait
    const result = worker.waitForResult(handle, 5_000, () => {
      requests++;
      writer.writeNext();
    });
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(stderr);
    expect(requests).toBeGreaterThan(3);
  });

  it("returns what fit in the first chunk when nobody can ask for more", () => {
    const ctrl = new SyncChannelController();
    const worker = new SyncChannelWorker(ctrl.buffer);
    const handle = worker.allocateSlot();
    expect(ctrl.writeResult(handle, 0, "x".repeat(50_000))).not.toBeNull();
    const result = worker.waitForResult(handle, 5_000);
    expect(result.stdout.length).toBeGreaterThan(16_000);
    expect(result.stdout.length).toBeLessThan(50_000);
  });
});
