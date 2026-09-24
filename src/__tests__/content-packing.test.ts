import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";

// deterministic text that compresses like source code
function source(seed: number, bytes: number): string {
  let out = "";
  for (let i = 0; out.length < bytes; i++) {
    out += `export function f${seed}_${i}(a, b) { return a + b * ${(seed * 31 + i) % 97}; }\n`;
  }
  return out.slice(0, bytes);
}

function volumeWithPackages() {
  const vol = new MemoryVolume();
  vol.writeFileSync("/app/node_modules/lib/package.json", JSON.stringify({ name: "lib", pad: source(9, 600) }));
  vol.writeFileSync("/app/node_modules/lib/index.js", source(1, 4000));
  vol.writeFileSync("/app/node_modules/lib/util.js", source(2, 9000));
  vol.writeFileSync("/app/node_modules/lib/tiny.js", "module.exports = 1;");
  vol.writeFileSync("/app/node_modules/lib/types.d.ts", source(3, 20000));
  vol.writeFileSync("/app/src/main.js", source(4, 5000));
  vol.enableContentPacking();
  return vol;
}

describe("content packing", () => {
  it("packs node_modules files and reads them back byte for byte", async () => {
    const vol = volumeWithPackages();
    await vol.packContentNow();
    const stats = vol.getStats();
    // index.js, util.js, types.d.ts; not package.json, the tiny file or app code
    expect(stats.packedFiles).toBe(3);
    expect(stats.packedBytes).toBe(4000 + 9000 + 20000);
    expect(stats.packedStoredBytes).toBeLessThan(stats.packedBytes / 3);

    expect(vol.statSync("/app/node_modules/lib/util.js").size).toBe(9000);
    // stat doesn't inflate
    expect(vol.getStats().packedFiles).toBe(3);

    expect(vol.readFileSync("/app/node_modules/lib/util.js", "utf8")).toBe(source(2, 9000));
    expect(vol.readFileSync("/app/node_modules/lib/index.js", "utf8")).toBe(source(1, 4000));
    expect(vol.readFileSync("/app/node_modules/lib/tiny.js", "utf8")).toBe("module.exports = 1;");
    expect(vol.readFileSync("/app/src/main.js", "utf8")).toBe(source(4, 5000));
    // read files stay unpacked
    expect(vol.getStats().packedFiles).toBe(1);
  });

  it("leaves files read since the last round unpacked", async () => {
    const vol = volumeWithPackages();
    vol.readFileSync("/app/node_modules/lib/index.js");
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(2);
    // the next round packs it: nobody read it since
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(3);
    expect(vol.readFileSync("/app/node_modules/lib/index.js", "utf8")).toBe(source(1, 4000));
  });

  it("writes, appends and truncates packed files", async () => {
    const vol = volumeWithPackages();
    await vol.packContentNow();
    vol.writeFileSync("/app/node_modules/lib/index.js", "replaced");
    expect(vol.readFileSync("/app/node_modules/lib/index.js", "utf8")).toBe("replaced");

    vol.appendFileSync("/app/node_modules/lib/util.js", "//tail");
    expect(vol.readFileSync("/app/node_modules/lib/util.js", "utf8")).toBe(source(2, 9000) + "//tail");

    vol.truncateSync("/app/node_modules/lib/types.d.ts", 10);
    expect(vol.readFileSync("/app/node_modules/lib/types.d.ts", "utf8")).toBe(source(3, 20000).slice(0, 10));
    expect(vol.statSync("/app/node_modules/lib/types.d.ts").size).toBe(10);
    expect(vol.getStats().packedFiles).toBe(0);
  });

  it("copies a packed file", async () => {
    const vol = volumeWithPackages();
    await vol.packContentNow();
    vol.copyFileSync("/app/node_modules/lib/util.js", "/app/copy.js");
    expect(vol.readFileSync("/app/copy.js", "utf8")).toBe(source(2, 9000));
  });

  it("peeks and snapshots without unpacking", async () => {
    const vol = volumeWithPackages();
    await vol.packContentNow();
    expect(new TextDecoder().decode(vol.peekFileSync("/app/node_modules/lib/types.d.ts"))).toBe(source(3, 20000));
    const snapshot = vol.toSnapshot();
    const entry = snapshot.entries.find((e) => e.path === "/app/node_modules/lib/util.js");
    expect(atob(entry!.data!)).toBe(source(2, 9000));
    const info = vol.inspectNode("/app/node_modules/lib/index.js");
    expect(info?.resident).toBe(true);
    expect(info?.size).toBe(4000);
    expect(new TextDecoder().decode(info!.content!)).toBe(source(1, 4000));
    expect(vol.getStats().packedFiles).toBe(3);
  });

  it("doesn't count bulk copies as use", async () => {
    const vol = volumeWithPackages();
    vol.peekFileSync("/app/node_modules/lib/util.js");
    vol.toSnapshot();
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(3);
  });

  it("packs big files on their own", async () => {
    const vol = new MemoryVolume();
    const big = source(7, 1_300_000);
    vol.writeFileSync("/node_modules/big/dist/huge.js", big);
    vol.writeFileSync("/node_modules/big/dist/small.js", source(8, 3000));
    vol.enableContentPacking();
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(2);
    expect(vol.statSync("/node_modules/big/dist/huge.js").size).toBe(big.length);
    expect(new TextDecoder().decode(vol.peekFileSync("/node_modules/big/dist/huge.js"))).toBe(big);
    expect(vol.readFileSync("/node_modules/big/dist/huge.js", "utf8")).toBe(big);
    expect(vol.readFileSync("/node_modules/big/dist/small.js", "utf8")).toBe(source(8, 3000));
  });

  it("shares a packed inode across hard links", async () => {
    const vol = volumeWithPackages();
    vol.linkSync("/app/node_modules/lib/util.js", "/app/node_modules/lib/alias.js");
    await vol.packContentNow();
    expect(vol.readFileSync("/app/node_modules/lib/alias.js", "utf8")).toBe(source(2, 9000));
    vol.writeFileSync("/app/node_modules/lib/util.js", "new");
    expect(vol.readFileSync("/app/node_modules/lib/alias.js", "utf8")).toBe("new");
  });

  it("reads through a file handle opened before a round", async () => {
    const vol = volumeWithPackages();
    const handle = vol.openFileHandleSync("/app/node_modules/lib/util.js");
    await vol.packContentNow(); // read since the last round: stays unpacked
    await vol.packContentNow(); // packed now, the handle is still open
    expect(handle.stat().size).toBe(9000);
    expect(new TextDecoder().decode(handle.read())).toBe(source(2, 9000));
  });

  it("leaves wasm binaries unpacked", async () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/node_modules/engine/engine.wasm", source(5, 40000));
    vol.writeFileSync("/node_modules/engine/index.js", source(6, 4000));
    vol.enableContentPacking();
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(1);
    expect(vol.readFileSync("/node_modules/engine/engine.wasm", "utf8")).toBe(source(5, 40000));
  });

  it("does nothing until enabled", async () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/node_modules/a/index.js", source(1, 5000));
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(0);
  });
});

describe("content packing of mounted packs", () => {
  it("leaves no unpacked file holding the mounted pack's buffer", async () => {
    const enc = new TextEncoder();
    const files: Array<[string, Uint8Array]> = [
      ["/node_modules/p/package.json", enc.encode(JSON.stringify({ name: "p", pad: "x".repeat(400) }))],
      ["/node_modules/p/index.js", enc.encode("export const a = 1;\n".repeat(200))],
      ["/node_modules/p/tiny.js", enc.encode("module.exports=1")],
      ["/node_modules/p/engine.wasm", new Uint8Array(3000).fill(7)],
    ];
    const total = files.reduce((n, [, b]) => n + b.byteLength, 0);
    const data = new Uint8Array(total);
    const manifest = [];
    let offset = 0;
    for (const [path, bytes] of files) {
      data.set(bytes, offset);
      manifest.push({ path, offset, length: bytes.byteLength, isDirectory: false });
      offset += bytes.byteLength;
    }
    const vol = new MemoryVolume();
    vol.mountBinarySnapshot({ manifest, data: data.buffer });
    vol.enableContentPacking();
    await vol.packContentNow();
    expect(vol.getStats().packedFiles).toBe(1);
    for (const [path, bytes] of files) {
      const read = vol.peekFileSync(path);
      expect(read).toEqual(bytes);
      if (!path.endsWith("index.js")) expect(read.buffer.byteLength).toBe(read.byteLength);
    }
  });
});
