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
