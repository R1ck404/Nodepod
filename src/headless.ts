/**
 * `@scelar/nodepod/headless` — Node/Bun host adapter for isomorphic headless mode.
 *
 * Installs a `worker_threads` RuntimeHost (plus local HTTP ingress) before
 * re-exporting the public SDK. Prefer this entry for agents, CI, and CLIs.
 *
 * @example
 * ```ts
 * import { Nodepod } from "@scelar/nodepod/headless";
 * const pod = await Nodepod.boot();
 * await pod.fs.writeFile("/hello.txt", "hi");
 * const res = await pod.request(3000, { path: "/" });
 * ```
 */

import { setRuntimeHost } from "./host/runtime-host";
import { createNodeHost } from "./host/node/node-host";

setRuntimeHost(createNodeHost());

export { setRuntimeHost, getRuntimeHost, resetRuntimeHost } from "./host";
export { createNodeHost } from "./host/node/node-host";
export type { NodeHostOptions } from "./host/node/node-host";
export { createLocalHttpIngress } from "./host/node/local-http-ingress";
export { openFsSnapshotCache } from "./host/node/fs-snapshot-cache";
export { createFsWorkspaceStore } from "./host/node/fs-workspace-store";

export { Nodepod } from "./sdk/nodepod";
export { NodepodProcess } from "./sdk/nodepod-process";
export { NodepodFS } from "./sdk/nodepod-fs";
export { NodepodFSClient, NodepodFSClientError } from "./sdk/nodepod-fs-client";
export {
  WorkspacePersistence,
  createMemoryWorkspaceStore,
  createIndexedDBWorkspaceStore,
  listIndexedDBWorkspaces,
  deleteIndexedDBWorkspace,
} from "./persistence/workspace";
export type {
  PersistenceOptions,
  PersistenceStatus,
  PersistenceSavedEvent,
  WorkspaceStore,
  WorkspaceManifest,
  WorkspaceEntry,
  WorkspaceBatch,
  IndexedDBWorkspaceStoreOptions,
  StoredWorkspaceInfo,
} from "./persistence/workspace";
export { MemoryVolume } from "./memory-volume";
export type { VolumeMutation, VolumeNodeInfo, MountEntry, MetaChange } from "./memory-volume";
export { DependencyInstaller, install } from "./packages/installer";
export type { InstallFlags, InstallOutcome, WorkspaceInstallOutcome } from "./packages/installer";
export { discoverWorkspaces, readWorkspacePatterns } from "./packages/workspace";
export type { WorkspaceGraph, WorkspacePackage } from "./packages/workspace";
export { RequestProxy, getProxyInstance, resetProxy, NodepodSWSetupError } from "./request-proxy";
export type {
  ProxyOptions,
  ServiceWorkerConfig,
  NodepodSWFrameworkHint,
  PreviewOriginContext,
  PreviewOriginOption,
} from "./request-proxy";
export type {
  NodepodOptions,
  NodepodRequestOptions,
  Snapshot,
  SpawnOptions,
  ShellLimits,
  ShellOptions,
  StatResult,
  SnapshotOptions,
  PerformanceStats,
  PerformanceTiming,
} from "./sdk/types";
export type {
  NodepodProfileReport,
  NodepodProfiler,
  ProfileAggregate,
  ProfileCategory,
  ProfileEnvironment,
  ProfileExportFormat,
  ProfileLongTaskSample,
  ProfileMemorySample,
  ProfileSample,
  ProfileSession,
  ProfileSpan,
  ProfileSpanOptions,
  ProfileSummary,
  ProfileWarning,
  ProfilerLevel,
  ProfilerOptions,
  ProfilePathDetail,
} from "./profiling/types";
