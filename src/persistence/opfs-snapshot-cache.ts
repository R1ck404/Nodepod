import type { IDBSnapshotCache } from "./idb-cache";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";

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

export async function openOPFSSnapshotCache(): Promise<IDBSnapshotCache | null> {
  const storage = typeof navigator !== "undefined" ? navigator.storage as any : null;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory() as FileSystemDirectoryHandle;
    const directory = await root.getDirectoryHandle(STORE_DIR, { create: true });
    return {
      async get(key: string): Promise<VFSBinarySnapshot | null> {
        const base = encodeURIComponent(key);
        try {
          const manifestHandle = await directory.getFileHandle(`${base}.json`);
          const dataHandle = await directory.getFileHandle(`${base}.bin`);
          const manifestFile = await manifestHandle.getFile();
          const metadata = JSON.parse(await manifestFile.text());
          if (metadata?.schema !== SCHEMA || !Array.isArray(metadata.manifest)) {
            return null;
          }
          const data = await (await dataHandle.getFile()).arrayBuffer();
          if (data.byteLength !== metadata.byteLength) return null;
          return { manifest: metadata.manifest, data };
        } catch {
          return null;
        }
      },

      async set(key: string, snapshot: VFSBinarySnapshot): Promise<void> {
        const base = encodeURIComponent(key);
        try {
          await writeFile(directory, `${base}.bin`, snapshot.data);
          await writeFile(directory, `${base}.json`, JSON.stringify({
            schema: SCHEMA,
            createdAt: Date.now(),
            byteLength: snapshot.data.byteLength,
            manifest: snapshot.manifest,
          }));
        } catch {
          // optional cache; callers continue with the live volume
        }
      },

      close() {},
    };
  } catch {
    return null;
  }
}
