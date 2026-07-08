import { describe, it, expect, beforeAll } from "vitest";
import { Buffer } from "../polyfills/buffer";
import {
  collectSetCookies,
  installFetchHeadersSetCookieParity,
  installNodeFetchClassParity,
  setFetchResponse,
} from "../polyfills/fetch-response";
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

describe("Fetch→Node handler chain (class parity)", () => {
  beforeAll(() => {
    installFetchHeadersSetCookieParity();
    installNodeFetchClassParity();
  });

  it("Response + setFetchResponse preserve multiple Set-Cookie headers", async () => {
    const server = createServer(async (_req, res) => {
      const responseHeaders = new Headers();
      responseHeaders.append(
        "set-cookie",
        "app.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
      );
      responseHeaders.append(
        "set-cookie",
        "app.session_data=chunk; Path=/; HttpOnly; SameSite=Lax",
      );
      const response = new Response(JSON.stringify({ token: "abc" }), {
        status: 200,
        headers: responseHeaders,
      });
      expect(collectSetCookies(response.headers)).toHaveLength(2);
      await setFetchResponse(res, response);
    });
    await new Promise<void>((r) => server.listen(3004, r));

    const result = await server.dispatchRequest("POST", "/sign-in", {
      host: "localhost:3004",
    });
    server.close();

    const setCookie = result.headers["set-cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie).toHaveLength(2);
  });

  it("Request keeps Cookie and Origin from IncomingMessage-style headers", () => {
    const req = new Request("http://localhost:5173/get-session", {
      method: "POST",
      headers: {
        cookie: "app.session_token=abc; app.session_data=chunk",
        origin: "http://localhost:3333",
        host: "localhost:5173",
      },
    });

    expect(req.headers.get("cookie")).toContain("app.session_token");
    expect(req.headers.get("origin")).toBe("http://localhost:3333");
  });

  it("sign-in then get-session through vite proxy + cross-worker bridge", async () => {
    const authServer = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url.includes("sign-in")) {
        const responseHeaders = new Headers();
        responseHeaders.append(
          "set-cookie",
          "app.session_token=signed.token; Path=/; HttpOnly; SameSite=Lax",
        );
        responseHeaders.append(
          "set-cookie",
          "app.session_data=chunk; Path=/; HttpOnly; SameSite=Lax",
        );
        const response = new Response(JSON.stringify({ token: "signed.token" }), {
          status: 200,
          headers: responseHeaders,
        });
        await setFetchResponse(res, response);
        return;
      }
      if (url.includes("get-session")) {
        const cookie = req.headers.cookie ?? "";
        res.setHeader("Content-Type", "application/json");
        if (cookie.includes("app.session_token=signed.token")) {
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
            headers: { ...req.headers, host: "localhost:3000" } as Record<
              string,
              string
            >,
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
      "/api/auth/sign-in",
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
    setHttpClientBridge(null);

    expect(session.statusCode).toBe(200);
    expect(session.body.toString("utf8")).toContain('"session"');
  });
});
