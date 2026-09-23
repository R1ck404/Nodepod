import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IDBSnapshotCache } from "../../persistence/idb-cache";
import type { VFSBinarySnapshot } from "../../threading/worker-protocol";

const SCHEMA = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultCacheDir(): string {
  return (
    process.env.NODEPOD_CACHE ||
    join(tmpdir(), "nodepod-snapshots")
  );
}

function entryPath(dir: string, packageJsonHash: string): string {
  const safe = createHash("sha256").update(packageJsonHash).digest("hex");
  return join(dir, `${safe}.bin`);
}

/**
 * Disk-backed snapshot cache for Node headless — same interface as IDB/OPFS.
 * Layout: `{manifestLen:u32le}{manifestJson}{dataBytes}` plus a sibling `.meta.json`.
 */
export async function openFsSnapshotCache(
  cacheDir = defaultCacheDir(),
): Promise<IDBSnapshotCache | null> {
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch {
    return null;
  }

  // Best-effort expiry sweep
  void (async () => {
    try {
      const names = await readdir(cacheDir);
      const now = Date.now();
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        try {
          const metaRaw = await readFile(join(cacheDir, name), "utf8");
          const meta = JSON.parse(metaRaw) as { createdAt?: number; schema?: number };
          if (
            meta.schema !== SCHEMA ||
            (meta.createdAt != null && now - meta.createdAt > MAX_AGE_MS)
          ) {
            const base = name.slice(0, -".meta.json".length);
            await unlink(join(cacheDir, name)).catch(() => {});
            await unlink(join(cacheDir, `${base}.bin`)).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  })();

  return {
    async get(packageJsonHash: string): Promise<VFSBinarySnapshot | null> {
      try {
        const binPath = entryPath(cacheDir, packageJsonHash);
        const metaPath = binPath.replace(/\.bin$/, ".meta.json");
        const metaRaw = await readFile(metaPath, "utf8");
        const meta = JSON.parse(metaRaw) as { createdAt?: number; schema?: number };
        if (meta.schema !== SCHEMA) return null;
        if (meta.createdAt != null && Date.now() - meta.createdAt > MAX_AGE_MS) {
          return null;
        }
        const buf = await readFile(binPath);
        if (buf.byteLength < 4) return null;
        const manifestLen = buf.readUInt32LE(0);
        const manifestBytes = buf.subarray(4, 4 + manifestLen);
        const data = buf.buffer.slice(
          buf.byteOffset + 4 + manifestLen,
          buf.byteOffset + buf.byteLength,
        );
        const manifest = JSON.parse(manifestBytes.toString("utf8"));
        return { manifest, data };
      } catch {
        return null;
      }
    },

    async set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void> {
      const binPath = entryPath(cacheDir, packageJsonHash);
      const metaPath = binPath.replace(/\.bin$/, ".meta.json");
      const manifestJson = Buffer.from(JSON.stringify(snapshot.manifest), "utf8");
      const data = Buffer.from(snapshot.data);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(manifestJson.byteLength, 0);
      await writeFile(binPath, Buffer.concat([header, manifestJson, data]));
      await writeFile(
        metaPath,
        JSON.stringify({ schema: SCHEMA, createdAt: Date.now() }),
      );
    },

    close(): void {
      /* no-op for fs cache */
    },
  };
}

export async function fsCacheStats(cacheDir = defaultCacheDir()): Promise<{
  entries: number;
  bytes: number;
}> {
  try {
    const names = await readdir(cacheDir);
    let entries = 0;
    let bytes = 0;
    for (const name of names) {
      if (!name.endsWith(".bin")) continue;
      entries++;
      try {
        const s = await stat(join(cacheDir, name));
        bytes += s.size;
      } catch {
        /* ignore */
      }
    }
    return { entries, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
