// Directory-backed WorkspaceStore for Node/Bun headless.
//
// Layout: <dir>/manifest.json plus one file per blob in <dir>/blobs/.
// A commit writes new blobs first, then swaps manifest.json in with a
// rename, then deletes dropped blobs, so a crash at any point leaves a
// manifest whose blobs all exist.

import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkspaceBatch,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceStore,
} from "../../persistence/workspace/types";
import { changesTree, isUnderOrAt } from "../../persistence/workspace/paths";

const MANIFEST = "manifest.json";
const BLOB_DIR = "blobs";

function blobFile(dir: string, id: string): string {
  return join(dir, BLOB_DIR, encodeURIComponent(id));
}

// write to a temp file, flush it to disk, then rename it into place: the
// target is always either the old or the new complete file
async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

async function removeTempFiles(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    // directory doesn't exist yet
  }
}

export function createFsWorkspaceStore(dir: string): WorkspaceStore {
  // parsed manifest.json, kept to rewrite it on commit
  let entries: Map<string, WorkspaceEntry> | null = null;
  let exists = false;

  const readManifest = async (): Promise<Map<string, WorkspaceEntry>> => {
    if (entries) return entries;
    let raw: string;
    try {
      raw = await readFile(join(dir, MANIFEST), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      entries = new Map();
      exists = false;
      return entries;
    }
    let parsed: WorkspaceManifest;
    try {
      parsed = JSON.parse(raw) as WorkspaceManifest;
    } catch {
      const err = new Error(
        `[Nodepod] saved workspace at ${dir} is corrupt (manifest.json is not valid JSON); delete the directory to start over`,
      ) as Error & { code: string };
      err.code = "EWORKSPACECORRUPT";
      throw err;
    }
    entries = new Map(parsed.entries.map((e) => [e.path, e]));
    exists = true;
    return entries;
  };

  return {
    async load(): Promise<WorkspaceManifest | null> {
      entries = null;
      const current = await readManifest();
      // leftovers from a crash mid-write
      await removeTempFiles(dir);
      await removeTempFiles(join(dir, BLOB_DIR));
      if (!exists) return null;
      return { version: 1, entries: Array.from(current.values(), (e) => ({ ...e })) };
    },

    async readBlobs(ids: string[]): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      await Promise.all(ids.map(async (id) => {
        try {
          const buf = await readFile(blobFile(dir, id));
          out.set(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        } catch { /* missing blob */ }
      }));
      return out;
    },

    async commit(batch: WorkspaceBatch): Promise<void> {
      const current = await readManifest();
      await mkdir(join(dir, BLOB_DIR), { recursive: true });
      for (const { id, data } of batch.putBlobs) {
        await writeAtomic(blobFile(dir, id), data);
      }

      const next = new Map(current);
      for (const prefix of batch.deletePrefixes) {
        for (const path of Array.from(next.keys())) {
          if (isUnderOrAt(path, prefix)) next.delete(path);
        }
      }
      for (const path of batch.deletePaths) next.delete(path);
      for (const entry of batch.putEntries) next.set(entry.path, { ...entry });
      // blob-only batches (content sent ahead of the tree) leave the manifest
      if (changesTree(batch)) {
        const manifest: WorkspaceManifest = { version: 1, entries: Array.from(next.values()) };
        await writeAtomic(join(dir, MANIFEST), JSON.stringify(manifest));
        entries = next;
        exists = true;
      }

      for (const id of batch.deleteBlobs) {
        await unlink(blobFile(dir, id)).catch(() => {});
      }
    },

    async sweep(): Promise<void> {
      const current = await readManifest();
      const referenced = new Set<string>();
      for (const entry of current.values()) if (entry.blob) referenced.add(encodeURIComponent(entry.blob));
      let names: string[];
      try {
        names = await readdir(join(dir, BLOB_DIR));
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".tmp") && !referenced.has(name)) {
          await unlink(join(dir, BLOB_DIR, name)).catch(() => {});
        }
      }
    },

    async clear(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
      entries = new Map();
      exists = false;
    },
  };
}
