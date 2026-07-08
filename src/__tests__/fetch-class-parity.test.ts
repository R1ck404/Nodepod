import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  collectSetCookies,
  installNodeFetchClassParity,
  toGuardlessHeaders,
} from "../polyfills/fetch-response";

// Browsers silently drop forbidden headers (Cookie/Host/Origin on Request,
// Set-Cookie on Response) inside the Fetch class constructors. Node has no
// guards. These tests assert the wrappers keep Node semantics; the browser
// behavior itself can only be verified in a real browser realm.
describe("installNodeFetchClassParity", () => {
  const NativeRequest = globalThis.Request;
  const NativeResponse = globalThis.Response;

  beforeAll(() => {
    delete (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("nodepod.fetchClassHeaderParity")
    ];
    installNodeFetchClassParity();
  });

  afterAll(() => {
    globalThis.Request = NativeRequest;
    globalThis.Response = NativeResponse;
    delete (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("nodepod.fetchClassHeaderParity")
    ];
  });

  it("Request keeps Cookie/Host/Origin headers", () => {
    const req = new Request("http://localhost:5173/api/get-session", {
      headers: {
        cookie: "app.session_token=abc",
        host: "localhost:5173",
        origin: "http://localhost:3333",
      },
    });
    expect(req.headers.get("cookie")).toBe("app.session_token=abc");
    expect(req.headers.get("host")).toBe("localhost:5173");
    expect(req.headers.get("origin")).toBe("http://localhost:3333");
  });

  it("Request clone keeps forbidden headers", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { cookie: "s=1", "content-type": "application/json" },
    });
    const cloned = req.clone();
    expect(cloned.headers.get("cookie")).toBe("s=1");
    expect(await cloned.json()).toEqual({ a: 1 });
  });

  it("Response keeps Set-Cookie headers", () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", "session=a; Path=/; HttpOnly");
    headers.append("set-cookie", "session_data=b; Path=/; HttpOnly");
    const res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers,
    });
    expect(collectSetCookies(res.headers)).toEqual([
      "session=a; Path=/; HttpOnly",
      "session_data=b; Path=/; HttpOnly",
    ]);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("Response infers content-type from string body like native", async () => {
    const res = new Response("hello");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello");
  });

  it("Response clone keeps Set-Cookie", async () => {
    const res = new Response("x", {
      headers: { "set-cookie": "a=1; Path=/" },
    });
    const cloned = res.clone();
    expect(collectSetCookies(cloned.headers)).toEqual(["a=1; Path=/"]);
    expect(await cloned.text()).toBe("x");
  });

  it("Response.json static keeps cookies and sets content-type", () => {
    const headers = new Headers();
    headers.append("set-cookie", "tok=1; Path=/");
    const res = Response.json({ ok: true }, { headers });
    expect(collectSetCookies(res.headers)).toEqual(["tok=1; Path=/"]);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("Response.redirect sets location and validates status", () => {
    const res = Response.redirect("http://localhost/next", 302);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/next");
    expect(() => Response.redirect("http://localhost/", 200)).toThrow(
      RangeError,
    );
  });

  it("native instances still satisfy instanceof against patched globals", () => {
    const native = Response.error();
    expect(native instanceof Response).toBe(true);
    const req = new NativeRequest("http://localhost/");
    expect(req instanceof Request).toBe(true);
  });

  it("toGuardlessHeaders handles records, arrays and Headers", () => {
    const fromRecord = toGuardlessHeaders({
      cookie: "a=1",
      "set-cookie": ["x=1; Path=/", "y=2; Path=/"],
    });
    expect(fromRecord.get("cookie")).toBe("a=1");
    expect(collectSetCookies(fromRecord)).toEqual(["x=1; Path=/", "y=2; Path=/"]);

    const fromArray = toGuardlessHeaders([["host", "localhost:3000"]]);
    expect(fromArray.get("host")).toBe("localhost:3000");

    const src = new Headers();
    src.append("set-cookie", "z=3; Path=/");
    src.set("accept", "text/html");
    const fromHeaders = toGuardlessHeaders(src);
    expect(collectSetCookies(fromHeaders)).toEqual(["z=3; Path=/"]);
    expect(fromHeaders.get("accept")).toBe("text/html");
  });
});
