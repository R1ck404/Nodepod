import { describe, expect, it } from "vitest";
import { installBodyReadLifetime } from "../polyfills/fetch-response";
import { getRegistry } from "../helpers/event-loop";

// A process whose last pending work is a body read stays alive until it
// settles (CI: `new Blob(['b']).text().then(...)` exited with no output).
describe("body read lifetime", () => {
  installBodyReadLifetime();
  installBodyReadLifetime(); // idempotent

  it("holds the event loop while Blob/Response/Request bodies are read", async () => {
    const registry = getRegistry();
    const base = registry.activeRefedCount();
    const reads = [
      new Blob(["b"]).text(),
      new Blob([new Uint8Array(8)]).arrayBuffer(),
      new Response("r").text(),
      new Response('{"a":1}').json(),
      new Request("http://x/", { method: "POST", body: "q" }).text(),
    ];
    expect(registry.activeRefedCount()).toBe(base + reads.length);
    const values = await Promise.all(reads);
    expect(values[0]).toBe("b");
    expect((values[1] as ArrayBuffer).byteLength).toBe(8);
    expect(values[2]).toBe("r");
    expect(values[3]).toEqual({ a: 1 });
    expect(values[4]).toBe("q");
    expect(registry.activeRefedCount()).toBe(base);
  });

  it("releases the handle when a read fails", async () => {
    const registry = getRegistry();
    const base = registry.activeRefedCount();
    await expect(new Response("not json").json()).rejects.toThrow();
    expect(registry.activeRefedCount()).toBe(base);
  });
});
