import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  readdir,
  unlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IDBSnapshotCache, PackHead } from "../../persistence/idb-cache";
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

  interface Meta {
    createdAt?: number;
    schema?: number;
    // name of the data file; each write uses a new one, so byte ranges
    // handed out for one version never read another version's bytes
    dataFile?: string;
  }
  const basePath = (hash: string) => entryPath(cacheDir, hash).replace(/\.bin$/, "");
  const dataFileOf = (hash: string, meta: Meta) =>
    meta.dataFile ?? `${basePath(hash).slice(cacheDir.length + 1)}.bin`;
  const readMeta = async (hash: string): Promise<Meta | null> => {
    try {
      const meta = JSON.parse(await readFile(`${basePath(hash)}.meta.json`, "utf8")) as Meta;
      if (meta.schema !== SCHEMA) return null;
      if (meta.createdAt != null && Date.now() - meta.createdAt > MAX_AGE_MS) return null;
      return meta;
    } catch {
      return null;
    }
  };

  // Best-effort sweep: expired entries, and data files no entry points at
  void (async () => {
    try {
      const names = await readdir(cacheDir);
      const now = Date.now();
      const referenced = new Set<string>();
      for (const name of names) {
        if (!name.endsWith(".meta.json")) continue;
        const base = name.slice(0, -".meta.json".length);
        try {
          const meta = JSON.parse(await readFile(join(cacheDir, name), "utf8")) as Meta;
          const dataFile = meta.dataFile ?? `${base}.bin`;
          if (
            meta.schema !== SCHEMA ||
            (meta.createdAt != null && now - meta.createdAt > MAX_AGE_MS)
          ) {
            await unlink(join(cacheDir, name)).catch(() => {});
            await unlink(join(cacheDir, dataFile)).catch(() => {});
          } else {
            referenced.add(dataFile);
          }
        } catch {
          /* ignore */
        }
      }
      for (const name of names) {
        if (name.endsWith(".bin") && !referenced.has(name)) {
          await unlink(join(cacheDir, name)).catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
  })();

  // where each data file's data section starts: [u32 manifestLen][manifest][data]
  const dataOffsets = new Map<string, number>();

  return {
    async getManifest(packageJsonHash: string): Promise<PackHead | null> {
      const meta = await readMeta(packageJsonHash);
      if (!meta) return null;
      const version = dataFileOf(packageJsonHash, meta);
      let handle;
      try {
        handle = await open(join(cacheDir, version), "r");
        const header = Buffer.alloc(4);
        if ((await handle.read(header, 0, 4, 0)).bytesRead < 4) return null;
        const manifestLen = header.readUInt32LE(0);
        const manifestBytes = Buffer.alloc(manifestLen);
        if ((await handle.read(manifestBytes, 0, manifestLen, 4)).bytesRead < manifestLen) return null;
        dataOffsets.set(version, 4 + manifestLen);
        return { manifest: JSON.parse(manifestBytes.toString("utf8")), version };
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },

    async readRange(
      _packageJsonHash: string,
      version: string,
      offset: number,
      length: number,
    ): Promise<Uint8Array | null> {
      let handle;
      try {
        // the version is the data file itself: gone means null, never
        // another version's bytes
        handle = await open(join(cacheDir, version), "r");
        let dataOffset = dataOffsets.get(version);
        if (dataOffset === undefined) {
          const header = Buffer.alloc(4);
          await handle.read(header, 0, 4, 0);
          dataOffset = 4 + header.readUInt32LE(0);
          dataOffsets.set(version, dataOffset);
        }
        const out = new Uint8Array(length);
        const { bytesRead } = await handle.read(out, 0, length, dataOffset + offset);
        return bytesRead === length ? out : null;
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },

    async get(packageJsonHash: string): Promise<VFSBinarySnapshot | null> {
      try {
        const meta = await readMeta(packageJsonHash);
        if (!meta) return null;
        const buf = await readFile(join(cacheDir, dataFileOf(packageJsonHash, meta)));
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
      const base = basePath(packageJsonHash);
      const previous = await readMeta(packageJsonHash);
      const dataFile = `${base.slice(cacheDir.length + 1)}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.bin`;
      const manifestJson = Buffer.from(JSON.stringify(snapshot.manifest), "utf8");
      const data = Buffer.from(snapshot.data);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(manifestJson.byteLength, 0);
      await writeFile(join(cacheDir, dataFile), Buffer.concat([header, manifestJson, data]));
      await writeFile(
        `${base}.meta.json`,
        JSON.stringify({ schema: SCHEMA, createdAt: Date.now(), dataFile }),
      );
      if (previous) {
        // may be open elsewhere (Windows); the next sweep retries
        await unlink(join(cacheDir, dataFileOf(packageJsonHash, previous))).catch(() => {});
      }
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
