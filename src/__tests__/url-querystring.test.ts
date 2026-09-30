import { describe, it, expect } from "vitest";

import { parse, format, fileURLToPath } from "../polyfills/url";
import { parse as nativeParse, format as nativeFormat } from "node:url";
import { parse as qsParse, stringify as qsStringify } from "../polyfills/querystring";
import { stringify as nativeQsStringify } from "node:querystring";
import { Console } from "../polyfills/console";
import { DEFAULT_ENV, MOCK_OS } from "../constants/config";
import { WriteStream } from "../polyfills/tty";

describe("url.parse", () => {
  it("preserves schemes without authority slashes when formatting current fields", () => {
    for (const input of ["mailto:user@example.com", "urn:isbn:978", "data:text/plain,hello", "custom:opaque?q=1#part", "custom://host/path", "file:///tmp/a"]) {
      const parsed = parse(input, true);
      const expected = nativeParse(input, true);
      expect(parsed.slashes).toBe(expected.slashes);
      expect(format(parsed)).toBe(nativeFormat(expected));
      parsed.hash = "#edited";
      expected.hash = "#edited";
      expect(format(parsed)).toBe(nativeFormat(expected));
    }
  });
  it("returns an empty query object for queryless paths when requested", () => {
    for (const input of ["/", "/page", "/page?", "http://localhost/page"]) {
      const result = parse(input, true);
      const native = nativeParse(input, true);
      expect(result.query).toEqual(native.query);
      expect(Object.getPrototypeOf(result.query)).toBeNull();
      expect(result.search).toBe(native.search);
    }
  });

  it("preserves repeated and prototype-named query keys", () => {
    for (const input of ["/page?a=1&a=2&__proto__=safe&constructor=value", "http://localhost/?a=1&a=2"]) {
      expect(parse(input, true).query).toEqual(nativeParse(input, true).query);
    }
  });

  it("formats current routing fields rather than the original href", () => {
    const parsed = parse("http://localhost:3000/old", true);
    parsed.pathname = "/new";
    parsed.query = { q: "two words", tag: ["one", "two"] };
    const native = nativeParse("http://localhost:3000/old", true);
    native.pathname = parsed.pathname;
    native.query = parsed.query;
    expect(format(parsed)).toBe(nativeFormat(native));
    expect(format(parsed)).toBe("http://localhost:3000/new?q=two%20words&tag=one&tag=two");
  });
  it("keeps path-only URLs hostless", () => {
    const u = parse("/foo");
    expect(u.hostname).toBeNull();
    expect(u.host).toBeNull();
    expect(u.protocol).toBeNull();
    expect(u.pathname).toBe("/foo");
    expect(u.href).toBe("/foo");
  });

  it("parses absolute URLs", () => {
    const u = parse("https://example.com/a?b=1");
    expect(u.hostname).toBe("example.com");
    expect(u.pathname).toBe("/a");
    expect(u.query).toBe("b=1");
  });
});

describe("url.fileURLToPath", () => {
  it("converts file: URLs", () => {
    expect(fileURLToPath("file:///home/user/x")).toBe("/home/user/x");
  });

  it("throws on non-file schemes", () => {
    expect(() => fileURLToPath("https://example.com/x")).toThrow(/file:/);
    try {
      fileURLToPath("https://example.com/x");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ERR_INVALID_URL_SCHEME");
    }
  });
});

describe("querystring.stringify", () => {
  it("preserves empty own fields through a loader-option round trip", () => {
    const options = { mode: undefined, enabled: false, filename: "/app/a b.js" };
    const query = qsStringify(options);
    expect(query).toBe(nativeQsStringify(options));
    expect(qsParse(query).mode).toBe("");
    expect(JSON.stringify(qsParse(query).mode)).toBe("\"\"");
    expect(qsParse(qsStringify({})).mode).toBeUndefined();
  });

  it("matches Node for unsupported values, finite primitives and arrays", () => {
    const value = {
      absent: undefined, nil: null, nan: NaN, infinite: Infinity,
      object: { toString() { throw Error("must not coerce objects"); } },
      callable: () => 1, symbol: Symbol("ignored"), bigint: 123n,
      values: [undefined, null, {}, [], NaN, -Infinity, 0, -0, 1.2, true, false, 9n, "a & b"],
      empty: [], sparse: new Array(2),
    };
    for (const separators of [["&", "="], [";", ":"], ["||", "=>"]]) {
      expect(qsStringify(value, ...separators as [string, string])).toBe(
        nativeQsStringify(value as any, ...separators as [string, string]),
      );
    }
  });
});

describe("querystring.parse", () => {
  it("does not throw on invalid percent escapes", () => {
    expect(() => qsParse("a=%ZZ")).not.toThrow();
    expect(qsParse("a=%ZZ").a).toBe("%ZZ");
  });

  it("still decodes valid escapes", () => {
    expect(qsParse("a=%20").a).toBe(" ");
  });
});

describe("Console formatting", () => {
  it("formats circular objects without throwing", () => {
    const chunks: string[] = [];
    const c = new Console({
      write(s: string) {
        chunks.push(s);
      },
    } as any);
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => c.log(obj)).not.toThrow();
    expect(chunks.join("").length).toBeGreaterThan(0);
  });

  it("formats BigInt without throwing", () => {
    const chunks: string[] = [];
    const c = new Console({
      write(s: string) {
        chunks.push(s);
      },
    } as any);
    expect(() => c.log(1n)).not.toThrow();
    expect(chunks.join("")).toContain("1n");
  });
});

describe("tty / HOME", () => {
  it("hasColors is false when not a TTY", () => {
    const ws = new WriteStream();
    expect(ws.isTTY).toBe(false);
    expect(ws.hasColors()).toBe(false);
    expect(ws.getColorDepth()).toBe(1);
  });

  it("HOME matches os.homedir mock", () => {
    expect(DEFAULT_ENV.HOME).toBe(MOCK_OS.HOMEDIR);
  });
});
