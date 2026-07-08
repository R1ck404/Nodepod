// Bridge Fetch API Response → Node.js ServerResponse with correct Set-Cookie handling.
// Browser Fetch forbids reading Set-Cookie via headers.get() / iteration; use getSetCookie().

import { splitCookiesString } from "set-cookie-parser";
import type { ServerResponse } from "./http";

const HEADERS_PATCH = Symbol.for("nodepod.fetchHeadersSetCookieParity");
const FETCH_CLASS_PATCH = Symbol.for("nodepod.fetchClassHeaderParity");

/**
 * Copy any HeadersInit into a bare `new Headers()` (guard "none"), which —
 * unlike Request/Response header lists — accepts every header including
 * Cookie, Host, Origin and Set-Cookie.
 */
export function toGuardlessHeaders(init?: HeadersInit | null): Headers {
  const out = new Headers();
  if (!init) return out;
  if (init instanceof Headers) {
    for (const cookie of collectSetCookies(init)) {
      out.append("set-cookie", cookie);
    }
    init.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      out.append(key, value);
    });
    return out;
  }
  const pairs: Iterable<[string, unknown]> = Array.isArray(init)
    ? (init as [string, unknown][])
    : Object.entries(init as Record<string, unknown>);
  for (const [key, value] of pairs) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, String(item));
    } else {
      out.append(key, String(value));
    }
  }
  return out;
}

/**
 * Node.js parity for the Fetch API in worker realms.
 *
 * Browsers enforce "forbidden header" guards inside the Request/Response
 * constructors: `new Request(url, {headers: {cookie}})` silently drops
 * Cookie/Host/Origin, and `new Response(body, {headers})` silently drops
 * Set-Cookie. Node (undici) has no such guards, so server frameworks that
 * round-trip Node requests through Fetch objects (Hono, SvelteKit adapters,
 * Fetch→Node HTTP bridges, ...) lose session cookies when run in a browser worker.
 *
 * This replaces the realm's Request/Response with subclasses whose `headers`
 * property is a guard-free Headers object, restoring Node semantics. Never
 * installed in Window realms (page code keeps native behavior).
 */
export function installNodeFetchClassParity(): void {
  if (
    typeof Request === "undefined" ||
    typeof Response === "undefined" ||
    typeof Headers === "undefined"
  ) {
    return;
  }
  // Only worker-like realms execute user Node code; leave pages untouched.
  if (typeof document !== "undefined") return;
  const g = globalThis as unknown as Record<PropertyKey, unknown>;
  if (g[FETCH_CLASS_PATCH]) return;
  g[FETCH_CLASS_PATCH] = true;

  const NativeRequest = Request;
  const NativeResponse = Response;

  const defineHeaders = (target: object, headers: Headers): void => {
    Object.defineProperty(target, "headers", {
      value: headers,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  };

  // Shadow from init, then merge headers the native constructor computed
  // itself (e.g. content-type inferred from a string/FormData body).
  const buildShadow = (
    initHeaders: HeadersInit | null | undefined,
    nativeHeaders: Headers,
  ): Headers => {
    const shadow = toGuardlessHeaders(initHeaders);
    nativeHeaders.forEach((value, key) => {
      if (!shadow.has(key)) shadow.set(key, value);
    });
    return shadow;
  };

  class NodeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input as RequestInfo, init);
      const source =
        init?.headers ??
        (input instanceof NativeRequest ? input.headers : undefined);
      defineHeaders(this, buildShadow(source, super.headers));
    }

    clone(): Request {
      const cloned = super.clone();
      defineHeaders(cloned, toGuardlessHeaders(this.headers));
      return cloned;
    }
  }

  class NodeResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      defineHeaders(this, buildShadow(init?.headers, super.headers));
    }

    clone(): Response {
      const cloned = super.clone();
      defineHeaders(cloned, toGuardlessHeaders(this.headers));
      return cloned;
    }

    static json(data: unknown, init?: ResponseInit): Response {
      const headers = toGuardlessHeaders(init?.headers ?? null);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return new NodeResponse(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers,
      });
    }

    static redirect(url: string | URL, status = 302): Response {
      if (![301, 302, 303, 307, 308].includes(status)) {
        throw new RangeError(`Invalid status code ${status}`);
      }
      return new NodeResponse(null, {
        status,
        headers: { location: String(url) },
      });
    }

    static error(): Response {
      return NativeResponse.error();
    }
  }

  // Native instances (fetch results, Response.error) must still satisfy
  // `x instanceof Request/Response` checks in user code.
  Object.defineProperty(NodeRequest, Symbol.hasInstance, {
    value: (value: unknown) => value instanceof NativeRequest,
  });
  Object.defineProperty(NodeResponse, Symbol.hasInstance, {
    value: (value: unknown) => value instanceof NativeResponse,
  });

  g.Request = NodeRequest;
  g.Response = NodeResponse;
}

/**
 * Replace setResponse on Fetch→Node HTTP adapter modules (export pairs with
 * getRequest + setResponse). Native adapter implementations often iterate
 * response.headers in ways that drop multiple Set-Cookie values in worker
 * realms even after Headers parity is installed.
 */
export function patchFetchNodeAdapterExports(
  exports: Record<string, unknown>,
): void {
  if (
    typeof exports.getRequest === "function" &&
    typeof exports.setResponse === "function"
  ) {
    exports.setResponse = setFetchResponse;
  }
}

/** Make Fetch Headers iteration/get behave like Node for Set-Cookie (browser worker parity). */
export function installFetchHeadersSetCookieParity(): void {
  if (typeof Headers === "undefined") return;
  const proto = Headers.prototype as Headers & { [HEADERS_PATCH]?: boolean };
  if (proto[HEADERS_PATCH]) return;
  proto[HEADERS_PATCH] = true;

  const origEntries = proto.entries;
  const origGet = proto.get;

  function* entriesWithSetCookies(
    this: Headers,
  ): Generator<[string, string], void, unknown> {
    const cookies =
      typeof this.getSetCookie === "function" ? this.getSetCookie() : [];
    for (const cookie of cookies) {
      yield ["set-cookie", cookie];
    }
    for (const [key, value] of origEntries.call(this)) {
      if (key.toLowerCase() === "set-cookie") continue;
      yield [key, value];
    }
  }

  proto.entries = function entries(this: Headers) {
    return entriesWithSetCookies.call(this);
  };

  const iter = Symbol.iterator;
  if (iter in proto) {
    proto[iter] = function iterator(this: Headers) {
      return entriesWithSetCookies.call(this);
    };
  }

  proto.forEach = function forEach(
    this: Headers,
    callback: (value: string, key: string, parent: Headers) => void,
    thisArg?: unknown,
  ) {
    for (const [key, value] of entriesWithSetCookies.call(this)) {
      callback.call(thisArg, value, key, this);
    }
  };

  proto.get = function get(this: Headers, name: string) {
    if (name.toLowerCase() === "set-cookie") {
      const cookies =
        typeof this.getSetCookie === "function" ? this.getSetCookie() : [];
      return cookies.length > 0 ? cookies.join(", ") : null;
    }
    return origGet.call(this, name);
  };
}

export function collectSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const fromGet = headers.get("set-cookie");
  if (fromGet) return splitCookiesString(fromGet);
  const cookies: string[] = [];
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(...splitCookiesString(value));
    }
  }
  return cookies;
}

/** Convert Fetch API response headers to Node.js IncomingMessage header record. */
export function fetchHeadersToNodeRecord(
  headers: Headers,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const setCookies = collectSetCookies(headers);
  if (setCookies.length > 0) out["set-cookie"] = setCookies;
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Copy Fetch headers into another Headers object (Node.js Set-Cookie parity). */
export function copyFetchHeaders(
  target: Headers,
  source: HeadersInit | Headers | undefined,
): void {
  if (!source) return;
  const src = toGuardlessHeaders(source);
  for (const cookie of collectSetCookies(src)) {
    target.append("Set-Cookie", cookie);
  }
  src.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    target.set(key, value);
  });
}

/** Build Fetch Headers from a Node-style header record (Set-Cookie arrays preserved). */
export function recordToFetchHeaders(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lk = key.toLowerCase();
    if (lk === "set-cookie") {
      const list = Array.isArray(value) ? value : [value];
      for (const cookie of list) out.append("Set-Cookie", cookie);
    } else {
      out.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return out;
}

/** Copy a Fetch Response onto a Node.js-style ServerResponse (Node http parity). */
export async function setFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const setCookies = collectSetCookies(response.headers);
  if (setCookies.length > 0) {
    try {
      res.setHeader("set-cookie", setCookies);
    } catch (error) {
      res.getHeaderNames().forEach((name) => res.removeHeader(name));
      res.writeHead(500).end(String(error));
      return;
    }
  }

  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    try {
      res.setHeader(key, value);
    } catch (error) {
      res.getHeaderNames().forEach((name) => res.removeHeader(name));
      res.writeHead(500).end(String(error));
      return;
    }
  }

  res.statusCode = response.status;
  res.writeHead(response.status);

  if (!response.body) {
    res.end();
    return;
  }

  if (response.body.locked) {
    res.end(
      "Fatal error: Response body is locked. This can happen when the response was already read (for example through 'response.json()' or 'response.text()').",
    );
    return;
  }

  const reader = response.body.getReader();
  if (res.destroyed) {
    reader.cancel();
    return;
  }

  const cancel = (error?: Error) => {
    res.off("close", cancel);
    res.off("error", cancel);
    reader.cancel(error).catch(() => {});
    if (error) res.destroy(error);
  };
  res.on("close", cancel);
  res.on("error", cancel);
  next();

  async function next() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          if (
            process.env.AWS_LAMBDA_FUNCTION_NAME ||
            process.env.LAMBDA_TASK_ROOT
          ) {
            continue;
          }
          res.once("drain", next);
          return;
        }
      }
      res.end();
    } catch (error) {
      cancel(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
