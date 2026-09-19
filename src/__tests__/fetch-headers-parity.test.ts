import { describe, it, expect, afterEach } from "vitest";
import {
  collectSetCookies,
  installFetchHeadersSetCookieParity,
} from "../polyfills/fetch-response";

type IterableHeaders = Headers & {
  entries(): IterableIterator<[string, string]>;
};

describe("installFetchHeadersSetCookieParity", () => {
  const patchKey = Symbol.for("nodepod.fetchHeadersSetCookieParity");

  afterEach(() => {
    delete (Headers.prototype as unknown as Record<symbol, unknown>)[patchKey];
  });

  it("preserves multiple Set-Cookie values when copying Headers", () => {
    installFetchHeadersSetCookieParity();

    const copyHeaders = (target: Headers, source: HeadersInit | undefined) => {
      if (!source) return;
      for (const [key, value] of (new Headers(source) as IterableHeaders).entries()) {
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

  it("keeps Set-Cookie readable when getSetCookie is unavailable", () => {
    const getSetCookie = (Headers.prototype as unknown as {
      getSetCookie?: () => string[];
    }).getSetCookie;
    try {
      delete (Headers.prototype as unknown as { getSetCookie?: unknown })
        .getSetCookie;
      delete (Headers.prototype as unknown as Record<symbol, unknown>)[patchKey];
      installFetchHeadersSetCookieParity();

      const headers = new Headers();
      headers.append("Set-Cookie", "session=abc; Path=/; HttpOnly");
      headers.append("Set-Cookie", "session_data=chunk; Path=/; HttpOnly");

      expect(headers.get("set-cookie")).toContain("session=abc");
      expect(collectSetCookies(headers)).toEqual([
        "session=abc; Path=/; HttpOnly",
        "session_data=chunk; Path=/; HttpOnly",
      ]);
      // lib has DOM but not DOM.Iterable; entries() exists at runtime.
      const entries = Array.from(headers as unknown as Iterable<[string, string]>);
      expect(entries).toEqual([
        ["set-cookie", "session=abc; Path=/; HttpOnly"],
        ["set-cookie", "session_data=chunk; Path=/; HttpOnly"],
      ]);
    } finally {
      if (getSetCookie) {
        Object.defineProperty(Headers.prototype, "getSetCookie", {
          configurable: true,
          writable: true,
          value: getSetCookie,
        });
      }
    }
  });
});
