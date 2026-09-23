import type { IDBSnapshotCache } from "../persistence/idb-cache";
import type { WorkspaceStore } from "../persistence/workspace/types";
import type { RequestProxy } from "../request-proxy";

/** Minimal message event shape shared by browser Workers and Node adapters. */
export interface HostMessageEvent {
  data: unknown;
}

/** Loosely typed so browser `Worker` remains assignable in tests/adapters. */
export type HostWorkerMessageHandler = (ev: any) => void;
export type HostWorkerErrorHandler = (ev: any) => void;

/**
 * Worker surface used by ProcessManager / ProcessHandle / offload.
 * Structurally compatible with browser `Worker` for the methods we call.
 */
export interface HostWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: string, listener: (...args: any[]) => void): void;
  removeEventListener(type: string, listener: (...args: any[]) => void): void;
  onmessage: HostWorkerMessageHandler | null;
  onerror: HostWorkerErrorHandler | null;
  /** Set when the worker was created from an external URL (not embedded). */
  __nodepodDirect?: boolean;
  /** Blob / object URL to revoke when the worker is disposed (browser). */
  __nodepodRevokeUrl?: string | null;
}

export type WorkerSpec =
  | { type: "process"; name?: string; /** Skip external URL; use embedded/file bundle. */ embedded?: boolean }
  | { type: "source"; source: string; name?: string }
  | { type: "url"; url: string; name?: string };

export interface HttpIngress {
  kind: "none" | "service-worker" | "local-http" | "programmatic";
  /** Public origin used for serverUrl / onServerReady, or null if none. */
  baseUrl: string | null;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface OpenSnapshotCacheOptions {
  packageStore?: "auto" | "memory" | "opfs" | string;
  enableSnapshotCache?: boolean;
}

export interface CreateHttpIngressOptions {
  proxy: RequestProxy;
  headless: boolean;
  onServerReady?: (port: number, url: string) => void;
}

export interface RuntimeHost {
  kind: "browser" | "node";
  /** When true, `Nodepod.boot()` applies headless defaults if `headless` is omitted. */
  defaultHeadless?: boolean;
  canCreateWorkers(): boolean;
  createWorker(spec: WorkerSpec): HostWorker;
  /** Probe/cache an external process-worker URL. Returns the URL if usable. */
  probeProcessWorkerUrl?(workerUrl?: string): Promise<string | null>;
  revokeObjectUrl?(url: string): void;
  disposeGlobalResources?(): void;
  openSnapshotCache?(
    opts: OpenSnapshotCacheOptions,
  ): Promise<IDBSnapshotCache | null>;
  createHttpIngress?(opts: CreateHttpIngressOptions): HttpIngress | null;
  /** Default store for `persistence` when the caller doesn't pass one. */
  openWorkspaceStore?(id: string): Promise<WorkspaceStore | null>;
}
