// Bundle with esbuild (platform=node), then run with node --expose-gc.
// Use a fresh process per case/build. Reports resident process memory separately
// from logical WASM capacity and counts unique backing buffers, not file aliases.
import { readFileSync } from "node:fs";
import { MemoryVolume } from "../../src/memory-volume";
import { VFSBridge } from "../../src/threading/vfs-bridge";
import { createFilteredBinarySnapshot } from "../../src/persistence/binary-snapshot";
import {
  compileWasmInWorker, disposeWasmCache, precompileWasm, registerCompiledModule, getCachedModule,
} from "../../src/helpers/wasm-cache";
import { installWasmMemoryClamp } from "../../src/helpers/wasm-memory-clamp";

const collect = () => {
  for (let i = 0; i < 3; i++) (globalThis as { gc?: () => void }).gc?.();
};
const memory = () => {
  collect();
  const { rss, heapUsed, arrayBuffers, external } = process.memoryUsage();
  return { rss, heapUsed, arrayBuffers, external };
};
const retained = (vol: MemoryVolume) => {
  const buffers = new Set<ArrayBufferLike>();
  const holders = new Set<object>();
  let payloadBytes = 0;
  const walk = (node: any) => {
    if (node.kind === "directory") {
      for (const child of node.children?.values() ?? []) walk(child);
    } else if (node.kind === "file") {
      const holder = node.inode ?? node;
      if (holders.has(holder)) return;
      holders.add(holder);
      if (holder.content) {
        buffers.add(holder.content.buffer);
        payloadBytes += holder.content.byteLength;
      }
      if (holder.packed) buffers.add(holder.packed.chunk.bytes.buffer);
    }
  };
  walk(vol.tree);
  return {
    buffers: buffers.size,
    backingBytes: [...buffers].reduce((n, buffer) => n + buffer.byteLength, 0),
    residentPayloadBytes: payloadBytes,
  };
};

async function snapshots() {
  const vol = new MemoryVolume();
  for (let i = 0; i < 8; i++) {
    const path = `/file-${i}`;
    vol.writeFileSync(path, new Uint8Array(512 * 1024).fill(i));
    for (let alias = 0; alias < 7; alias++) vol.linkSync(path, `${path}-alias-${alias}`);
  }
  const start = memory();
  const bridge = new VFSBridge(vol);
  const t = performance.now();
  const snapshot = bridge.createSnapshot();
  const chunks = bridge.createChunkedSnapshots();
  const persisted = createFilteredBinarySnapshot(vol, () => true);
  const elapsedMs = performance.now() - t;
  const held = memory();
  const restored = new MemoryVolume();
  for (const chunk of chunks) restored.mountBinarySnapshot(chunk);
  restored.writeFileSync("/file-0-alias-0", "changed");
  const hardlinksPreserved = restored.readFileSync("/file-0", "utf8") === "changed";
  return {
    start, held, elapsedMs, hardlinksPreserved,
    snapshotBytes: snapshot.data.byteLength,
    chunkedBytes: chunks.reduce((n, c) => n + c.data.byteLength, 0),
    persistedBytes: persisted.data.byteLength,
  };
}

function mountedCorpus() {
  const engine = new Uint8Array(readFileSync(process.argv[3]));
  const tinyCount = 16000;
  const tinyBytes = 160;
  const coldBytes = 24 * 1024 * 1024;
  const data = new Uint8Array(tinyCount * tinyBytes + coldBytes + engine.byteLength);
  const manifest: Array<{path: string; offset: number; length: number; isDirectory: boolean}> = [];
  let offset = 0;
  for (let i = 0; i < tinyCount; i++) {
    data.fill(i % 251, offset, offset + tinyBytes);
    manifest.push({ path: `/node_modules/corpus/tiny-${i}.js`, offset, length: tinyBytes, isDirectory: false });
    offset += tinyBytes;
  }
  data.fill(65, offset, offset + coldBytes);
  manifest.push({ path: "/node_modules/corpus/cold.txt", offset, length: coldBytes, isDirectory: false });
  offset += coldBytes;
  data.set(engine, offset);
  manifest.push({ path: "/node_modules/corpus/engine.wasm", offset, length: engine.byteLength, isDirectory: false });
  return MemoryVolume.fromBinarySnapshot({ manifest, data: data.buffer });
}

async function packing() {
  const vol = mountedCorpus();
  vol.enableContentPacking({ packWasm: process.argv[2] === "packing" });
  const before = { ...retained(vol), process: memory() };
  const t = performance.now();
  await vol.packContentNow();
  const packMs = performance.now() - t;
  const after = { ...retained(vol), process: memory(), stats: vol.getStats() };
  let checksum = 0;
  const readStart = performance.now();
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 16000; i++) checksum += vol.readFileSync(`/node_modules/corpus/tiny-${i}.js`)[0];
  }
  const readsMs = performance.now() - readStart;
  const wasmReadStart = performance.now();
  const engine = vol.readFileSync("/node_modules/corpus/engine.wasm");
  const engineReadMs = performance.now() - wasmReadStart;
  const engineValid = WebAssembly.validate(engine as BufferSource);
  vol.dispose();
  return { before, after, packMs, readsMs, checksum, engineReadMs, engineValid };
}

const leb = (value: number) => {
  const out: number[] = [];
  do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value);
  return out;
};
const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];
async function wasm() {
  const imported = [1, ...name("env"), ...name("memory"), 2, 3, ...leb(32), ...leb(65536)];
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, ...leb(imported.length), ...imported]);
  const module = new WebAssembly.Module(bytes); // compiled before interception, like an IDB/worker cache hit
  installWasmMemoryClamp();
  registerCompiledModule(bytes, module);
  const heap = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
  new WebAssembly.Instance(getCachedModule(bytes)!, { env: { memory: heap } });
  const cachedHeapBytes = heap.buffer.byteLength;
  const original = WebAssembly.compile;
  let compilations = 0;
  WebAssembly.compile = ((...args: Parameters<typeof WebAssembly.compile>) => {
    compilations++;
    return original(...args);
  }) as typeof WebAssembly.compile;
  const padding = 8 * 1024 * 1024;
  const header = [0, 97, 115, 109, 1, 0, 0, 0, 0, ...leb(padding + 1), 0];
  const padded = new Uint8Array(header.length + padding);
  padded.set(header);
  const start = memory();
  const t = performance.now();
  precompileWasm(padded);
  const first = compileWasmInWorker(padded);
  const second = compileWasmInWorker(padded);
  const [a, b] = await Promise.all([first, second]);
  const elapsedMs = performance.now() - t;
  WebAssembly.compile = original;
  disposeWasmCache();
  return { cachedHeapBytes, compilations, samePromise: first === second, sameModule: a === b, elapsedMs, start, held: memory() };
}

const cases = { snapshots, packing, "packing-default": packing, wasm };
const selected = process.argv[2] as keyof typeof cases;
if (!cases[selected]) throw new Error("Choose snapshots, packing or wasm; packing also needs a .wasm path");
const result = await cases[selected]();
console.log(JSON.stringify({ case: selected, ...result, peakRssKiB: process.resourceUsage().maxRSS }));
