import { describe, it, expect } from "vitest";
import { Readable } from "../polyfills/stream";
import { Buffer } from "../polyfills/buffer";
import { createServer } from "../polyfills/http";

function readBody(req: { on: Function }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}


describe("HTTP request body parity", () => {
  it("dispatchRequest delivers POST body to async middleware", async () => {
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ received: JSON.parse(body.toString("utf8")) }));
    });
    server.listen(0);

    const result = await server.dispatchRequest(
      "POST",
      "/api/auth/sign-up/email",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ email: "a@b.c", password: "secret" })),
    );

    server.close();
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body!.toString("utf8"));
    expect(parsed.received.email).toBe("a@b.c");
  });

  it("async middleware that awaits before reading still receives body", async () => {
    const server = createServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, 0));
      const body = await readBody(req);
      res.end(body.toString("utf8") || "empty");
    });
    server.listen(0);

    const result = await server.dispatchRequest(
      "POST",
      "/",
      { "content-type": "text/plain" },
      Buffer.from("hello-body"),
    );

    server.close();
    expect(result.body?.toString("utf8")).toBe("hello-body");
  });

  it("sets content-length automatically when missing", async () => {
    const server = createServer(async (req, res) => {
      expect(req.headers["content-length"]).toBeTruthy();
      const cl = Number(req.headers["content-length"]);
      const body = await readBody(req);
      expect(body.length).toBe(cl);
      res.end("ok");
    });
    server.listen(0);

    const payload = JSON.stringify({ email: "test@example.com", password: "pw" });
    const result = await server.dispatchRequest(
      "POST",
      "/api/auth/sign-up/email",
      { "content-type": "application/json" },
      Buffer.from(payload),
    );

    server.close();
    expect(result.body?.toString("utf8")).toBe("ok");
  });

  it("proxy-style handler reads body during sync handler before EOF", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer | string) =>
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))),
      );
      req.on("end", () => {
        res.end(Buffer.concat(chunks).toString("utf8"));
      });
    });
    server.listen(0);

    const result = await server.dispatchRequest(
      "POST",
      "/proxy-target",
      { "content-type": "application/json" },
      Buffer.from('{"ok":true}'),
    );

    server.close();
    expect(result.body?.toString("utf8")).toBe('{"ok":true}');
  });
});

describe("Readable push(null) with buffered data", () => {
  it("keeps readable=true until queued data is drained", () => {
    const r = new Readable({ read() {} });
    r.pause();
    r.push("hello");
    r.push(null);
    expect(r.readable).toBe(true);
    expect(r.readableEnded).toBe(false);

    const chunks: string[] = [];
    r.on("data", (chunk: unknown) => chunks.push(String(chunk)));
    r.resume();
    expect(chunks).toContain("hello");
    expect(r.readableEnded).toBe(true);
  });
});
