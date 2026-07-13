// nodepod - browser-native Node.js runtime environment

export { MemoryVolume } from "./memory-volume";
export type {
  VolumeNode,
  FileStat,
  FileWatchHandle,
  WatchCallback,
  WatchEventKind,
  SystemError,
} from "./memory-volume";
export { ScriptEngine, executeCode } from "./script-engine";
export type { ModuleRecord, EngineOptions, ResolverFn } from "./script-engine";
export { spawnEngine, WorkerSandbox, IframeSandbox, spawnProcessWorkerEngine, ProcessWorkerAdapter } from "./engine-factory";
export type {
  IScriptEngine,
  ExecutionOutcome,
  SpawnEngineConfig,
  EngineConfig,
  VolumeSnapshot,
} from "./engine-types";
export {
  generateSandboxDeployment,
  getSandboxPageHtml,
  getSandboxHostingConfig,
  SANDBOX_DEPLOYMENT_GUIDE,
} from "./isolation-helpers";
export { buildFileSystemBridge } from "./polyfills/fs";
export type { FsBridge } from "./polyfills/fs";
export { buildProcessEnv } from "./polyfills/process";
export type { ProcessObject, ProcessEnvVars } from "./polyfills/process";
export * as path from "./polyfills/path";
export * as http from "./polyfills/http";
export {
  setFetchResponse,
  installFetchHeadersSetCookieParity,
  installNodeFetchClassParity,
} from "./polyfills/fetch-response";
export * as net from "./polyfills/net";
export * as events from "./polyfills/events";
export * as stream from "./polyfills/stream";
export * as url from "./polyfills/url";
export * as querystring from "./polyfills/querystring";
export * as util from "./polyfills/util";
export * as npm from "./packages/installer";
export { DependencyInstaller, install } from "./packages/installer";
export { RequestProxy, getProxyInstance, resetProxy, NodepodSWSetupError } from "./request-proxy";
export type { ProxyOptions, ServiceWorkerConfig, NodepodSWFrameworkHint } from "./request-proxy";
export * as chokidar from "./polyfills/chokidar";
export * as ws from "./polyfills/ws";
export * as fsevents from "./polyfills/fsevents";
export * as readdirp from "./polyfills/readdirp";
export * as module from "./polyfills/module";
export * as perf_hooks from "./polyfills/perf_hooks";
export * as worker_threads from "./polyfills/worker_threads";
export * as esbuild from "./polyfills/esbuild";
export * as rollup from "./polyfills/rollup";
export * as assert from "./polyfills/assert";

import { MemoryVolume } from "./memory-volume";
import { ScriptEngine, EngineOptions } from "./script-engine";
import { DependencyInstaller } from "./packages/installer";
import { RequestProxy, getProxyInstance } from "./request-proxy";
// lazy-load child_process to avoid pulling in the shell at module load time
let _shellMod: typeof import("./polyfills/child_process") | null = null;
async function getShellMod() {
  if (!_shellMod) _shellMod = await import("./polyfills/child_process");
  return _shellMod;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}

export interface WorkspaceConfig extends EngineOptions {
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

// create a fully-wired workspace (volume + engine + packages + proxy)
export function createWorkspace(config?: WorkspaceConfig): {
  volume: MemoryVolume;
  engine: ScriptEngine;
  packages: DependencyInstaller;
  proxy: RequestProxy;
  execute: (code: string, filename?: string) => { exports: unknown };
  runFile: (filename: string) => { exports: unknown };
  run: (command: string, options?: CommandOptions) => Promise<CommandResult>;
  sendInput: (data: string) => Promise<void>;
  createREPL: () => { eval: (code: string) => unknown };
  on: (event: string, listener: (...args: unknown[]) => void) => void;
} {
  const volume = new MemoryVolume();
  const engine = new ScriptEngine(volume, config);
  const packages = new DependencyInstaller(volume);
  const proxy = getProxyInstance({
    baseUrl: config?.baseUrl,
    onServerReady: config?.onServerReady,
  });

  // init shell lazily (SDK path uses Nodepod.boot() instead)
  getShellMod().then((mod) => mod.initShellExec(volume, { cwd: config?.cwd }));

  return {
    volume,
    engine,
    packages,
    proxy,
    execute: (code: string, filename?: string) =>
      engine.execute(code, filename),
    runFile: (filename: string) => engine.runFile(filename),
    run: async (
      command: string,
      runOpts?: CommandOptions,
    ): Promise<CommandResult> => {
      if (runOpts?.signal?.aborted) {
        return { stdout: "", stderr: "", exitCode: 130 };
      }

      const shell = await getShellMod();
      const hasStreaming =
        runOpts?.onStdout || runOpts?.onStderr || runOpts?.signal;
      if (hasStreaming) {
        shell.setStreamingCallbacks({
          onStdout: runOpts?.onStdout,
          onStderr: runOpts?.onStderr,
          signal: runOpts?.signal,
        });
      }

      return new Promise((resolve) => {
        shell.exec(command, { cwd: runOpts?.cwd }, (error, stdout, stderr) => {
          if (hasStreaming) shell.clearStreamingCallbacks();
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: error ? ((error as any).code ?? 1) : 0,
          });
        });
      });
    },
    sendInput: async (data: string) => {
      const shell = await getShellMod();
      shell.sendStdin(data);
    },
    createREPL: () => engine.createREPL(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      proxy.on(event, listener);
    },
  };
}

export default createWorkspace;

/* ---- SDK (clean public API) ---- */

export { Nodepod } from "./sdk/nodepod";
export { NodepodTerminal } from "./sdk/nodepod-terminal";
export { NodepodProcess } from "./sdk/nodepod-process";
export { NodepodFS } from "./sdk/nodepod-fs";
export { NodepodFSClient, NodepodFSClientError } from "./sdk/nodepod-fs-client";
export type {
  NodepodOptions,
  TerminalOptions,
  TerminalTheme,
  StatResult,
  Snapshot,
  SpawnOptions,
  PerformanceStats,
  PerformanceTiming,
} from "./sdk/types";
export { MemoryHandler, LRUCache } from "./memory-handler";
export type { MemoryHandlerOptions } from "./memory-handler";

/* ---- Threading / Worker Infrastructure ---- */

export { ProcessManager } from "./threading/process-manager";
export { ProcessHandle } from "./threading/process-handle";
export type { ProcessState } from "./threading/process-handle";
export { VFSBridge } from "./threading/vfs-bridge";
export { WorkerVFS } from "./threading/worker-vfs";
export { SyncChannelController, SyncChannelWorker } from "./threading/sync-channel";
export { SharedVFSController, SharedVFSReader, isSharedArrayBufferAvailable } from "./threading/shared-vfs";
export type { SharedVFSStat } from "./threading/shared-vfs";
export { createProcessContext, getActiveContext, setActiveContext } from "./threading/process-context";
export type { ProcessContext, ProcessWriter, ProcessReader, OpenFileEntry } from "./threading/process-context";
export type {
  VFSBinarySnapshot,
  VFSSnapshotEntry,
  SpawnConfig,
  ProcessInfo,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "./threading/worker-protocol";
