import { ungzip } from "pako";
import { PROCESS_WORKER_BUNDLE_GZIP_BASE64 } from "virtual:process-worker-bundle";
import { openSnapshotCache } from "../persistence/idb-cache";
import { openOPFSSnapshotCache } from "../persistence/opfs-snapshot-cache";
import { createIndexedDBWorkspaceStore } from "../persistence/workspace/idb-store";
import { registerDefaultHostFactory } from "./runtime-host";
import type {
  HostWorker,
  HttpIngress,
  OpenSnapshotCacheOptions,
  RuntimeHost,
  WorkerSpec,
} from "./types";

function wrapBrowserWorker(worker: Worker, revokeUrl?: string | null): HostWorker {
  const host = worker as unknown as HostWorker;
  if (revokeUrl) host.__nodepodRevokeUrl = revokeUrl;
  return host;
}

export function createBrowserHost(): RuntimeHost {
  let externalWorkerUrl: string | null = null;
  let workerProbePromise: Promise<string | null> | null = null;
  let embeddedBlobUrl: string | null = null;

  function ensureEmbeddedProcessUrl(): string {
    if (embeddedBlobUrl) return embeddedBlobUrl;
    if (!PROCESS_WORKER_BUNDLE_GZIP_BASE64) {
      throw new Error(
        "[Nodepod] Process worker bundle is empty. Build the library or provide workerUrl.",
      );
    }
    const binary = atob(PROCESS_WORKER_BUNDLE_GZIP_BASE64);
    const compressed = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) compressed[i] = binary.charCodeAt(i);
    const source = ungzip(compressed, { to: "string" }) as string;
    const blob = new Blob([source], { type: "application/javascript" });
    embeddedBlobUrl = URL.createObjectURL(blob);
    return embeddedBlobUrl;
  }

  return {
    kind: "browser",

    canCreateWorkers(): boolean {
      return (
        typeof Worker !== "undefined" &&
        typeof Blob !== "undefined" &&
        typeof URL !== "undefined" &&
        typeof URL.createObjectURL === "function"
      );
    },

    createWorker(spec: WorkerSpec): HostWorker {
      if (typeof Worker === "undefined") {
        throw new Error("[Nodepod] Web Workers are required.");
      }

      if (spec.type === "url") {
        const w = wrapBrowserWorker(new Worker(spec.url, { name: spec.name }));
        w.__nodepodDirect = true;
        return w;
      }

      if (spec.type === "source") {
        const url = URL.createObjectURL(
          new Blob([spec.source], { type: "application/javascript" }),
        );
        return wrapBrowserWorker(new Worker(url, { name: spec.name }), url);
      }

      if (!spec.embedded && externalWorkerUrl) {
        try {
          const w = wrapBrowserWorker(
            new Worker(externalWorkerUrl, { name: spec.name }),
          );
          w.__nodepodDirect = true;
          return w;
        } catch {
          externalWorkerUrl = null;
        }
      }
      const url = ensureEmbeddedProcessUrl();
      return wrapBrowserWorker(new Worker(url, { name: spec.name }));
    },

    async probeProcessWorkerUrl(workerUrl?: string): Promise<string | null> {
      if (workerProbePromise) return workerProbePromise;
      workerProbePromise = (async () => {
        if (typeof fetch === "undefined") return null;
        let url: string | null = workerUrl ?? null;
        if (!url) {
          try {
            url = new URL("./__worker__.js", import.meta.url).href;
          } catch {
            return null;
          }
          if (!/^https?:/.test(url)) return null;
        }
        try {
          const resp = await fetch(url, { method: "HEAD" });
          if (!resp.ok) return null;
          const contentType = resp.headers.get("content-type") || "";
          if (contentType && !/javascript|ecmascript/i.test(contentType)) {
            return null;
          }
          externalWorkerUrl = url;
          return url;
        } catch {
          return null;
        }
      })();
      return workerProbePromise;
    },

    revokeObjectUrl(url: string): void {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      if (url === embeddedBlobUrl) embeddedBlobUrl = null;
    },

    disposeGlobalResources(): void {
      if (embeddedBlobUrl) {
        try {
          URL.revokeObjectURL(embeddedBlobUrl);
        } catch {
          /* ignore */
        }
        embeddedBlobUrl = null;
      }
      externalWorkerUrl = null;
      workerProbePromise = null;
    },

    async openSnapshotCache(
      opts: OpenSnapshotCacheOptions,
    ): Promise<Awaited<ReturnType<typeof openSnapshotCache>>> {
      if (opts.enableSnapshotCache === false || opts.packageStore === "memory") {
        return null;
      }
      try {
        if (opts.packageStore === "opfs") {
          const opfs = await openOPFSSnapshotCache();
          if (opfs) return opfs;
        }
        return await openSnapshotCache();
      } catch {
        return null;
      }
    },

    async openWorkspaceStore(id: string) {
      return createIndexedDBWorkspaceStore(id);
    },

    createHttpIngress(): HttpIngress {
      return { kind: "programmatic", baseUrl: null };
    },
  };
}

// Publish the browser factory on globalThis. Esbuild minify can DCE calls to
// `registerDefaultHostFactory` across chunks, but keeps this assignment —
// `getRuntimeHost()` falls back to the global hook when the factory var is unset.
(globalThis as Record<string, unknown>).__NODEPOD_CREATE_BROWSER_HOST__ =
  createBrowserHost;
registerDefaultHostFactory(createBrowserHost);
