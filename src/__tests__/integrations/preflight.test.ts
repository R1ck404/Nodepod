import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RequestProxy, NodepodSWSetupError } from "../../request-proxy";

// Minimal navigator.serviceWorker stub so _preflightServiceWorker can be
// exercised without registering a real SW. Node's `navigator` is a
// getter-only global, so we have to defineProperty with configurable: true
// to be able to restore it in afterEach.
function stubServiceWorker() {
  const stub = {
    serviceWorker: {
      async getRegistrations() {
        return [];
      },
      async register() {
        throw new Error("register() should not be reached in preflight tests");
      },
      addEventListener() {},
      controller: null,
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: stub,
    configurable: true,
    writable: true,
  });
}

describe("preflight: NodepodSWSetupError", () => {
  let originalFetch: typeof fetch;
  let originalNavigatorDesc: PropertyDescriptor | undefined;
  let proxy: RequestProxy;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNavigatorDesc = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    );
    stubServiceWorker();
    proxy = new RequestProxy({ baseUrl: "http://test.local" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDesc);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
    vi.restoreAllMocks();
  });

  it("throws with framework=generic when fetch 404s", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 404 }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await proxy.initServiceWorker();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodepodSWSetupError);
    const err = caught as NodepodSWSetupError;
    expect(err.details.status).toBe(404);
    expect(err.details.swUrl).toBe("/__sw__.js");
    expect(err.details.framework).toBe("generic");
    // toString() should include the actionable hint.
    expect(err.toString()).toMatch(/nodepod\/server|public\//);
  });

  it("throws when Content-Type is HTML (SPA fallback)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await proxy.initServiceWorker();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodepodSWSetupError);
    const err = caught as NodepodSWSetupError;
    expect(err.details.contentType).toBe("text/html");
    expect(err.message).toMatch(/Content-Type/);
  });

  it("throws when fetch rejects (network error / timeout)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network broken");
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await proxy.initServiceWorker();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodepodSWSetupError);
    const err = caught as NodepodSWSetupError;
    expect(err.details.cause).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/could not be reached/);
  });

  it("skipPreflight bypasses the check", async () => {
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    // register() will reject once preflight is skipped, that's fine.
    // The assertion is that fetch never ran.
    await proxy
      .initServiceWorker({ skipPreflight: true })
      .catch(() => {});
    expect(fetchCalled).toBe(false);
  });

  it("NodepodSWSetupError.toString() renders HTTP status and hint", () => {
    const err = new NodepodSWSetupError("test", {
      swUrl: "/__sw__.js",
      status: 404,
      framework: "vite",
    });
    const s = err.toString();
    expect(s).toMatch(/NodepodSWSetupError/);
    expect(s).toMatch(/404/);
    expect(s).toMatch(/nodepod\/vite/);
  });
});
