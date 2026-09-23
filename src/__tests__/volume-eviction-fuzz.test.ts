import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";

// Random page-ins (some overlapping), reads, writes, renames, hardlinks and
// deletes under a tiny budget. A read must return the right bytes or throw
// EAGAIN; never stale or empty bytes. A model tracks what each path holds.

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function runFuzz(seed: number) {
  const random = rng(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // one pack of 40 files, 50-400 bytes each
  const model = new Map<string, string>();
  const manifest: Array<{ path: string; offset: number; length: number }> = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < 40; i++) {
    const path = `/nm/p${i % 5}/f${i}.js`;
    const text = `file ${i} ` + "x".repeat(50 + Math.floor(random() * 350));
    const bytes = enc.encode(text);
    manifest.push({ path, offset, length: bytes.byteLength });
    parts.push(bytes);
    model.set(path, text);
    offset += bytes.byteLength;
  }
  const data = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.byteLength;
  }

  const vol = new MemoryVolume();
  vol.enableEviction(
    {
      async read(_pack, off, len) {
        // uneven latency so page-ins overlap and finish out of order
        if (random() < 0.5) await tick();
        return data.slice(off, off + len);
      },
    },
    600,
  );
  vol.mountEntries(manifest.map((e) => ({ path: e.path, kind: "file" as const, src: { pack: 0, ...e } })));

  const check = (path: string): void => {
    try {
      const got = dec.decode(vol.readFileSync(path));
      expect(got, `seed ${seed} ${path}`).toBe(model.get(path));
    } catch (e) {
      expect((e as { code?: string }).code, `seed ${seed} ${path}: ${e}`).toBe("EAGAIN");
    }
  };

  const inflight: Promise<void>[] = [];
  for (let step = 0; step < 300; step++) {
    const paths = [...model.keys()];
    if (paths.length === 0) break;
    const path = pick(paths);
    const op = random();
    if (op < 0.35) {
      // page in, then read right after, as the fs proxy and NodepodFS do
      inflight.push(vol.ensureResident(path).then(() => {
        if (model.has(path) && vol.existsSync(path)) {
          expect(dec.decode(vol.readFileSync(path)), `seed ${seed} ${path} after page-in`).toBe(model.get(path));
        }
      }));
    } else if (op < 0.55) {
      check(path);
    } else if (op < 0.65) {
      const text = `written ${step}`;
      vol.writeFileSync(path, text);
      for (const link of vol.linksOf(path)) model.set(link, text);
    } else if (op < 0.72) {
      const to = `/nm/p${Math.floor(random() * 5)}/moved${step}.js`;
      vol.renameSync(path, to);
      model.set(to, model.get(path)!);
      model.delete(path);
    } else if (op < 0.78) {
      const to = `/nm/link${step}.js`;
      vol.linkSync(path, to);
      model.set(to, model.get(path)!);
    } else if (op < 0.84) {
      vol.unlinkSync(path);
      model.delete(path);
    } else {
      await tick();
    }
  }
  await Promise.all(inflight);
  await tick();

  expect(vol.getStats().residentPackBytes).toBeLessThanOrEqual(600);
  expect(vol.getStats().pagedOutSyncMisses).toBeGreaterThanOrEqual(0);
  // everything left is still readable with its right content
  for (const path of model.keys()) {
    await vol.ensureResident(path);
    expect(dec.decode(vol.readFileSync(path)), `seed ${seed} final ${path}`).toBe(model.get(path));
  }
}

describe("eviction fuzz", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => runFuzz(seed));
  }
});
