import { describe, it, expect } from "vitest";
import { createServer, request } from "../polyfills/http";
import type { IncomingMessage } from "../polyfills/http";

function countRawSetCookies(msg: IncomingMessage): number {
  let n = 0;
  for (let i = 0; i < msg.rawHeaders.length; i += 2) {
    if (msg.rawHeaders[i].toLowerCase() === "set-cookie") n++;
  }
  return n;
}

describe("HTTP Set-Cookie parity", () => {
  it("dispatchRequest preserves multiple set-cookie headers as an array", async () => {
    const server = createServer((_req, res) => {
      res.appendHeader("Set-Cookie", "session=abc; Path=/; HttpOnly");
      res.appendHeader("Set-Cookie", "other=xyz; Path=/");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const result = await server.dispatchRequest("GET", "/", {});
    server.close();

    expect(result.statusCode).toBe(200);
    const cookies = result.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(
      expect.arrayContaining([
        "session=abc; Path=/; HttpOnly",
        "other=xyz; Path=/",
      ]),
    );
  });

  it("ClientRequest response exposes set-cookie as separate rawHeaders pairs", async () => {
    const server = createServer((_req, res) => {
      res.appendHeader("Set-Cookie", "a=1; Path=/");
      res.appendHeader("Set-Cookie", "b=2; Path=/");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(3001, resolve));

    const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        { hostname: "localhost", port: 3001, path: "/", method: "GET" },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });

    server.close();

    const cookies = incoming.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(countRawSetCookies(incoming)).toBe(2);
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      if (incoming.rawHeaders[i].toLowerCase() === "set-cookie") {
        expect(typeof incoming.rawHeaders[i + 1]).toBe("string");
      }
    }
  });
});
