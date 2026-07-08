/**
 * Internal pod runtime paths must not surface through user-facing fs.watch.
 */

import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { isInternalVfsPath } from "../constants/internal-vfs-paths";
import { WASM_CACHE_PATH } from "../polyfills/sqlite";

describe("internal VFS paths", () => {
  it("recognizes /.nodepod runtime cache paths", () => {
    expect(isInternalVfsPath(WASM_CACHE_PATH)).toBe(true);
    expect(isInternalVfsPath(".nodepod/wa-sqlite.wasm")).toBe(true);
    expect(isInternalVfsPath("/src/main.ts")).toBe(false);
  });

  it("writeCacheSync does not fire fs.watch", () => {
    const vol = new MemoryVolume();
    const watched: string[] = [];
    vol.watch("/", { recursive: true }, (_event, path) => {
      if (path) watched.push(path.startsWith("/") ? path : `/${path}`);
    });

    vol.writeCacheSync(WASM_CACHE_PATH, new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

    expect(vol.existsSync(WASM_CACHE_PATH)).toBe(true);
    expect(watched).toEqual([]);
  });
});
