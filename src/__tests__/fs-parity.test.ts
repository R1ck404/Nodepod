import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { buildFileSystemBridge } from "../polyfills/fs";

function makeFs() {
  const vol = new MemoryVolume();
  const fs = buildFileSystemBridge(vol);
  return { vol, fs };
}

describe("fs.statSync options", () => {
  it("returns undefined when throwIfNoEntry is false", () => {
    const { fs } = makeFs();
    expect(fs.statSync("/missing", { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync("/missing", { throwIfNoEntry: false })).toBeUndefined();
  });

  it("still throws ENOENT by default", () => {
    const { fs } = makeFs();
    expect(() => fs.statSync("/missing")).toThrow(/ENOENT/);
  });

  it("returns bigint stats when bigint is true", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/f.txt", "hi");
    const st = fs.statSync("/f.txt", { bigint: true })!;
    expect(typeof st.size).toBe("bigint");
    expect(typeof st.ino).toBe("bigint");
    expect(st.size).toBe(2n);
  });
});

describe("fs.writeFileSync options", () => {
  it("appends with flag a", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/a.txt", "ab");
    fs.writeFileSync("/a.txt", "c", { flag: "a" });
    expect(vol.readFileSync("/a.txt", "utf8")).toBe("abc");
  });

  it("throws EEXIST for wx", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/x.txt", "1");
    expect(() => fs.writeFileSync("/x.txt", "2", { flag: "wx" })).toThrow(/EEXIST/);
  });

  it("applies mode on create", () => {
    const { fs } = makeFs();
    fs.writeFileSync("/m.txt", "x", { mode: 0o600 });
    expect(fs.statSync("/m.txt")!.mode & 0o777).toBe(0o600);
  });
});

describe("fs.createReadStream", () => {
  it("respects start/end range", async () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/r.txt", "0123456789");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream("/r.txt", { start: 2, end: 5 });
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe("2345");
  });

  it("chunks under small highWaterMark", async () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/big.txt", "abcdefghij");
    const sizes: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream("/big.txt", { highWaterMark: 3 });
      stream.on("data", (c: Buffer) => sizes.push(c.length));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe("fs.openSync flags", () => {
  const O_RDONLY = 0;
  const O_DIRECTORY = 65536;
  const O_NOFOLLOW = 131072;
  const O_WRONLY = 1;
  const O_CREAT = 64;

  it("opens directories with O_DIRECTORY", () => {
    const { vol, fs } = makeFs();
    vol.mkdirSync("/d");
    const fd = fs.openSync("/d", O_RDONLY | O_DIRECTORY);
    expect(fd).toBeGreaterThan(0);
    fs.closeSync(fd);
  });

  it("throws ENOTDIR when O_DIRECTORY on a file", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/f", "x");
    expect(() => fs.openSync("/f", O_RDONLY | O_DIRECTORY)).toThrow(/ENOTDIR/);
  });

  it("throws ELOOP with O_NOFOLLOW on symlink", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/t", "x");
    vol.symlinkSync("/t", "/l");
    expect(() => fs.openSync("/l", O_RDONLY | O_NOFOLLOW)).toThrow(/ELOOP/);
  });

  it("applies create mode", () => {
    const { fs } = makeFs();
    const fd = fs.openSync("/n.txt", O_WRONLY | O_CREAT, 0o640);
    fs.writeSync(fd, Buffer.from("ok"));
    fs.closeSync(fd);
    expect(fs.statSync("/n.txt")!.mode & 0o777).toBe(0o640);
  });
});

describe("fs encodings", () => {
  it("readFileSync decodes base64 and hex", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/b.txt", "hi");
    expect(fs.readFileSync("/b.txt", "base64")).toBe(Buffer.from("hi").toString("base64"));
    expect(fs.readFileSync("/b.txt", "hex")).toBe(Buffer.from("hi").toString("hex"));
  });

  it("readdirSync encoding buffer returns Buffers", () => {
    const { vol, fs } = makeFs();
    vol.mkdirSync("/dir");
    vol.writeFileSync("/dir/a", "1");
    const names = fs.readdirSync("/dir", { encoding: "buffer" }) as Array<Uint8Array>;
    expect(names[0]).toBeInstanceOf(Uint8Array);
    expect(typeof (names[0] as any).toString).toBe("function");
    expect(names.map((n) => n.toString())).toContain("a");
  });
});

describe("fs.mkdirSync return path", () => {
  it("returns first created path when recursive", () => {
    const { fs } = makeFs();
    const created = fs.mkdirSync("/a/b/c", { recursive: true });
    expect(created).toBe("/a");
    expect(fs.mkdirSync("/a/b/c", { recursive: true })).toBeUndefined();
  });
});

describe("fs.cpSync", () => {
  it("copies symlinks without dereferencing", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/target", "data");
    vol.symlinkSync("/target", "/link");
    fs.cpSync("/link", "/copy");
    expect(vol.lstatSync("/copy").isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync("/copy")).toBe("/target");
  });

  it("honors filter", () => {
    const { vol, fs } = makeFs();
    vol.mkdirSync("/src", { recursive: true });
    vol.writeFileSync("/src/keep.txt", "1");
    vol.writeFileSync("/src/skip.txt", "2");
    fs.cpSync("/src", "/dst", {
      recursive: true,
      filter: (src) => !src.endsWith("skip.txt"),
    });
    expect(vol.existsSync("/dst/keep.txt")).toBe(true);
    expect(vol.existsSync("/dst/skip.txt")).toBe(false);
  });

  it("preserveTimestamps copies mtime", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/t.txt", "x");
    const past = new Date("2020-01-01T00:00:00Z");
    vol.utimesSync("/t.txt", past, past);
    fs.cpSync("/t.txt", "/u.txt", { preserveTimestamps: true });
    expect(vol.statSync("/u.txt").mtimeMs).toBe(past.getTime());
  });
});

describe("fs.globSync", () => {
  it("supports character classes and withFileTypes", () => {
    const { vol, fs } = makeFs();
    vol.mkdirSync("/g", { recursive: true });
    vol.writeFileSync("/g/a.js", "");
    vol.writeFileSync("/g/b.ts", "");
    vol.writeFileSync("/g/c.txt", "");
    const matched = fs.globSync("*.[jt]s", { cwd: "/g" }) as string[];
    expect(matched.sort()).toEqual(["a.js", "b.ts"]);
    const dirents = fs.globSync("*.txt", { cwd: "/g", withFileTypes: true }) as Array<{ name: string }>;
    expect(dirents[0].name).toBe("c.txt");
  });
});

describe("fs ownership and symlink metadata", () => {
  it("fchmod and chown reflect in stat", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/o.txt", "x");
    const fd = fs.openSync("/o.txt", "r+");
    fs.fchmodSync(fd, 0o600);
    fs.fchownSync(fd, 42, 43);
    fs.closeSync(fd);
    const st = fs.statSync("/o.txt")!;
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(42);
    expect(st.gid).toBe(43);
  });

  it("lutimes updates symlink times without following", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/tgt", "x");
    vol.symlinkSync("/tgt", "/sl");
    const t = new Date("2021-06-01T00:00:00Z");
    fs.lutimesSync("/sl", t, t);
    expect(vol.lstatSync("/sl").mtimeMs).toBe(t.getTime());
  });

  it("lchmod updates symlink mode", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/tgt2", "x");
    vol.symlinkSync("/tgt2", "/sl2");
    fs.lchmodSync("/sl2", 0o755);
    expect(vol.lstatSync("/sl2").mode & 0o777).toBe(0o755);
  });
});

describe("fs.watchFile", () => {
  let fsRef: ReturnType<typeof makeFs>["fs"] | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    try {
      fsRef?.unwatchFile("/w.txt");
    } catch {
      /* ignore */
    }
    fsRef = null;
    vi.useRealTimers();
  });

  it("fires on change and unwatchFile stops", async () => {
    const { vol, fs } = makeFs();
    fsRef = fs;
    vol.writeFileSync("/w.txt", "1");
    const listener = vi.fn();
    fs.watchFile("/w.txt", { interval: 100 }, listener);
    vol.writeFileSync("/w.txt", "22");
    await vi.advanceTimersByTimeAsync(150);
    expect(listener).toHaveBeenCalled();
    fs.unwatchFile("/w.txt", listener);
    listener.mockClear();
    vol.writeFileSync("/w.txt", "333");
    await vi.advanceTimersByTimeAsync(200);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("fs.readdir callback deferral", () => {
  // Metro's node crawler increments activeCalls around readdir+lstat and
  // completes early if readdir invokes its callback synchronously.
  it("invokes callback asynchronously", async () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/a.js", "1");
    let sawSync = true;
    const done = new Promise<void>((resolve, reject) => {
      fs.readdir("/", { withFileTypes: true }, (err, entries) => {
        try {
          expect(err).toBeNull();
          expect(sawSync).toBe(false);
          expect(entries!.map((e: any) => e.name)).toContain("a.js");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    sawSync = false;
    await done;
  });
});

describe("fs.promises.constants and rm retries", () => {
  it("exposes promises.constants", () => {
    const { fs } = makeFs();
    expect(fs.promises.constants.O_RDWR).toBe(fs.constants.O_RDWR);
  });

  it("rmSync accepts maxRetries", () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/z.txt", "x");
    expect(() =>
      fs.rmSync("/z.txt", { maxRetries: 2, retryDelay: 1 }),
    ).not.toThrow();
    expect(vol.existsSync("/z.txt")).toBe(false);
  });
});

describe("memory-volume ownership helpers", () => {
  it("chown/lchown/lutimes/mkdir mode+return", () => {
    const vol = new MemoryVolume();
    const first = vol.mkdirSync("/p/q", { recursive: true, mode: 0o700 });
    expect(first).toBe("/p");
    expect(vol.statSync("/p").mode & 0o777).toBe(0o700);

    vol.writeFileSync("/p/f", "x");
    vol.chownSync("/p/f", 7, 8);
    expect(vol.statSync("/p/f").uid).toBe(7);
    expect(vol.statSync("/p/f").gid).toBe(8);

    vol.symlinkSync("/p/f", "/p/l");
    vol.lchownSync("/p/l", 9, 10);
    expect(vol.lstatSync("/p/l").uid).toBe(9);
    const t = new Date("2019-01-01T00:00:00Z");
    vol.lutimesSync("/p/l", t, t);
    expect(vol.lstatSync("/p/l").mtimeMs).toBe(t.getTime());
    vol.lchmodSync("/p/l", 0o777);
    expect(vol.lstatSync("/p/l").mode & 0o777).toBe(0o777);
  });
});

describe("fs callback scheduling", () => {
  it("runs each callback in its own task, like node's I/O callbacks", async () => {
    const { vol, fs } = makeFs();
    vol.writeFileSync("/a.txt", "a");
    vol.writeFileSync("/b.txt", "b");
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      fs.readFile("/a.txt", { encoding: "utf8" }, (_err: unknown, data?: string) => {
        order.push("cb:" + data);
        void Promise.resolve().then(() => order.push("microtask after a"));
      });
      fs.readFile("/b.txt", { encoding: "utf8" }, (_err: unknown, data?: string) => {
        order.push("cb:" + data);
        resolve();
      });
      order.push("sync");
    });
    expect(order).toEqual(["sync", "cb:a", "microtask after a", "cb:b"]);
  });

  it("keeps callback errors reportable", async () => {
    const { fs } = makeFs();
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => fs.readFile("/missing", (e: NodeJS.ErrnoException | null) => resolve(e)));
    expect(err?.code).toBe("ENOENT");
  });
});
