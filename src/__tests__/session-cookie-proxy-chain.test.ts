import { describe, it, expect, afterEach } from "vitest";
import { Buffer } from "../polyfills/buffer";
import {
  createServer,
  request,
  setHttpClientBridge,
} from "../polyfills/http";

function cookiesToHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return "";
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list
    .map((raw) => {
      const semi = raw.indexOf(";");
      return semi >= 0 ? raw.slice(0, semi) : raw;
    })
    .join("; ");
}

describe("Session cookie proxy chain (http polyfill parity)", () => {
  afterEach(() => {
    setHttpClientBridge(null);
  });

  it("vite proxy preserves Set-Cookie from upstream auth server", async () => {
    const authServer = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.includes("sign-in")) {
        res.setHeader("Set-Cookie", [
          "app.session_token=signed.token.value; Path=/; HttpOnly; SameSite=Lax",
          "app.session_data=chunk; Path=/; HttpOnly; SameSite=Lax",
        ]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ token: "signed.token.value", user: { id: "1" } }));
        return;
      }
      if (url.includes("get-session")) {
        const cookie = req.headers.cookie ?? "";
        res.setHeader("Content-Type", "application/json");
        if (cookie.includes("app.session_token=signed.token.value")) {
          res.end(JSON.stringify({ session: { id: "s1" }, user: { id: "1" } }));
        } else {
          res.end("null");
        }
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((r) => authServer.listen(3000, r));

    setHttpClientBridge(async (port, method, path, headers, body) =>
      authServer.dispatchRequest(method, path, headers, body),
    );

    const viteServer = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (!url.startsWith("/api/auth")) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const upstreamPath = url.replace(/^\/api\/auth/, "") || "/";
      await new Promise<void>((resolve, reject) => {
        const r = request(
          {
            hostname: "localhost",
            port: 3000,
            path: upstreamPath,
            method: req.method,
            headers: { ...req.headers, host: "localhost:3000" } as Record<string, string>,
          },
          (incoming) => {
            for (const [k, v] of Object.entries(incoming.headers)) {
              if (v !== undefined) res.setHeader(k, v as string | string[]);
            }
            res.statusCode = incoming.statusCode ?? 500;
            const chunks: Buffer[] = [];
            incoming.on("data", (c: Buffer | string) =>
              chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))),
            );
            incoming.on("end", () => {
              res.end(Buffer.concat(chunks));
              resolve();
            });
          },
        );
        r.on("error", reject);
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer | string) =>
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))),
          );
          req.on("end", () => r.end(Buffer.concat(chunks)));
        } else {
          r.end();
        }
      });
    });
    await new Promise<void>((r) => viteServer.listen(5173, r));

    const signIn = await viteServer.dispatchRequest(
      "POST",
      "/api/auth/sign-in/email",
      { "content-type": "application/json", host: "localhost:5173" },
      Buffer.from("{}"),
    );

    expect(signIn.statusCode).toBe(200);
    expect(signIn.headers["set-cookie"]).toBeTruthy();

    const cookieHeader = cookiesToHeader(signIn.headers["set-cookie"]);
    const session = await viteServer.dispatchRequest(
      "GET",
      "/api/auth/get-session",
      { host: "localhost:5173", cookie: cookieHeader },
    );

    authServer.close();
    viteServer.close();

    expect(session.statusCode).toBe(200);
    expect(session.body.toString("utf8")).toContain('"session"');
  });
});
