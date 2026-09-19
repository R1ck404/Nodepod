import { describe, expect, it } from "vitest";
import {
  fetchWithRetry,
  readBodyWithTimeout,
  RegistryFetchError,
} from "../packages/registry-fetch";

const noSleep = async () => {};

describe("fetchWithRetry", () => {
  it("returns the first successful response", async () => {
    let calls = 0;
    const resp = await fetchWithRetry("https://registry.invalid/pkg", {
      timeoutMs: 1000,
      sleep: noSleep,
      fetchImpl: async () => {
        calls++;
        return new Response("ok", { status: 200 });
      },
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("aborts an attempt that exceeds the deadline and retries", async () => {
    let calls = 0;
    const seenAborts: boolean[] = [];
    const resp = await fetchWithRetry("https://registry.invalid/pkg", {
      timeoutMs: 20,
      attempts: 3,
      sleep: noSleep,
      fetchImpl: (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          if (calls < 3) {
            // hang until the deadline aborts us
            init?.signal?.addEventListener("abort", () => {
              seenAborts.push(true);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
            return;
          }
          resolve(new Response("late", { status: 200 }));
        }),
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
    expect(seenAborts).toEqual([true, true]);
  });

  it("gives up after the configured attempts with a descriptive error", async () => {
    let calls = 0;
    await expect(
      fetchWithRetry("https://registry.invalid/pkg", {
        timeoutMs: 10,
        attempts: 2,
        sleep: noSleep,
        label: "registry metadata for \"pkg\"",
        fetchImpl: () =>
          new Promise<Response>(() => {
            calls++;
          }),
      }),
    ).rejects.toThrow(/registry metadata for "pkg": timed out after 10ms \(after 2 attempts\)/);
    expect(calls).toBe(2);
  });

  it("retries 5xx and 429 but returns other 4xx untouched", async () => {
    const statuses = [503, 429, 404];
    let calls = 0;
    const resp = await fetchWithRetry("https://registry.invalid/pkg", {
      timeoutMs: 1000,
      attempts: 5,
      sleep: noSleep,
      fetchImpl: async () => new Response("x", { status: statuses[calls++] }),
    });
    expect(resp.status).toBe(404);
    expect(calls).toBe(3);
  });

  it("retries network errors", async () => {
    let calls = 0;
    const resp = await fetchWithRetry("https://registry.invalid/pkg", {
      timeoutMs: 1000,
      attempts: 3,
      sleep: noSleep,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return new Response("ok", { status: 200 });
      },
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("stops immediately when the caller's signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchWithRetry("https://registry.invalid/pkg", {
      timeoutMs: 10_000,
      attempts: 5,
      sleep: noSleep,
      init: { signal: controller.signal },
      fetchImpl: (_url, init) =>
        new Promise<Response>((_, reject) => {
          calls++;
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RegistryFetchError);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });
});

describe("readBodyWithTimeout", () => {
  it("reads a body that completes in time", async () => {
    const bytes = await readBodyWithTimeout(new Response("hello"), 1000, "test");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("rejects when the body stalls", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        // never closes
      },
    });
    await expect(
      readBodyWithTimeout(new Response(stalled), 20, "tarball download"),
    ).rejects.toThrow(/tarball download: body read timed out after 20ms/);
  });
});
