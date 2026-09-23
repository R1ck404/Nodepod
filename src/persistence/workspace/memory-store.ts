// In-memory WorkspaceStore. Useful for tests and for handing one workspace
// between Nodepod instances on the same page; nothing survives a reload.

import type { WorkspaceBatch, WorkspaceEntry, WorkspaceManifest, WorkspaceStore } from "./types";
import { changesTree, isUnderOrAt } from "./paths";

export function createMemoryWorkspaceStore(): WorkspaceStore {
  let saved = false;
  const entries = new Map<string, WorkspaceEntry>();
  const blobs = new Map<string, Uint8Array>();

  return {
    async load(): Promise<WorkspaceManifest | null> {
      if (!saved) return null;
      return { version: 1, entries: Array.from(entries.values(), (e) => ({ ...e })) };
    },

    async readBlobs(ids: string[]): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      for (const id of ids) {
        const data = blobs.get(id);
        if (data) out.set(id, data.slice());
      }
      return out;
    },

    async commit(batch: WorkspaceBatch): Promise<void> {
      if (changesTree(batch)) saved = true;
      for (const prefix of batch.deletePrefixes) {
        for (const path of Array.from(entries.keys())) {
          if (isUnderOrAt(path, prefix)) entries.delete(path);
        }
      }
      for (const path of batch.deletePaths) entries.delete(path);
      for (const entry of batch.putEntries) entries.set(entry.path, { ...entry });
      for (const { id, data } of batch.putBlobs) blobs.set(id, data.slice());
      for (const id of batch.deleteBlobs) blobs.delete(id);
    },

    async sweep(): Promise<void> {
      const referenced = new Set<string>();
      for (const entry of entries.values()) if (entry.blob) referenced.add(entry.blob);
      for (const id of Array.from(blobs.keys())) {
        if (!referenced.has(id)) blobs.delete(id);
      }
    },

    async clear(): Promise<void> {
      saved = false;
      entries.clear();
      blobs.clear();
    },
  };
}
