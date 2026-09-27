import { describe, it, expect } from "vitest";
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
