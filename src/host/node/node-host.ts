import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ungzip } from "pako";
import { PROCESS_WORKER_BUNDLE_GZIP_BASE64 } from "virtual:process-worker-bundle";
import type {
  HostWorker,
  HttpIngress,
  OpenSnapshotCacheOptions,
  RuntimeHost,
  WorkerSpec,
} from "../types";
import { spawnNodeEvalWorker } from "./node-worker-adapter";
import { createLocalHttpIngress } from "./local-http-ingress";
import { openFsSnapshotCache, defaultCacheDir } from "./fs-snapshot-cache";
import { createFsWorkspaceStore } from "./fs-workspace-store";

export interface NodeHostOptions {
  /** Absolute path to dist/__worker__.js (or equivalent IIFE bundle). */
  workerPath?: string;
  /** Directory for package snapshot cache. Defaults to NODEPOD_CACHE / os.tmpdir(). */
  cacheDir?: string;
  /** Local HTTP bind host. Default 127.0.0.1 */
  httpHost?: string;
  /** Local HTTP bind port (0 = ephemeral). Default 0 */
  httpPort?: number;
}

function resolveDefaultWorkerPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/host/node/node-host.mjs → dist/__worker__.js
    // or src/host/node during vitest → walk up to package dist
    const candidates = [
      join(here, "..", "..", "__worker__.js"),
      join(here, "..", "..", "..", "dist", "__worker__.js"),
      join(process.cwd(), "dist", "__worker__.js"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadEmbeddedProcessSource(): string {
  if (!PROCESS_WORKER_BUNDLE_GZIP_BASE64) {
    throw new Error(
      "[Nodepod] Process worker bundle is empty. Build the library (`pnpm build:lib`) or pass workerPath to createNodeHost().",
    );
  }
  const binary = Buffer.from(PROCESS_WORKER_BUNDLE_GZIP_BASE64, "base64");
  return ungzip(binary, { to: "string" }) as string;
}

function loadProcessSource(workerPath: string | null, embedded: boolean): string {
  if (!embedded && workerPath && existsSync(workerPath)) {
    return readFileSync(workerPath, "utf8");
  }
  if (workerPath && existsSync(workerPath)) {
    return readFileSync(workerPath, "utf8");
  }
  return loadEmbeddedProcessSource();
}

export function createNodeHost(opts: NodeHostOptions = {}): RuntimeHost {
  let workerPath = opts.workerPath ?? resolveDefaultWorkerPath();
  let cachedProcessSource: string | null = null;

  function processSource(embedded?: boolean): string {
    if (!embedded && cachedProcessSource) return cachedProcessSource;
    const source = loadProcessSource(workerPath, !!embedded);
    if (!embedded) cachedProcessSource = source;
    return source;
  }

  return {
    kind: "node",
    defaultHeadless: true,

    canCreateWorkers(): boolean {
      return true;
    },

    createWorker(spec: WorkerSpec): HostWorker {
      if (spec.type === "url") {
        // Only local file URLs / paths are supported on Node.
        let path = spec.url;
        if (path.startsWith("file:")) {
          path = fileURLToPath(path);
        }
        if (!existsSync(path)) {
          throw new Error(`[Nodepod] Node host cannot load worker URL: ${spec.url}`);
        }
        const source = readFileSync(path, "utf8");
        const w = spawnNodeEvalWorker(source, spec.name);
        w.__nodepodDirect = true;
        return w;
      }

      if (spec.type === "source") {
        return spawnNodeEvalWorker(spec.source, spec.name);
      }

      // process worker
      const source = processSource(spec.embedded);
      const w = spawnNodeEvalWorker(source, spec.name);
      if (workerPath && !spec.embedded) w.__nodepodDirect = true;
      return w;
    },

    async probeProcessWorkerUrl(workerUrl?: string): Promise<string | null> {
      if (workerUrl) {
        let path = workerUrl;
        if (path.startsWith("file:")) path = fileURLToPath(path);
        if (existsSync(path)) {
          workerPath = path;
          cachedProcessSource = null;
          return path;
        }
        return null;
      }
      const resolved = resolveDefaultWorkerPath();
      if (resolved) {
        workerPath = resolved;
        cachedProcessSource = null;
        return resolved;
      }
      return null;
    },

    disposeGlobalResources(): void {
      cachedProcessSource = null;
    },

    async openSnapshotCache(cacheOpts: OpenSnapshotCacheOptions) {
      if (
        cacheOpts.enableSnapshotCache === false ||
        cacheOpts.packageStore === "memory"
      ) {
        return null;
      }
      return openFsSnapshotCache(opts.cacheDir);
    },

    async openWorkspaceStore(id: string) {
      // hashed: any id is a safe single path segment ("..", "*", ...)
      const dir = createHash("sha256").update(id).digest("hex").slice(0, 32);
      return createFsWorkspaceStore(join(opts.cacheDir ?? defaultCacheDir(), "workspaces", dir));
    },

    createHttpIngress({ proxy, headless }): HttpIngress | null {
      if (!headless) {
        return { kind: "programmatic", baseUrl: null };
      }
      return createLocalHttpIngress({
        proxy,
        host: opts.httpHost,
        port: opts.httpPort,
      });
    },
  };
}
