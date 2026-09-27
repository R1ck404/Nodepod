// Behaviour pinned down by the round-3 performance changes: each fast path
// must answer exactly like the code it replaced (or like node, where the old
// code was wrong).
import { describe, it, expect, vi } from "vitest";
import { createHash as nodeCreateHash } from "node:crypto";
import { Buffer } from "../polyfills/buffer";
import { Writable, Duplex } from "../polyfills/stream";
import * as path from "../polyfills/path";
import { format, formatWithOptions } from "../polyfills/util";
import { isBuiltin } from "../polyfills/module";
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from "../polyfills/timers";
import { createHash, createHmac } from "../polyfills/crypto";
import { MemoryVolume } from "../memory-volume";
import { LRUCache } from "../memory-handler";
import { isInternalVfsPath } from "../constants/internal-vfs-paths";
import { buildFileSystemBridge } from "../polyfills/fs";

describe("Buffer fast paths", () => {
  it("subarray/slice follow typed array index rules and stay Buffers", () => {
    const b = Buffer.from("hello world");
    expect(b.subarray(1, 4).toString()).toBe("ell");
    expect(b.subarray(-5).toString()).toBe("world");
    expect(b.subarray(4, 2).length).toBe(0);
    expect(b.subarray(100).length).toBe(0);
    expect(b.slice(-3, -1).toString()).toBe("rl");
    expect(Buffer.isBuffer(b.subarray(2))).toBe(true);
    const view = b.subarray(6);
    view[0] = 87; // 'W'
    expect(b.toString()).toBe("hello World");
  });

  it("indexOf finds bytes and sequences like the byte loop did", () => {
    const b = Buffer.from("abcabcabd");
    expect(b.indexOf(99)).toBe(2);
    expect(b.indexOf(99, 3)).toBe(5);
    expect(b.indexOf(99, -2)).toBe(2);
    expect(b.indexOf(120)).toBe(-1);
    expect(b.indexOf("abd")).toBe(6);
    expect(b.indexOf("abc", 1)).toBe(3);
    expect(b.indexOf(Buffer.from("cab"))).toBe(2);
    expect(b.indexOf("zz")).toBe(-1);
    expect(b.indexOf("")).toBe(0);
    expect(b.includes("bca")).toBe(true);
  });

  it("from/toString utf8 fast paths and new Buffer(string)", () => {
    expect(Buffer.from("héllo").length).toBe(6);
    expect(Buffer.from("héllo", "utf-8").toString("utf8")).toBe("héllo");
    expect(Buffer.from("aGk=", "base64").toString()).toBe("hi");
    const legacy = new (Buffer as any)("hi there");
    expect(legacy.toString()).toBe("hi there");
    expect(new (Buffer as any)("6869", "hex").toString()).toBe("hi");
    expect(new (Buffer as any)(3).length).toBe(3);
    expect(Buffer.isEncoding("UTF8")).toBe(true);
    expect(Buffer.isEncoding("nope")).toBe(false);
    expect(Buffer.from("ab").equals(Buffer.from("abc"))).toBe(false);
  });
});

describe("streams don't keep what was written", () => {
  it("Writable counts in-flight bytes and objects, retains nothing", () => {
    const pending: Array<() => void> = [];
    const w = new (Writable as any)({ write: (_c: unknown, _e: string, cb: () => void) => pending.push(cb) });
    w.write("héllo");
    expect(w.writableLength).toBe(6);
    pending.shift()!();
    expect(w.writableLength).toBe(0);
    expect(w.getBuffer().length).toBe(0);

    const o = new (Writable as any)({ objectMode: true, write: (_c: unknown, _e: string, cb: () => void) => pending.push(cb) });
    o.write({ a: 1 });
    o.write({ b: 2 });
    expect(o.writableLength).toBe(2);
    pending.shift()!();
    expect(o.writableLength).toBe(1);
  });

  it("uncorking settles corked writes and emits drain", () => {
    const w = new (Writable as any)({ highWaterMark: 4, write: (_c: unknown, _e: string, cb: () => void) => cb() });
    const drained = vi.fn();
    w.on("drain", drained);
    w.cork();
    expect(w.write("12345")).toBe(false);
    w.writableNeedDrain = true;
    w.uncork();
    expect(w.writableLength).toBe(0);
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("Duplex write side counts the same way", () => {
    const pending: Array<() => void> = [];
    const d = new (Duplex as any)({ read() {}, write: (_c: unknown, _e: string, cb: () => void) => pending.push(cb) });
    d.write(Buffer.from("abc"));
    expect(d.writableLength).toBe(3);
    pending.shift()!();
    expect(d.writableLength).toBe(0);
  });
});

describe("path fast paths", () => {
  it("relative", () => {
    expect(path.relative("/app", "/app/src/a.ts")).toBe("src/a.ts");
    expect(path.relative("/", "/app/x")).toBe("app/x");
    expect(path.relative("/app/src", "/app")).toBe("..");
    expect(path.relative("/app/src", "/app/srcx/a")).toBe("../srcx/a");
    expect(path.relative("/a/b", "/a/b")).toBe("");
    expect(path.relative("/a/b/c", "/a/d")).toBe("../../d");
  });

  it("join", () => {
    expect(path.join("/a", "b", "../c")).toBe("/a/c");
    expect(path.join("a", "", "b")).toBe("a/b");
    expect(path.join("", "")).toBe(".");
    // same as the old filter/join form
    expect(path.join("/a/", "/b/")).toBe(path.normalize(["/a/", "/b/"].join("/")));
    expect((path.join as any)("a", undefined, "b")).toBe("a/b");
  });
});

describe("util", () => {
  it("formatWithOptions formats like format and checks its options", () => {
    expect(formatWithOptions({}, "%s=%d", "a", 1)).toBe(format("%s=%d", "a", 1));
    expect(formatWithOptions({ colors: true }, "x")).toBe("x");
    expect(() => formatWithOptions(null as any, "x")).toThrow(TypeError);
  });

  it("isBuiltin", () => {
    expect(isBuiltin("fs")).toBe(true);
    expect(isBuiltin("node:fs/promises")).toBe(true);
    expect(isBuiltin("fs/whatever")).toBe(true);
    expect(isBuiltin("./fs")).toBe(false);
    expect(isBuiltin("/fs")).toBe(false);
    expect(isBuiltin("lodash/debounce")).toBe(false);
  });
});

describe("timers", () => {
  it("setTimeout passes arguments, refresh re-arms, clearTimeout cancels", async () => {
    const seen: unknown[] = [];
    const t = nodeSetTimeout((a: unknown, b: unknown) => seen.push(a, b), 5, 1, 2);
    expect(typeof t.ref).toBe("function");
    expect(t.hasRef()).toBe(true);
    t.unref();
    expect(t.hasRef()).toBe(false);
    t.ref();
    // refresh before it fires re-arms it (after, the one-shot is closed)
    t.refresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([1, 2]);
    t.refresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([1, 2]);
    const c = nodeSetTimeout(() => seen.push("no"), 5);
    nodeClearTimeout(c);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([1, 2]);
  });
});

describe("crypto", () => {
  it("MD5 and HMAC stream through noble with node's results", () => {
    expect(createHash("md5").update("hello").digest("hex")).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(createHash("md5").update("hel").update("lo").digest("hex")).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(createHash("sha1").update("héllo").digest("hex")).toBe(createHash("sha1").update(Buffer.from("héllo")).digest("hex"));
    expect(createHmac("sha256", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"))
      .toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(createHmac("md5", "key").update("The quick brown fox ").update("jumps over the lazy dog").digest("hex"))
      .toBe("80070713463e7749b90c2dc24911e275");
    expect(createHash("sha256").update("x").digest("base64")).toBe(nodeCreateHash("sha256").update("x").digest("base64"));
    const big = "é".repeat(200_000);
    expect(createHash("sha1").update(big).digest("hex")).toBe(nodeCreateHash("sha1").update(big).digest("hex"));
  });
});

describe("volume fast paths", () => {
  it("kindSync / childKindsSync agree with stat", () => {
    const v = new MemoryVolume();
    v.mkdirSync("/d/sub", { recursive: true });
    v.writeFileSync("/d/f.txt", "abc");
    v.symlinkSync("/d/f.txt", "/d/link");
    expect(v.kindSync("/d")).toBe("directory");
    expect(v.kindSync("/d/f.txt")).toBe("file");
    expect(v.kindSync("/d/link")).toBe("file");
    expect(v.kindSync("/nope")).toBeNull();
    expect(v.childKindsSync("/d", ["sub", "f.txt", "link", "gone"])).toEqual(["directory", "file", "symlink", null]);
  });

  it("readdir withFileTypes gives the same dirents", () => {
    const v = new MemoryVolume();
    v.mkdirSync("/d/sub", { recursive: true });
    v.writeFileSync("/d/f.txt", "abc");
    v.symlinkSync("/d/f.txt", "/d/link");
    const fs = buildFileSystemBridge(v, () => "/");
    const dirents = fs.readdirSync("/d", { withFileTypes: true }) as any[];
    const shape = dirents.map((d) => [d.name, d.isFile(), d.isDirectory(), d.isSymbolicLink()]);
    expect(shape).toEqual([
      ["sub", false, true, false],
      ["f.txt", true, false, false],
      ["link", false, false, true],
    ]);
  });

  it("relative paths normalize like rooted ones", () => {
    const v = new MemoryVolume();
    v.writeFileSync("a/b.txt", "x");
    expect(v.existsSync("/a/b.txt")).toBe(true);
    expect(v.readFileSync("a/./b.txt", "utf8")).toBe("x");
    expect(v.existsSync("")).toBe(true);
  });

  it("watchers fire nearest ancestor first with relative names", () => {
    const v = new MemoryVolume();
    v.mkdirSync("/a/b", { recursive: true });
    const events: string[] = [];
    v.watch("/", { recursive: true }, (_e, name) => events.push(`/:${name}`));
    v.watch("/a", { recursive: true }, (_e, name) => events.push(`/a:${name}`));
    v.watch("/a/b", {}, (_e, name) => events.push(`/a/b:${name}`));
    v.writeFileSync("/a/b/c.txt", "1");
    expect(events).toEqual(["/a/b:c.txt", "/a:b/c.txt", "/:a/b/c.txt"]);
  });

  it("a directory move is one notification burst", () => {
    const v = new MemoryVolume();
    v.mkdirSync("/from/x", { recursive: true });
    v.writeFileSync("/from/x/1.txt", "1");
    v.writeFileSync("/from/2.txt", "2");
    const log: string[] = [];
    v.onNotificationBurst((start) => log.push(start ? "start" : "end"));
    v.watch("/", { recursive: true }, (_e, name) => log.push(name!));
    v.renameSync("/from", "/to");
    expect(log[0]).toBe("start");
    expect(log[log.length - 1]).toBe("end");
    expect(log).toContain("to/x/1.txt");
    v.writeFileSync("/single.txt", "s");
    expect(log[log.length - 1]).toBe("single.txt");
  });
});

describe("small helpers", () => {
  it("isInternalVfsPath", () => {
    expect(isInternalVfsPath("/.nodepod")).toBe(true);
    expect(isInternalVfsPath("/.nodepod/install/1")).toBe(true);
    expect(isInternalVfsPath(".nodepod/x")).toBe(true);
    expect(isInternalVfsPath(".nodepod")).toBe(true);
    expect(isInternalVfsPath("/.nodepodx")).toBe(false);
    expect(isInternalVfsPath(".nodepodx/y")).toBe(false);
    expect(isInternalVfsPath("/app/.nodepod")).toBe(false);
    expect(isInternalVfsPath("")).toBe(false);
  });

  it("LRUCache keeps recency and byte accounting", () => {
    const c = new LRUCache<string, string>(2, 100, (v) => v.length);
    c.set("a", "xx");
    c.set("b", "yyy");
    expect(c.get("a")).toBe("xx");
    c.set("c", "z");
    expect(c.has("b")).toBe(false);
    expect(c.approxBytes).toBe(3);
    c.set("a", "wwww");
    expect(c.approxBytes).toBe(5);
    expect(c.get("missing")).toBeUndefined();
  });

  it("process.nextTick passes arguments in order", async () => {
    const { createProcessObject } = await import("../polyfills/process") as any;
    if (typeof createProcessObject !== "function") return;
    const proc = createProcessObject({});
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      proc.nextTick((a: unknown, b: unknown) => seen.push(a, b), 1, 2);
      proc.nextTick(() => seen.push("none"));
      proc.nextTick(resolve);
    });
    expect(seen).toEqual([1, 2, "none"]);
  });
});

describe("setEncoding streams", () => {
  it("decodes a character split across chunks", async () => {
    const { Readable } = await import("../polyfills/stream");
    const r = new (Readable as any)({ read() {} });
    r.setEncoding("utf8");
    const out: string[] = [];
    const ended = new Promise<void>((resolve) => r.on("end", resolve));
    r.on("data", (d: string) => out.push(d));
    const bytes = Buffer.from("héllo €uro");
    r.push(bytes.subarray(0, 2)); // "h" + first byte of "é"
    r.push(bytes.subarray(2, 9)); // rest of "é", "llo ", start of "€"
    r.push(bytes.subarray(9));
    r.push(null);
    await ended;
    expect(out.join("")).toBe("héllo €uro");
    expect(out.every((s) => typeof s === "string")).toBe(true);
  });

  it("flushes a truncated character before end", async () => {
    const { Readable } = await import("../polyfills/stream");
    const r = new (Readable as any)({ read() {} });
    r.setEncoding("utf8");
    const out: string[] = [];
    const ended = new Promise<void>((resolve) => r.on("end", resolve));
    r.on("data", (d: string) => out.push(d));
    r.push(Buffer.from([0x61, 0xe2, 0x82]));
    r.push(null);
    await ended;
    expect(out.join("")).toBe("a\uFFFD");
  });
});
