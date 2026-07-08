import { describe, it, expect, afterEach } from "vitest";
import {
  collectSetCookies,
  installFetchHeadersSetCookieParity,
} from "../polyfills/fetch-response";

describe("installFetchHeadersSetCookieParity", () => {
  const patchKey = Symbol.for("nodepod.fetchHeadersSetCookieParity");

  afterEach(() => {
    delete (Headers.prototype as { [key: symbol]: unknown })[patchKey];
  });

  it("preserves multiple Set-Cookie values when copying Headers", () => {
    installFetchHeadersSetCookieParity();

    const copyHeaders = (target: Headers, source: HeadersInit | undefined) => {
      if (!source) return;
      for (const [key, value] of new Headers(source).entries()) {
        if (key.toLowerCase() === "set-cookie") target.append(key, value);
        else target.set(key, value);
      }
    };

    const responseHeaders = new Headers();
    responseHeaders.append(
      "Set-Cookie",
      "app.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
    );
    responseHeaders.append(
      "Set-Cookie",
      "app.session_data=chunk; Path=/; HttpOnly; SameSite=Lax",
    );

    const headers = new Headers();
    copyHeaders(headers, responseHeaders);
    headers.set("Content-Type", "application/json");
    const response = new Response(JSON.stringify({ token: "abc" }), {
      status: 200,
      headers,
    });

    const cookies = collectSetCookies(response.headers);
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.includes("app.session_token"))).toBe(true);
  });
});
