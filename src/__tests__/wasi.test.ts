import { describe, expect, it } from "vitest";
import { WASI as NodeWASI } from "node:wasi";
import { MemoryVolume } from "../memory-volume";
import { getWasiRuntimeSource, WASI } from "../polyfills/wasi";

function instance(memory: WebAssembly.Memory, exports: Record<string, unknown> = {}): WebAssembly.Instance {
  return { exports: { memory, ...exports } } as unknown as WebAssembly.Instance;
}

describe("node:wasi compatibility", () => {
  it("matches Node for stable errno and clock probes", () => {
    const moduleBytes = Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 4, 1, 96, 0, 0,
      3, 2, 1, 0,
      5, 3, 1, 0, 1,
      7, 24, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0,
      11, 95, 105, 110, 105, 116, 105, 97, 108, 105, 122, 101, 0, 0,
      10, 4, 1, 2, 0, 11,
    ]);
    const nodeInstance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes));
    const node = new NodeWASI({ version: "preview1", returnOnExit: true });
    node.initialize(nodeInstance);
    const nodeImport = node.wasiImport as Record<string, Function>;
    const nodeMemory = nodeInstance.exports.memory as WebAssembly.Memory;

    const ours = new WASI({ version: "preview1" });
    const ourMemory = new WebAssembly.Memory({ initial: 1 });
    ours.finalizeBindings(instance(ourMemory));
    const probes = (imports: Record<string, Function>, memory: WebAssembly.Memory) => {
      const view = new DataView(memory.buffer);
      const result = [
        imports.clock_res_get(0, 0),
        imports.fd_close(99),
        imports.poll_oneoff(0, 64, 0, 32),
        imports.proc_raise(1),
        imports.random_get(memory.buffer.byteLength - 2, 4),
      ];
      return { result, resolution: view.getBigUint64(0, true) };
    };
    expect(probes(ours.wasiImport, ourMemory)).toEqual(probes(nodeImport, nodeMemory));
  });

  it("requires an explicit supported version", () => {
    expect(() => new (WASI as any)()).toThrow(/options\.version/);
    expect(() => new (WASI as any)({})).toThrow(/options\.version/);
    expect(() => new (WASI as any)({ version: "preview2" })).toThrow(/unsupported WASI version/);
  });

  it("returns the import namespace selected by version", () => {
    expect(Object.keys(new WASI({ version: "preview1" }).getImportObject())).toEqual([
      "wasi_snapshot_preview1",
    ]);
    expect(Object.keys(new WASI({ version: "unstable" }).getImportObject())).toEqual([
      "wasi_unstable",
    ]);
  });

  it("defaults returnOnExit to true and enforces single use", () => {
    const wasi = new WASI({ version: "preview1" });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const command = instance(memory, {
      _start: () => wasi.wasiImport.proc_exit(7),
    });
    expect(wasi.start(command)).toBe(7);
    expect(() => wasi.start(command)).toThrow(/already been started/);
  });

  it("validates command and reactor exports", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() => new WASI({ version: "preview1" }).start(instance(memory, {
      _start: () => undefined,
      _initialize: () => undefined,
    }))).toThrow(/both _start and _initialize/);
    expect(() => new WASI({ version: "preview1" }).initialize(instance(memory, {
      _start: () => undefined,
    }))).toThrow(/command module/);
  });

  it("supports finalizeBindings with imported memory", () => {
    const wasi = new WASI({ version: "preview1" });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings(instance(memory), { memory });
    expect(wasi.wasiImport.clock_time_get(1, 0n, 0)).toBe(0);
    expect(() => wasi.finalizeBindings(instance(memory), { memory })).toThrow(/already been started/);
  });

  it("reports monotonic time in nanoseconds", () => {
    const wasi = new WASI({ version: "preview1" });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings(instance(memory));
    expect(wasi.wasiImport.clock_time_get(1, 0n, 0)).toBe(0);
    const value = new DataView(memory.buffer).getBigUint64(0, true);
    const expected = BigInt(Math.floor(performance.now() * 1e6));
    expect(value).toBeGreaterThan(0n);
    expect(value > expected ? value - expected : expected - value).toBeLessThan(50_000_000n);
    expect(wasi.wasiImport.clock_res_get(0, 8)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(8, true)).toBe(1n);
    expect(wasi.wasiImport.clock_res_get(2, 16)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(16, true)).toBe(100n);
  });

  it("fills random buffers larger than the Web Crypto per-call limit", () => {
    const wasi = new WASI({ version: "preview1" });
    const memory = new WebAssembly.Memory({ initial: 2 });
    wasi.finalizeBindings(instance(memory));
    expect(wasi.wasiImport.random_get(0, 70_000)).toBe(0);
    const bytes = new Uint8Array(memory.buffer, 0, 70_000);
    expect(bytes.some((value) => value !== 0)).toBe(true);
    expect(wasi.wasiImport.random_get(memory.buffer.byteLength - 4, 8)).toBe(61);
  });

  it("rejects paths escaping a preopen capability", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    const wasi = new WASI({
      version: "preview1",
      preopens: { "/": "/sandbox" },
      fs: volume as any,
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings(instance(memory));
    new Uint8Array(memory.buffer).set(new TextEncoder().encode("../secret"), 64);
    expect(wasi.wasiImport.path_filestat_get(3, 0, 64, 9, 128)).toBe(76);
  });

  it("rejects symlinks escaping a preopen capability", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/secret", "secret");
    volume.symlinkSync("../secret", "/sandbox/escape");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings(instance(memory));
    new Uint8Array(memory.buffer).set(new TextEncoder().encode("escape"), 64);
    expect(wasi.wasiImport.path_filestat_get(3, 1, 64, 6, 128)).toBe(76);
  });

  it("keeps descriptors coherent and enforces reduced rights", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/sandbox/file", "old");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    wasi.finalizeBindings(instance(memory));
    bytes.set(new TextEncoder().encode("file"), 64);
    const rights = 2n | 4n | 32n | 64n | 256n;
    expect(wasi.wasiImport.path_open(3, 0, 64, 4, 0, rights, 0n, 0, 100)).toBe(0);
    expect(wasi.wasiImport.path_open(3, 0, 64, 4, 0, rights, 0n, 0, 104)).toBe(0);
    const first = view.getUint32(100, true);
    const second = view.getUint32(104, true);
    bytes.set(new TextEncoder().encode("new"), 300);
    view.setUint32(200, 300, true);
    view.setUint32(204, 3, true);
    expect(wasi.wasiImport.fd_write(first, 200, 1, 220)).toBe(0);
    view.setUint32(200, 320, true);
    view.setUint32(204, 3, true);
    expect(wasi.wasiImport.fd_read(second, 200, 1, 224)).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(320, 323))).toBe("new");
    expect(wasi.wasiImport.fd_fdstat_set_rights(first, 2n, 0n)).toBe(0);
    expect(wasi.wasiImport.fd_write(first, 200, 1, 220)).toBe(76);
    expect(wasi.wasiImport.fd_allocate(first, 0n, 10n)).toBe(76);
  });

  it("includes dot entries and permits a partial final directory record", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/sandbox/file", "data");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings(instance(memory));
    expect(wasi.wasiImport.fd_readdir(3, 64, 25, 0n, 32)).toBe(0);
    const view = new DataView(memory.buffer);
    expect(view.getUint32(32, true)).toBe(25);
    expect(view.getUint32(80, true)).toBe(1);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 88, 1))).toBe(".");
  });

  it("keeps an unlinked descriptor attached to a remaining hard link", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/sandbox/original", "old");
    volume.linkSync("/sandbox/original", "/sandbox/linked");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    wasi.finalizeBindings(instance(memory));
    bytes.set(new TextEncoder().encode("original"), 64);
    expect(wasi.wasiImport.path_open(3, 0, 64, 8, 0, 64n, 0n, 0, 100)).toBe(0);
    const fd = view.getUint32(100, true);
    expect(wasi.wasiImport.path_unlink_file(3, 64, 8)).toBe(0);
    bytes.set(new TextEncoder().encode("new"), 300);
    view.setUint32(200, 300, true);
    view.setUint32(204, 3, true);
    expect(wasi.wasiImport.fd_write(fd, 200, 1, 220)).toBe(0);
    expect(volume.readFileSync("/sandbox/linked", "utf8")).toBe("new");
  });

  it("implements descriptor allocation, positioned I/O, flags, times, and renumbering", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/sandbox/file", "abc");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 2 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    wasi.finalizeBindings(instance(memory));
    bytes.set(new TextEncoder().encode("file"), 64);
    expect(wasi.wasiImport.path_open(3, 0, 64, 4, 0, 0x3fffffffn, 0n, 0, 100)).toBe(0);
    const fd = view.getUint32(100, true);

    expect(wasi.wasiImport.fd_allocate(fd, 8n, 4n)).toBe(0);
    expect(volume.statSync("/sandbox/file").size).toBe(12);
    bytes.set(new TextEncoder().encode("XY"), 300);
    view.setUint32(200, 300, true);
    view.setUint32(204, 2, true);
    expect(wasi.wasiImport.fd_pwrite(fd, 200, 1, 1n, 220)).toBe(0);
    expect(wasi.wasiImport.fd_pread(fd, 200, 1, 1n, 224)).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(300, 302))).toBe("XY");
    expect(wasi.wasiImport.fd_seek(fd, -2n, 2, 240)).toBe(0);
    expect(view.getBigUint64(240, true)).toBe(10n);
    expect(wasi.wasiImport.fd_tell(fd, 248)).toBe(0);
    expect(view.getBigUint64(248, true)).toBe(10n);
    expect(wasi.wasiImport.fd_fdstat_set_flags(fd, 1)).toBe(0);
    expect(wasi.wasiImport.fd_fdstat_get(fd, 260)).toBe(0);
    expect(view.getUint16(262, true)).toBe(1);
    expect(wasi.wasiImport.fd_filestat_set_times(fd, 1_000_000_000n, 2_000_000_000n, 5)).toBe(0);
    expect(volume.statSync("/sandbox/file").mtimeMs).toBe(2_000);
    expect(wasi.wasiImport.fd_renumber(fd, 50)).toBe(0);
    expect(wasi.wasiImport.fd_close(fd)).toBe(8);
    expect(wasi.wasiImport.fd_close(50)).toBe(0);
  });

  it("implements capability-scoped links, renames, symlinks, and directories", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/sandbox", { recursive: true });
    volume.writeFileSync("/sandbox/file", "data");
    const wasi = new WASI({ version: "preview1", preopens: { "/": "/sandbox" }, fs: volume as any });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    wasi.finalizeBindings(instance(memory));
    const put = (text: string, offset: number): number => {
      bytes.set(new TextEncoder().encode(text), offset);
      return text.length;
    };

    expect(wasi.wasiImport.path_link(3, 0, 64, put("file", 64), 3, 80, put("linked", 80))).toBe(0);
    expect(volume.statSync("/sandbox/file").ino).toBe(volume.statSync("/sandbox/linked").ino);
    expect(wasi.wasiImport.path_rename(3, 80, 6, 3, 96, put("moved", 96))).toBe(0);
    expect(volume.readFileSync("/sandbox/moved", "utf8")).toBe("data");
    expect(wasi.wasiImport.path_symlink(64, 4, 3, 112, put("sym", 112))).toBe(0);
    expect(wasi.wasiImport.path_readlink(3, 112, 3, 128, 16, 152)).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(128, 128 + view.getUint32(152, true)))).toBe("file");
    expect(wasi.wasiImport.path_create_directory(3, 160, put("empty", 160))).toBe(0);
    expect(wasi.wasiImport.path_remove_directory(3, 160, 5)).toBe(0);
    expect(wasi.wasiImport.path_link(3, 0, 64, 4, 3, 176, put("missing/link", 176))).toBe(44);
    expect(wasi.wasiImport.path_unlink_file(3, 96, 5)).toBe(0);
  });

  it("returns defined errors for malformed pointers and polling subscriptions", () => {
    const wasi = new WASI({ version: "preview1", args: ["x"] });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    wasi.finalizeBindings(instance(memory));
    expect(wasi.wasiImport.args_get(memory.buffer.byteLength - 2, 0)).toBe(21);
    expect(wasi.wasiImport.poll_oneoff(0, 64, 0, 32)).toBe(28);
    view.setBigUint64(0, 123n, true);
    view.setUint8(8, 99);
    expect(wasi.wasiImport.poll_oneoff(0, 64, 1, 32)).toBe(0);
    expect(view.getUint32(32, true)).toBe(1);
    expect(view.getBigUint64(64, true)).toBe(123n);
    expect(view.getUint16(72, true)).toBe(28);
  });

  it("serializes the same host implementation for nested workers", () => {
    const target: Record<string, unknown> = {};
    new Function("globalThis", getWasiRuntimeSource("runtime"))(target);
    const RuntimeWASI = (target.runtime as { WASI: typeof WASI }).WASI;
    const wasi = new RuntimeWASI({ version: "preview1" });
    const memory = new WebAssembly.Memory({ initial: 2 });
    wasi.finalizeBindings(instance(memory));
    expect(wasi.wasiImport.random_get(0, 70_000)).toBe(0);
  });

  it("survives one hundred cold and warm host lifecycles", () => {
    const target: Record<string, unknown> = {};
    new Function("globalThis", getWasiRuntimeSource("runtime"))(target);
    const RuntimeWASI = (target.runtime as { WASI: typeof WASI }).WASI;
    for (let index = 0; index < 100; index++) {
      for (const Constructor of [WASI, RuntimeWASI]) {
        const wasi = new Constructor({ version: "preview1" });
        const memory = new WebAssembly.Memory({ initial: 1 });
        wasi.finalizeBindings(instance(memory));
        expect(wasi.wasiImport.random_get(0, 1024)).toBe(0);
        expect(wasi.wasiImport.clock_time_get(1, 0n, 2048)).toBe(0);
      }
    }
  });
});
