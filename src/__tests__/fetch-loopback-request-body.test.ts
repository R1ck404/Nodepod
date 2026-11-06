import { describe, it, expect, afterEach, vi } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";
import { createServer } from "../polyfills/http";

// fetch(new Request(url, { method: "POST", body })) to a loopback port must
// leave the caller's Request usable: the network fallback (nothing listening,
// or a redirect off the loopback) sends that same Request.
describe("fetch() a Request with a body to a loopback port", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubNetwork = () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(`${req.method} ${req.url} ${await req.text()}`);
        return new Response("from network");
      }),
    );
    new ScriptEngine(new MemoryVolume(), { cwd: "/" });
    return seen;
  };

  it("falls back to the network with the body intact when nothing listens", async () => {
    const seen = stubNetwork();
    const url = "http://localhost:19871/api/items";

    const res = await fetch(new Request(url, { method: "POST", body: "payload" }));

    expect(await res.text()).toBe("from network");
    expect(seen).toEqual([`POST ${url} payload`]);
  });

  it("delivers the body to the virtual server listening on the port", async () => {
    const seen = stubNetwork();
    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      req.on("end", () => res.end(`${req.method} ${chunks.join("")}`));
    });
    server.listen(19872);
    try {
      const res = await fetch(
        new Request("http://localhost:19872/api/items", { method: "POST", body: "payload" }),
      );
      expect(await res.text()).toBe("POST payload");
      expect(seen).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("falls back to the network with the body intact on a redirect off the loopback", async () => {
    const seen = stubNetwork();
    const server = createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", "https://example.test/api/items");
      res.end();
    });
    server.listen(19873);
    try {
      const url = "http://localhost:19873/api/items";
      const res = await fetch(new Request(url, { method: "POST", body: "payload" }));
      expect(await res.text()).toBe("from network");
      expect(seen).toEqual([`POST ${url} payload`]);
    } finally {
      server.close();
    }
  });
});
