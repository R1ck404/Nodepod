import { describe, it, expect } from "vitest";
import { createServer } from "../polyfills/http";
import {
  patchFetchNodeAdapterExports,
  setFetchResponse,
} from "../polyfills/fetch-response";

describe("patchFetchNodeAdapterExports", () => {
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
});
