import { describe, it, expect, afterEach } from "vitest";
import { Buffer } from "../polyfills/buffer";
import {
  createServer,
  request,
  setHttpClientBridge,
  type HttpClientBridge,
} from "../polyfills/http";

describe("HTTP client bridge (cross-worker localhost)", () => {
  afterEach(() => {
    setHttpClientBridge(null);
  });

  it("routes localhost requests through bridge when port is not local", async () => {
    const remote = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer | string) =>
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))),
      );
      req.on("end", () => {
        res.statusCode = 200;
        res.end(Buffer.concat(chunks).toString("utf8") || "ok");
      });
    });
    remote.listen(3001);

    const bridge: HttpClientBridge = async (port, method, path, headers, body) => {
      expect(port).toBe(3000);
      return remote.dispatchRequest(method, path, headers, body);
    };

    setHttpClientBridge(bridge);

    const responseText = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "localhost",
          port: 3000,
          path: "/echo",
          method: "POST",
          headers: { "Content-Type": "text/plain" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer | string) =>
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))),
          );
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end("proxied-body");
    });

    remote.close();
    expect(responseText).toBe("proxied-body");
  });
});
