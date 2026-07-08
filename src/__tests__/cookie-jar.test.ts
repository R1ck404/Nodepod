import { describe, it, expect } from "vitest";
import {
  VirtualCookieJar,
  parseSetCookie,
  cookiePathMatches,
  mergeCookieHeaders,
} from "../cookie-jar";
import { RequestProxy } from "../request-proxy";
import { Buffer } from "../polyfills/buffer";

describe("VirtualCookieJar", () => {
  it("stores and replays cookies for path /", () => {
    const jar = new VirtualCookieJar();
    jar.store("default", 5173, [
      "app.session_token=abc.defghijklmnopqrstuvwxyz0123456789ABCD%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
    ]);
    const header = jar.cookieHeader("default", 5173, "/api/auth/get-session");
    expect(header).toContain("app.session_token=");
    expect(header).toContain("abc.defghijklmnopqrstuvwxyz0123456789ABCD%3D");
  });

  it("mergeCookieHeaders prefers jar cookies over browser cookies", () => {
    const merged = mergeCookieHeaders(
      "other=1; app.session_token=old",
      "app.session_token=new",
    );
    expect(merged).toContain("app.session_token=new");
    expect(merged).not.toContain("old");
    expect(merged).toContain("other=1");
  });

  it("parseSetCookie handles Max-Age", () => {
    const parsed = parseSetCookie("a=b; Max-Age=3600; Path=/");
    expect(parsed?.name).toBe("a");
    expect(parsed?.rec.value).toBe("b");
    expect(parsed?.rec.path).toBe("/");
    expect(parsed?.rec.expires).toBeGreaterThan(Date.now());
  });

  it("deletes cookies on Max-Age=0", () => {
    const jar = new VirtualCookieJar();
    jar.store("default", 5173, [
      "app.session_token=abc; Max-Age=604800; Path=/",
      "app.session_data=xyz; Max-Age=604800; Path=/",
      "app.session_data.0=chunk0; Max-Age=604800; Path=/",
    ]);
    expect(jar.cookieHeader("default", 5173, "/api/auth/get-session")).toContain(
      "app.session_token=",
    );

    jar.store("default", 5173, [
      "app.session_token=; Max-Age=0; Path=/; HttpOnly",
      "app.session_data=; Max-Age=0; Path=/; HttpOnly",
      "app.session_data.0=; Max-Age=0; Path=/; HttpOnly",
    ]);
    expect(jar.cookieHeader("default", 5173, "/api/auth/get-session")).toBe("");
  });

  it("cookiePathMatches works for root path cookies", () => {
    expect(cookiePathMatches("/api/auth/get-session", "/")).toBe(true);
    expect(cookiePathMatches("/api/auth/get-session", "/api")).toBe(true);
    expect(cookiePathMatches("/other", "/api")).toBe(false);
  });
});

describe("RequestProxy virtual cookie replay", () => {
  it("injects stored session cookies into worker requests", async () => {
    const proxy = new RequestProxy({ baseUrl: "http://test.local" });
    proxy.register(
      {
        listening: true,
        address: () => ({ port: 5173, address: "0.0.0.0", family: "IPv4" }),
        async dispatchRequest(_method, _url, headers) {
          const hasSession = (headers.cookie ?? "").includes("session=abc");
          return {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "content-type": "application/json" },
            body: Buffer.from(hasSession ? '{"session":true}' : "null"),
          };
        },
      },
      5173,
    );

    (proxy as any)._storeResponseCookies("default", 5173, {
      "set-cookie": "session=abc; Path=/; HttpOnly",
    });

    const hdrs: Record<string, string> = {};
    (proxy as any)._injectVirtualCookies(
      "default",
      5173,
      "/api/auth/get-session",
      hdrs,
    );
    expect(hdrs.cookie).toContain("session=abc");

    const resp = await proxy.handleRequest(
      "default",
      5173,
      "GET",
      "/api/auth/get-session",
      hdrs,
    );
    expect(resp.body.toString("utf8")).toContain('"session":true');
  });

  it("does not resurrect cleared SW cookies from a stale local jar", async () => {
    const proxy = new RequestProxy({ baseUrl: "http://test.local" });
    let sawCookie = "";
    proxy.register(
      {
        listening: true,
        address: () => ({ port: 5173, address: "0.0.0.0", family: "IPv4" }),
        async dispatchRequest(_method, _url, headers) {
          sawCookie = headers.cookie ?? "";
          return {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "content-type": "application/json" },
            body: Buffer.from(sawCookie ? '{"session":true}' : "null"),
          };
        },
      },
      5173,
    );

    (proxy as any)._storeResponseCookies("default", 5173, {
      "set-cookie":
        "app.session_token=abc; Path=/; Max-Age=604800; HttpOnly",
    });

    await proxy.handleRequest(
      "default",
      5173,
      "GET",
      "/api/auth/get-session",
      { cookie: "app.session_token=abc" },
      undefined,
      { skipCookieInject: true },
    );
    expect(sawCookie).toBe("app.session_token=abc");

    (proxy as any)._storeResponseCookies("default", 5173, {
      "set-cookie": "app.session_token=; Max-Age=0; Path=/; HttpOnly",
    });

    sawCookie = "unset";
    const resp = await proxy.handleRequest(
      "default",
      5173,
      "GET",
      "/api/auth/get-session",
      {},
      undefined,
      { skipCookieInject: true },
    );
    expect(sawCookie).toBe("");
    expect(resp.body.toString("utf8")).toBe("null");
  });
});
