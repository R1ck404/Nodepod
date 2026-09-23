import type { IDBSnapshotCache, PackHead } from "./idb-cache";
import type { VFSBinarySnapshot, VFSSnapshotEntry } from "../threading/worker-protocol";

const STORE_DIR = "nodepod-package-packs-v1";
const SCHEMA = 1;

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: BlobPart,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

interface PackMetadata {
  schema: number;
  byteLength: number;
  manifest: VFSSnapshotEntry[];
  // name of the data file; each write uses a new one, so byte ranges handed
  // out for one version never read another's bytes
  dataFile?: string;
}

function dataFileName(key: string, metadata: PackMetadata): string {
  return metadata.dataFile ?? `${encodeURIComponent(key)}.bin`;
}

export async function openOPFSSnapshotCache(): Promise<IDBSnapshotCache | null> {
  const storage = typeof navigator !== "undefined" ? navigator.storage as any : null;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory() as FileSystemDirectoryHandle;
    const directory = await root.getDirectoryHandle(STORE_DIR, { create: true });

    const readMetadata = async (key: string): Promise<PackMetadata | null> => {
      try {
        const handle = await directory.getFileHandle(`${encodeURIComponent(key)}.json`);
        const metadata = JSON.parse(await (await handle.getFile()).text());
        if (metadata?.schema !== SCHEMA || !Array.isArray(metadata.manifest)) return null;
        return metadata as PackMetadata;
      } catch {
        return null;
      }
    };

    // a File from getFile() is a disk-backed handle: slices read only their
    // range. versions are separate files, so a handle never changes meaning
    const dataFiles = new Map<string, File>();
    const dataFile = async (version: string): Promise<File> => {
      const known = dataFiles.get(version);
      if (known) return known;
      const file = await (await directory.getFileHandle(version)).getFile();
      dataFiles.set(version, file);
      return file;
    };

    return {
      async get(key: string): Promise<VFSBinarySnapshot | null> {
        const metadata = await readMetadata(key);
        if (!metadata) return null;
        try {
          const handle = await directory.getFileHandle(dataFileName(key, metadata));
          const data = await (await handle.getFile()).arrayBuffer();
          if (data.byteLength !== metadata.byteLength) return null;
          return { manifest: metadata.manifest, data };
        } catch {
          return null;
        }
      },

      async set(key: string, snapshot: VFSBinarySnapshot): Promise<void> {
        const base = encodeURIComponent(key);
        const previous = await readMetadata(key);
        const dataFile = `${base}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.bin`;
        try {
          await writeFile(directory, dataFile, snapshot.data);
          await writeFile(directory, `${base}.json`, JSON.stringify({
            schema: SCHEMA,
            createdAt: Date.now(),
            byteLength: snapshot.data.byteLength,
            manifest: snapshot.manifest,
            dataFile,
          }));
          if (previous) {
            await directory.removeEntry(dataFileName(key, previous)).catch(() => {});
          }
        } catch {
          // optional cache; callers continue with the live volume
        }
      },

      async getManifest(key: string): Promise<PackHead | null> {
        const metadata = await readMetadata(key);
        return metadata ? { manifest: metadata.manifest, version: dataFileName(key, metadata) } : null;
      },

      async readRange(_key: string, version: string, offset: number, length: number): Promise<Uint8Array | null> {
        try {
          const file = await dataFile(version);
          if (offset + length > file.size) return null;
          return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        } catch {
          // gone, or rewritten in place by an older writer: fail rather than
          // hand out bytes from another version
          dataFiles.delete(version);
          return null;
        }
      },

      close() {
        dataFiles.clear();
      },
    };
  } catch {
    return null;
  }
}
