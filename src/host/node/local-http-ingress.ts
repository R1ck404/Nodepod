import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestProxy } from "../../request-proxy";
import type { HttpIngress } from "../types";

export interface LocalHttpIngressOptions {
  proxy: RequestProxy;
  /** Bind address. Default 127.0.0.1 */
  host?: string;
  /** Port; 0 = ephemeral. Default 0 */
  port?: number;
}

/**
 * Real localhost HTTP server that forwards `/__virtual__/{instanceId}/{port}/...`
 * into RequestProxy.handleRequest — Node headless equivalent of the SW bridge.
 */
export function createLocalHttpIngress(
  opts: LocalHttpIngressOptions,
): HttpIngress {
  const host = opts.host ?? "127.0.0.1";
  const listenPort = opts.port ?? 0;
  let server: http.Server | null = null;
  let baseUrl: string | null = null;

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function headersToRecord(
    headers: IncomingMessage["headers"],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      out[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
  }

  async function onRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      const parts = url.pathname.split("/").filter(Boolean);
      // Expect: __virtual__ / {instanceId} / {port} / ...rest
      if (parts[0] !== "__virtual__" || parts.length < 3) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not Found");
        return;
      }
      const instanceId = parts[1];
      const port = Number(parts[2]);
      if (!Number.isFinite(port)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain");
        res.end("Invalid port");
        return;
      }
      const bodyBuf = await readBody(req);
      const body: ArrayBuffer | undefined =
        bodyBuf.byteLength > 0
          ? (bodyBuf.buffer.slice(
              bodyBuf.byteOffset,
              bodyBuf.byteOffset + bodyBuf.byteLength,
            ) as ArrayBuffer)
          : undefined;

      const restParts = parts.slice(3);
      const pathname = restParts.length ? `/${restParts.join("/")}` : "/";
      const targetPath = pathname + url.search;

      const result = await opts.proxy.handleRequest(
        instanceId,
        port,
        (req.method || "GET").toUpperCase(),
        targetPath,
        headersToRecord(req.headers),
        body,
      );

      res.statusCode = result.statusCode;
      for (const [k, v] of Object.entries(result.headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) res.setHeader(k, v);
        else res.setHeader(k, v);
      }
      const payload = result.body
        ? Buffer.isBuffer(result.body)
          ? result.body
          : Buffer.from(result.body as any)
        : Buffer.alloc(0);
      res.end(payload);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    kind: "local-http",
    get baseUrl() {
      return baseUrl;
    },
    async start() {
      if (server) return;
      server = http.createServer((req, res) => {
        void onRequest(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(listenPort, host, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://${host}:${addr.port}`;
      } else {
        baseUrl = `http://${host}`;
      }
      opts.proxy.setBaseUrl(baseUrl);
    },
    async stop() {
      const s = server;
      server = null;
      baseUrl = null;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        // Teardown is called after the owning browser session closes. Force any
        // remaining keep-alive connections out of the local ingress so a large
        // sequence of headless previews cannot accumulate stale sockets.
        s.closeIdleConnections?.();
        s.closeAllConnections?.();
      });
    },
  };
}
