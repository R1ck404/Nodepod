import { describe, it, expect, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { buildFileSystemBridge } from "../polyfills/fs";

describe("fs.openSync numeric flags", () => {
  const O_WRONLY = 1;
  const O_CREAT = 64;
  const O_TRUNC = 512;
  const O_RDONLY = 0;
  const O_APPEND = 1024;

  it("creates and writes with O_WRONLY | O_CREAT | O_TRUNC", () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/new.txt", O_WRONLY | O_CREAT | O_TRUNC);
    fs.writeSync(fd, Buffer.from("hello"));
    fs.closeSync(fd);
    expect(vol.readFileSync("/new.txt", "utf8")).toBe("hello");
  });

  it("throws ENOENT for O_RDONLY on missing file", () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    expect(() => fs.openSync("/missing.txt", O_RDONLY)).toThrow(/ENOENT/);
  });

  it("opens for append with cursor at end", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/log.txt", "ab");
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/log.txt", O_APPEND | O_WRONLY);
    fs.writeSync(fd, Buffer.from("c"));
    fs.closeSync(fd);
    expect(vol.readFileSync("/log.txt", "utf8")).toBe("abc");
  });

  it("string flag w still works", () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/s.txt", "w");
    fs.writeSync(fd, Buffer.from("ok"));
    fs.closeSync(fd);
    expect(vol.readFileSync("/s.txt", "utf8")).toBe("ok");
  });
});

// modern-tar (create-astro's template extraction) opens with O_CREAT|O_EXCL,
// writes, then futimes before close: the file isn't in the volume until close
describe("fs.futimes on a newly created fd", () => {
  const CREATE = 1 | 64 | 512 | 128 | 131072; // O_WRONLY|O_CREAT|O_TRUNC|O_EXCL|O_NOFOLLOW
  const mtime = new Date("2020-01-02T03:04:05Z");

  it("sets the times and keeps them across close", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/new.txt", CREATE, 0o644);
    fs.writeSync(fd, Buffer.from("hello"));
    const cbFs = fs as unknown as {
      futimes(fd: number, a: Date, m: Date, cb: (err: Error | null) => void): void;
    };
    await new Promise<void>((resolve, reject) =>
      cbFs.futimes(fd, mtime, mtime, (err) => (err ? reject(err) : resolve())),
    );
    fs.closeSync(fd);
    expect(vol.readFileSync("/new.txt", "utf8")).toBe("hello");
    expect(vol.statSync("/new.txt").mtimeMs).toBe(mtime.getTime());
    expect(vol.statSync("/new.txt").mode & 0o777).toBe(0o644);
  });

  it("works on an empty file (futimesSync, FileHandle.utimes)", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/empty", CREATE);
    fs.futimesSync(fd, mtime, mtime);
    fs.closeSync(fd);
    expect(vol.statSync("/empty").mtimeMs).toBe(mtime.getTime());

    type Handle = { utimes(a: Date, m: Date): Promise<void>; close(): Promise<void> };
    const promises = fs.promises as unknown as { open(p: string, f: string): Promise<Handle> };
    const fh = await promises.open("/h.txt", "wx");
    await fh.utimes(mtime, mtime);
    await fh.close();
    expect(vol.statSync("/h.txt").mtimeMs).toBe(mtime.getTime());
  });

  it("still reports EBADF for an unknown fd", () => {
    const fs = buildFileSystemBridge(new MemoryVolume());
    expect(() => fs.futimesSync(999, mtime, mtime)).toThrow(/EBADF/);
  });
});

describe("fs.rmSync", () => {
  it("recursively removes a populated Vite optimizer directory", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/project/node_modules/.vite/deps_temp_123/chunks", { recursive: true });
    vol.writeFileSync("/project/node_modules/.vite/deps_temp_123/package.json", "{}");
    vol.writeFileSync("/project/node_modules/.vite/deps_temp_123/chunks/react.js", "export {};");
    const fs = buildFileSystemBridge(vol);

    fs.rmSync("/project/node_modules/.vite/deps_temp_123", { recursive: true, force: true });

    expect(vol.existsSync("/project/node_modules/.vite/deps_temp_123")).toBe(false);
  });
});

describe("fs.WriteStream", () => {
  it.each(["a", "a+", 1025, 1026])("appends despite an explicit start with flags %s", async (flags) => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/append", "abc");
    const fs = buildFileSystemBridge(vol);
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = new fs.WriteStream("/append", { flags, start: 0 });
        stream.on("error", reject);
        stream.on("close", resolve);
        stream.end("XY");
      });
      expect(vol.readFileSync("/append", "utf8")).toBe("abcXY");
      const fd = fs.openSync("/append", flags);
      fs.writeSync(fd, Buffer.from("!"), 0, 1, 0);
      fs.closeSync(fd);
      expect(vol.readFileSync("/append", "utf8")).toBe("abcXY!");
    } finally {
      vol.dispose();
    }
  });

  it("defers write callbacks and propagates callback exceptions without calling twice", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const microtasks: Array<() => void> = [];
    const scheduled = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(callback => { microtasks.push(callback); });
    const stream = fs.createWriteStream("/callback");
    const calls: Array<Error | null | undefined> = [];
    const fault = new Error("callback failure");
    try {
      microtasks.shift()!(); // Open the descriptor before the write.
      stream.write("x", (error?: Error | null) => { calls.push(error); throw fault; });
      expect(calls).toEqual([]);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls).toEqual([null]);
      expect(microtasks).toHaveLength(1);
      expect(microtasks.shift()!).toThrow(fault);
      expect(calls).toHaveLength(1);
    } finally {
      scheduled.mockRestore();
      stream.destroy();
      vol.dispose();
    }
  });
  it("flushes nested corks and the encoded final chunk before finish", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream("/corked");
      stream.on("error", reject);
      stream.cork();
      stream.cork();
      stream.write("first ");
      stream.end("776f726c64", "hex", resolve);
    });
    expect(vol.readFileSync("/corked", "utf8")).toBe("first world");
  });

  it("keeps autoClose:false open after finish but closes it explicitly", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const stream = new (fs as any).WriteStream("/manual", { autoClose: false });
    stream.on("error", (err: Error) => { throw err; });
    await new Promise<void>(resolve => stream.end("hello", resolve));
    const fd = stream.fd;
    expect(stream.closed).toBe(false);
    expect(vol.readFileSync("/manual", "utf8")).toBe("hello");
    await new Promise<void>(resolve => stream.close(resolve));
    expect(stream.closed).toBe(true);
    expect(stream.fd).toBe(null);
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
  });

  it("waits for open and persists bytes before finish observers rename the file", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream("/pack.tmp");
      stream.on("error", reject);
      stream.on("open", () => events.push("open"));
      stream.on("finish", () => {
        events.push("finish");
        fs.renameSync("/pack.tmp", "/pack");
        expect(vol.readFileSync("/pack", "utf8")).toBe("hello world");
      });
      stream.on("close", () => { events.push("close"); resolve(); });
      stream.write(Buffer.from("hello"));
      stream.end(Buffer.from(" world"));
      expect(events).toEqual([]);
    });
    expect(events).toEqual(["open", "finish", "close"]);
  });

  it("copies each completed write and honors append and start without retaining chunks", async () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/out", "abc");
    const fs = buildFileSystemBridge(vol);
    for (const options of [{ flags: "a" }, { flags: "r+", start: 1 }]) {
      await new Promise<void>((resolve, reject) => {
        const stream = new (fs as any).WriteStream("/out", options);
        stream.on("error", reject);
        stream.on("open", () => {
          const data = Buffer.from("XY");
          stream.write(data, () => {
            data.fill(90);
            stream.end(resolve);
          });
        });
      });
    }
    expect(vol.readFileSync("/out", "utf8")).toBe("aXYXY");
  });
  it("persists flushed chunks after close (no wipe)", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    await new Promise<void>((resolve, reject) => {
      const stream = new (fs as any).WriteStream("/out.txt");
      stream.on("error", reject);
      stream.on("open", () => {
        stream.write(Buffer.from("hello"));
        stream.end(Buffer.from(" world"), () => resolve());
      });
    });
    expect(vol.readFileSync("/out.txt", "utf8")).toBe("hello world");
  });
});

describe("incremental FD capacity", () => {
  it("keeps logical EOF, sparse zeroes and truncate semantics through growth", async () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/growing", "w+");
    for (let i = 0; i < 100; i++) fs.writeSync(fd, Buffer.from([i]));
    fs.fsyncSync(fd);
    expect(vol.statSync("/growing").size).toBe(100);
    expect(Array.from(vol.readFileSync("/growing"))).toEqual(Array.from({length:100}, (_,i)=>i));
    fs.ftruncateSync(fd, 3);
    fs.writeSync(fd, Buffer.from([255]), 0, 1, 7);
    fs.closeSync(fd);
    expect(Array.from(vol.readFileSync("/growing"))).toEqual([0,1,2,0,0,0,0,255]);
  });
});

describe("fs fidelity (flags, excl, fsync, access, symlink, Dirent)", () => {
  const O_WRONLY = 1;
  const O_CREAT = 64;
  const O_EXCL = 128;
  const O_TRUNC = 512;

  it("O_WRONLY without O_TRUNC preserves existing content", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/keep.txt", "abcdef");
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/keep.txt", O_WRONLY | O_CREAT);
    fs.writeSync(fd, Buffer.from("XY"), 0, 2, 0);
    fs.closeSync(fd);
    expect(vol.readFileSync("/keep.txt", "utf8")).toBe("XYcdef");
  });

  it("wx and O_EXCL throw EEXIST when file exists", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/x.txt", "1");
    const fs = buildFileSystemBridge(vol);
    expect(() => fs.openSync("/x.txt", "wx")).toThrow(/EEXIST/);
    expect(() => fs.openSync("/x.txt", O_WRONLY | O_CREAT | O_EXCL | O_TRUNC)).toThrow(/EEXIST/);
  });

  it("fsync persists FileHandle / FD writes before close", () => {
    const vol = new MemoryVolume();
    const fs = buildFileSystemBridge(vol);
    const fd = fs.openSync("/sync.txt", "w");
    fs.writeSync(fd, Buffer.from("visible"));
    expect(vol.existsSync("/sync.txt")).toBe(false);
    fs.fsyncSync(fd);
    expect(vol.readFileSync("/sync.txt", "utf8")).toBe("visible");
    fs.closeSync(fd);
  });

  it("COPYFILE_EXCL fails when dest exists", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/a", "a");
    vol.writeFileSync("/b", "b");
    const fs = buildFileSystemBridge(vol);
    expect(() => fs.copyFileSync("/a", "/b", fs.constants.COPYFILE_EXCL)).toThrow(/EEXIST/);
  });

  it("access checks R_OK / W_OK against mode bits", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/ro.txt", "x");
    vol.chmodSync("/ro.txt", 0o400);
    const fs = buildFileSystemBridge(vol);
    fs.accessSync("/ro.txt", fs.constants.R_OK);
    expect(() => fs.accessSync("/ro.txt", fs.constants.W_OK)).toThrow(/EACCES/);
  });

  it("symlink keeps relative targets; Dirent reports symlinks", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/target.txt", "t");
    const fs = buildFileSystemBridge(vol);
    fs.symlinkSync("target.txt", "/link.txt");
    expect(fs.readlinkSync("/link.txt")).toBe("target.txt");
    const entries = fs.readdirSync("/", { withFileTypes: true }) as Array<{
      name: string;
      isSymbolicLink: () => boolean;
      isFile: () => boolean;
    }>;
    const link = entries.find((e) => e.name === "link.txt")!;
    expect(link.isSymbolicLink()).toBe(true);
    expect(link.isFile()).toBe(false);
  });
});
