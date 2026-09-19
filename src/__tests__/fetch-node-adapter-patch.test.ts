import { describe, it, expect, vi } from "vitest";
import { createServer } from "../polyfills/http";
import {
  patchFetchNodeAdapterExports,
  setFetchResponse,
} from "../polyfills/fetch-response";

describe("patchFetchNodeAdapterExports", () => {
  it("leaves null, undefined and primitive module exports alone", () => {
    // lodash/_coreJsData.js exports undefined; other CJS modules export
    // null, numbers or strings. None of those may throw.
    expect(() => patchFetchNodeAdapterExports(undefined)).not.toThrow();
    expect(() => patchFetchNodeAdapterExports(null)).not.toThrow();
    expect(() => patchFetchNodeAdapterExports(42 as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => patchFetchNodeAdapterExports("x" as unknown as Record<string, unknown>)).not.toThrow();
  });

  it("replaces setResponse on getRequest + setResponse export pairs", async () => {
    const original = async () => {};
    const exports: Record<string, unknown> = {
      getRequest: () => new Request("http://localhost/"),
      setResponse: original,
    };
    patchFetchNodeAdapterExports(exports);
    expect(exports.setResponse).toBe(setFetchResponse);
    expect(exports.setResponse).not.toBe(original);

    const server = createServer(async (_req, res) => {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "session=a; Path=/; HttpOnly");
      headers.append("Set-Cookie", "session_data=b; Path=/; HttpOnly");
      const response = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      });
      await (exports.setResponse as typeof setFetchResponse)(res, response);
    });
    await new Promise<void>((r) => server.listen(3002, r));

    const result = await server.dispatchRequest("POST", "/sign-in", {
      host: "localhost:3002",
    });
    server.close();

    const setCookie = result.headers["set-cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie).toHaveLength(2);
  });

  it("ignores modules without a getRequest + setResponse pair", () => {
    const original = async () => {};
    const exports: Record<string, unknown> = { setResponse: original };
    patchFetchNodeAdapterExports(exports);
    expect(exports.setResponse).toBe(original);
  });

  it("rewrites toNodeHandler to use setFetchResponse", async () => {
    const exports: Record<string, unknown> = {
      getRequest: ({ request }: { request: unknown }) =>
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      setResponse: async () => {},
      toNodeHandler: (handler: unknown) => handler,
    };
    patchFetchNodeAdapterExports(exports);
    expect(exports.setResponse).toBe(setFetchResponse);
    expect(typeof exports.toNodeHandler).toBe("function");

    const handler = async () => {
      const headers = new Headers();
      headers.append("set-cookie", "better-auth.session_token=abc; Path=/; HttpOnly");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      });
    };
    const nodeHandler = (exports.toNodeHandler as (h: unknown) => Function)(handler);
    const setHeader = vi.fn();
    const end = vi.fn();
    const res = {
      setHeader,
      getHeaderNames: () => [],
      removeHeader: () => {},
      writeHead: () => res,
      end,
      statusCode: 200,
      destroyed: false,
      on: () => res,
      off: () => res,
      write: () => true,
    };
    await nodeHandler(
      { headers: { host: "localhost:5173" }, method: "POST", url: "/api/auth/sign-in/email" },
      res,
    );
    expect(setHeader).toHaveBeenCalledWith(
      "set-cookie",
      expect.arrayContaining([expect.stringContaining("better-auth.session_token=abc")]),
    );
  });
});
