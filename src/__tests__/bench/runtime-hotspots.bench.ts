import { bench, describe } from "vitest";
import { MemoryVolume } from "../../memory-volume";

const volume = new MemoryVolume();
const paths: string[] = [];
for (let i = 0; i < 25000; i++) {
  const path = `/project/node_modules/pkg-${i % 500}/file-${i}.js`;
  volume.writeFileSync(path, "export const value = 1;");
  paths.push(path);
}
const options = { time: 1000, warmupTime: 200, iterations: 10 };
describe("runtime hotspots", () => {
  bench("100,000 nested statSync calls", () => {
    for (let i = 0; i < 100000; i++) volume.statSync(paths[(i * 97) % paths.length]);
  }, options);
  bench("100,000 nested existsSync calls", () => {
    for (let i = 0; i < 100000; i++) volume.existsSync(paths[(i * 193) % paths.length]);
  }, options);
  bench("100,000 nested kindSync calls", () => {
    for (let i = 0; i < 100000; i++) volume.kindSync(paths[(i * 193) % paths.length]);
  }, options);
});

describe("binary write notifications", () => {
  const bytes = new Uint8Array(64 * 1024).fill(171);
  for (const event of ["change", "write"] as const) {
    const target = new MemoryVolume();
    if (event === "change") target.on("change", () => {});
    else target.on("write", () => {});
    bench(`1,000 overwrites with ${event} listener`, () => {
      for (let i = 0; i < 1000; i++) target.writeFileSync(`/binary-${i}.bin`, bytes);
    }, options);
  }
});
