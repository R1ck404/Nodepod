/**
 * `@r1ck404/nodepod/headless` — Node/Bun host adapter for isomorphic headless mode.
 *
 * Installs a `worker_threads` RuntimeHost (plus local HTTP ingress) before
 * re-exporting the public SDK. Prefer this entry for agents, CI, and CLIs.
 *
 * @example
 * ```ts
 * import { Nodepod } from "@r1ck404/nodepod/headless";
 * const pod = await Nodepod.boot();
 * await pod.fs.writeFile("/hello.txt", "hi");
 * const res = await pod.request(3000, { path: "/" });
 * ```
 */

import { setRuntimeHost } from "./host/runtime-host.js";
import { createNodeHost } from "./host/node/node-host.js";

setRuntimeHost(createNodeHost());

export { setRuntimeHost, getRuntimeHost, resetRuntimeHost } from "./host/index.js";
export { createNodeHost } from "./host/node/node-host.js";
export type { NodeHostOptions } from "./host/node/node-host.js";
export { createLocalHttpIngress } from "./host/node/local-http-ingress.js";
export { openFsSnapshotCache } from "./host/node/fs-snapshot-cache.js";
export { createFsWorkspaceStore } from "./host/node/fs-workspace-store.js";

export { Nodepod } from "./sdk/nodepod.js";
export { NodepodProcess } from "./sdk/nodepod-process.js";
export { NodepodFS } from "./sdk/nodepod-fs.js";
export { NodepodFSClient, NodepodFSClientError } from "./sdk/nodepod-fs-client.js";
export {
  WorkspacePersistence,
  createMemoryWorkspaceStore,
  createIndexedDBWorkspaceStore,
  listIndexedDBWorkspaces,
  deleteIndexedDBWorkspace,
} from "./persistence/workspace/index.js";
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
} from "./persistence/workspace/index.js";
export { MemoryVolume } from "./memory-volume.js";
export type { VolumeMutation, VolumeNodeInfo, MountEntry, MetaChange } from "./memory-volume.js";
export { DependencyInstaller, install } from "./packages/installer.js";
export type { InstallFlags, InstallOutcome, WorkspaceInstallOutcome } from "./packages/installer.js";
export { discoverWorkspaces, readWorkspacePatterns } from "./packages/workspace.js";
export type { WorkspaceGraph, WorkspacePackage } from "./packages/workspace.js";
export { RequestProxy, getProxyInstance, resetProxy, NodepodSWSetupError } from "./request-proxy.js";
export type {
  ProxyOptions,
  ServiceWorkerConfig,
  NodepodSWFrameworkHint,
  PreviewOriginContext,
  PreviewOriginOption,
} from "./request-proxy.js";
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
} from "./sdk/types.js";
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
} from "./profiling/types.js";
