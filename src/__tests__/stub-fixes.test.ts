import { describe, it, expect, vi, afterEach } from "vitest";
import assert from "../polyfills/assert";
import { isIP, isIPv4 } from "../polyfills/net";
import { ClientHttp2Session, Http2Stream } from "../polyfills/http2";
import { lookup, resolve4 } from "../polyfills/dns";
import { compose, PassThrough, Transform } from "../polyfills/stream";
import { MemoryVolume } from "../memory-volume";
import { Buffer } from "../polyfills/buffer";
import {
  BrotliCompressStream,
  BrotliDecompressStream,
  preloadBrotli,
} from "../polyfills/zlib";
import osDefault, { availableParallelism, cpus } from "../polyfills/os";

describe("assert.strict", () => {
  it("assert.strict.equal uses ===", () => {
    expect(() => assert.strict.equal(1, "1" as any)).toThrow();
    expect(() => assert.strict.equal(1, 1)).not.toThrow();
  });

  it("assert.equal remains loose", () => {
    expect(() => assert.equal(1, "1" as any)).not.toThrow();
  });
});

describe("net.isIP", () => {
  it("accepts valid IPv4", () => {
    expect(isIP("127.0.0.1")).toBe(4);
    expect(isIPv4("192.168.1.1")).toBe(true);
  });

  it("rejects out-of-range octets", () => {
    expect(isIP("999.999.999.999")).toBe(0);
    expect(isIP("1.2.3.256")).toBe(0);
  });

  it("accepts basic IPv6", () => {
    expect(isIP("::1")).toBe(6);
    expect(isIP("2001:db8::1")).toBe(6);
  });
});

describe("http2 session flags", () => {
  it("tracks closed/destroyed", () => {
    const session = new ClientHttp2Session();
    expect(session.closed).toBe(false);
    expect(session.destroyed).toBe(false);
    session.close();
    expect(session.closed).toBe(true);
    session.destroy();
    expect(session.destroyed).toBe(true);
  });

  it("Http2Stream close sets closed", () => {
    const stream = new Http2Stream();
    expect(stream.closed).toBe(false);
    stream.close();
    expect(stream.closed).toBe(true);
  });
});

describe("dns DoH", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("localhost short-circuits", async () => {
    const result = await new Promise<{ addr?: string; fam?: number }>((resolve, reject) => {
      lookup("localhost", (err, addr, fam) => {
        if (err) reject(err);
        else resolve({ addr, fam });
      });
    });
    expect(result.addr).toBe("127.0.0.1");
    expect(result.fam).toBe(4);
  });

  it("uses DoH for remote hosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ type: 1, data: "93.184.216.34" }],
          }),
          { status: 200, headers: { "content-type": "application/dns-json" } },
        ),
      ),
    );
    const addrs = await new Promise<string[]>((resolve, reject) => {
      resolve4("example.com", (err, a) => (err ? reject(err) : resolve(a ?? [])));
    });
    expect(addrs).toEqual(["93.184.216.34"]);
    expect(fetch).toHaveBeenCalled();
  });

  it("returns ENOTFOUND on NXDOMAIN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ Status: 3, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        }),
      ),
    );
    await expect(
      new Promise((resolve, reject) => {
        lookup("no.such.domain.invalid", (err) => (err ? reject(err) : resolve(null)));
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("stream.compose", () => {
  it("pipes through transforms", async () => {
    const upper = new Transform({
      transform(chunk: unknown, _enc: string, cb: (err: Error | null, data?: Buffer) => void) {
        cb(null, Buffer.from(String(chunk).toUpperCase()));
      },
    });
    const suffix = new Transform({
      transform(chunk: unknown, _enc: string, cb: (err: Error | null, data?: Buffer) => void) {
        cb(null, Buffer.from(String(chunk) + "!"));
      },
    });
    const composed = compose(upper, suffix);
    const out: string[] = [];
    const ended = new Promise<void>((resolve, reject) => {
      composed.on("data", (c) => out.push(String(c)));
      composed.on("end", () => resolve());
      composed.on("error", reject);
    });
    composed.write("hi");
    composed.end();
    await ended;
    expect(out.join("")).toBe("HI!");
  });
});

describe("memory-volume chmod dirs", () => {
  it("stores directory mode", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/d", { recursive: true });
    vol.chmodSync("/d", 0o700);
    expect(vol.statSync("/d").mode & 0o777).toBe(0o700);
  });
});

describe("sed invalid regex", () => {
  it("fails on invalid s/// pattern", async () => {
    const { builtins } = await import("../shell/shell-builtins");
    const sed = builtins.get("sed")!;
    const ctx = {
      cwd: "/",
      env: {},
      volume: new MemoryVolume(),
    } as any;
    const result = await sed(["s/[a/b/"], ctx, "abc\n");
    expect(result.exitCode).not.toBe(0);
    // GNU sed: an open bracket runs to the end, so the command is unterminated
    expect(result.stderr).toMatch(/unterminated `s' command/);
  });
});

describe("brotli stream framing", () => {
  it("roundtrips multi-chunk compress/decompress", async () => {
    const ok = await preloadBrotli();
    expect(ok).toBe(true);
    const compress = new BrotliCompressStream();
    const decompress = new BrotliDecompressStream();
    const chunks: Buffer[] = [];
    decompress.on("data", (c) => chunks.push(Buffer.from(c)));
    const done = new Promise<void>((resolve, reject) => {
      decompress.on("end", () => resolve());
      decompress.on("error", reject);
      compress.on("error", reject);
    });
    compress.pipe(decompress);
    compress.write("hello ");
    compress.write("world");
    compress.end();
    await done;
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
  });
});

describe("os.availableParallelism", () => {
  it("matches cpus().length on named and default exports", () => {
    expect(availableParallelism()).toBe(cpus().length);
    expect(osDefault.availableParallelism()).toBe(cpus().length);
    expect(availableParallelism()).toBeGreaterThanOrEqual(1);
  });
});
