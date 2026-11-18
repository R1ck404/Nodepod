import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { buildFileSystemBridge } from "../polyfills/fs";

// stdin/stdout/stderr are open in every Node process. Emscripten's NODERAWFS
// (sharp's wasm32 build) fstat's fds 0-2 while initializing and aborts on EBADF.
describe("fs.fstatSync on the standard streams", () => {
  const fs = buildFileSystemBridge(new MemoryVolume());

  it.each([0, 1, 2])("describes fd %i as a character device", (fd) => {
    const st = fs.fstatSync(fd)!;
    expect(st.isCharacterDevice()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.isFile()).toBe(false);
    expect(st.size).toBe(0);
  });

  it("honors the bigint option", () => {
    const st = fs.fstatSync(1, { bigint: true }) as unknown as { size: bigint };
    expect(typeof st.size).toBe("bigint");
  });

  it("still reports EBADF for other unopened descriptors", () => {
    expect(() => fs.fstatSync(99)).toThrow(/EBADF/);
  });

  it("works through the callback form", async () => {
    const st = await new Promise<{ isCharacterDevice(): boolean }>((resolve, reject) => {
      (fs as any).fstat(2, (err: Error | null, s: never) => (err ? reject(err) : resolve(s)));
    });
    expect(st.isCharacterDevice()).toBe(true);
  });
});
