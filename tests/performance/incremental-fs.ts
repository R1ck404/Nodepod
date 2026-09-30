// Bundle for Node; compare the same benchmark with the previous fs bridge
// supplied by an esbuild onLoad hook. Run each bundle in a fresh process.
import { MemoryVolume } from "../../src/memory-volume";
import { buildFileSystemBridge } from "../../src/polyfills/fs";

const samples: Array<{ ms: number; peakExternal: number; checksum: number }> = [];
const block = new Uint8Array(4096).fill(37);
for (let round = 0; round < 5; round++) {
  (globalThis as { gc?: () => void }).gc?.();
  const volume = new MemoryVolume();
  const fs = buildFileSystemBridge(volume);
  const fd = fs.openSync("/output", "w+");
  let peakExternal = 0;
  const start = performance.now();
  for (let i = 0; i < 2048; i++) {
    fs.writeSync(fd, block, 0, block.length, null);
    if ((i & 127) === 0) peakExternal = Math.max(peakExternal, process.memoryUsage().external);
  }
  fs.closeSync(fd);
  const ms = performance.now() - start;
  const bytes = volume.readFileSync("/output");
  let checksum = 0;
  for (let i = 0; i < bytes.length; i++) checksum += bytes[i];
  if (bytes.length !== 8 * 1024 * 1024 || checksum !== 37 * bytes.length) throw Error("Incorrect output");
  samples.push({ ms, peakExternal, checksum });
}
process.stdout.write(JSON.stringify({ bytes: 8 * 1024 * 1024, writes: 2048, samples }) + "\n", () => process.exit(0));
