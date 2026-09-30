import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { EventEmitter } from "../polyfills/events";
import { setImmediate } from "../polyfills/timers";

const nextCheck = () => new Promise<void>((resolve) => setImmediate(() => resolve()));
const watchers: EventEmitter[] = [];
function setup() {
  const volume = new MemoryVolume();
  vi.stubGlobal("__nodepodVolume", volume);
  const watcher = new EventEmitter();
  (watcher as any)._watched = new Map();
  watchers.push(watcher);
  return { volume, watcher };
}
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.emit("close");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VFS watcher scheduling", () => {
  it("delivers coalesced changes without waiting for browser timers", async () => {
    const { volume, watcher } = setup();
    volume.writeFileSync("/app.ts", "initial");
    const changed = vi.fn();
    watcher.on("change", changed);
    // Model a background browser that delays timer callbacks indefinitely.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    volume.writeFileSync("/app.ts", "first");
    volume.writeFileSync("/app.ts", "second");
    expect(changed).not.toHaveBeenCalled();
    await nextCheck();
    expect(changed.mock.calls).toEqual([["/app.ts"]]);
  });

  it("preserves each path's latest event and filters package changes", async () => {
    const { volume, watcher } = setup();
    const changed = vi.fn();
    const added = vi.fn();
    const removed = vi.fn();
    watcher.on("change", changed);
    watcher.on("add", added);
    watcher.on("unlink", removed);
    volume.writeFileSync("/first.ts", "one");
    volume.writeFileSync("/first.ts", "two");
    volume.writeFileSync("/second.ts", "one");
    volume.writeFileSync("/gone.ts", "one");
    volume.unlinkSync("/gone.ts");
    volume.writeFileSync("/node_modules/pkg/index.js", "one");
    await nextCheck();
    expect(changed.mock.calls).toEqual([["/first.ts"]]);
    expect(added.mock.calls).toEqual([["/second.ts"]]);
    expect(removed.mock.calls).toEqual([["/gone.ts"]]);
  });

  it("cancels queued and future events when the watcher closes", async () => {
    const { volume, watcher } = setup();
    const changed = vi.fn();
    watcher.on("change", changed);
    volume.writeFileSync("/app.ts", "first");
    volume.writeFileSync("/app.ts", "second");
    watcher.emit("close");
    volume.writeFileSync("/app.ts", "third");
    await nextCheck();
    expect(changed).not.toHaveBeenCalled();
  });
});
