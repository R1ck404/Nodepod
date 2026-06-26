import type { VolumeSnapshot } from "../engine-types";
import type { MemoryHandlerOptions } from "../memory-handler";
import type { IVolume } from "../types/volume";

/* ---- Boot options ---- */

export interface NodepodOptions {
  files?: Record<string, string | Uint8Array>;
  env?: Record<string, string>;
  workdir?: string;
  /**
   * Custom virtual filesystem adapter. By default nodepod uses an in-memory
   * `MemoryVolume`. Pass any object implementing `IVolume` to back the
   * filesystem with IndexedDB, localStorage, a remote store, or anything
   * else — avoiding memory bloat when dealing with many files.
   *
   * The adapter must be synchronous (nodepod emulates Node's sync fs/require
   * via eval + SyncPromise). Async backends should pre-load into an
   * in-memory cache and write-through on mutations. `opts.files` are still
   * written into the provided volume on boot.
   */
  volume?: IVolume;
  /** URL of the nodepod service worker. Defaults to `/__sw__.js`. */
  swUrl?: string;
  /**
   * Set to `false` to skip SW registration (SSR, Node tests, or hosts
   * that don't need preview iframes / virtual HTTP servers). Defaults to
   * `true` when `navigator.serviceWorker` is available.
   */
  serviceWorker?: boolean;
  /**
   * Skip the HEAD preflight on the SW URL. Use if your host blocks HEAD,
   * requires auth on assets, or otherwise trips the check.
   */
  skipSWPreflight?: boolean;
  onServerReady?: (port: number, url: string) => void;
  /** Show a small "nodepod" watermark link in preview iframes. Defaults to true. */
  watermark?: boolean;
  /** Memory optimization settings. Omit to use defaults. */
  memory?: MemoryHandlerOptions;
  /** Cache installed node_modules in IndexedDB for faster re-boots. Default: true. */
  enableSnapshotCache?: boolean;
  /**
   * set to false to force SAB off even if the runtime has it.
   * useful for envs without COOP/COEP or for testing partial mode.
   * when off: execSync/spawnSync throw on call, threaded wasi modules
   * (rolldown, lightningcss, tailwind-oxide) refuse to load, and cross
   * thread vfs reads fall back to async message passing.
   * defaults to true.
   */
  enableSharedArrayBuffer?: boolean;
  /** domains allowed through the cors proxy. merged with built-in defaults
   *  (npm, github, esm.sh etc). pass null to allow everything */
  allowedFetchDomains?: string[] | null;
}

/* ---- Terminal ---- */

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalOptions {
  // xterm.js classes are peer deps, passed in as constructors
  Terminal: any;
  FitAddon?: any;
  WebglAddon?: any;
  SerializeAddon?: any;
  theme?: TerminalTheme;
  fontSize?: number;
  fontFamily?: string;
  prompt?: (cwd: string) => string;
  customCommands?: Record<string, (cwd: string, args: string[]) => string>;
}

/* ---- Filesystem ---- */

export interface StatResult {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

/* ---- Snapshot ---- */

export type Snapshot = VolumeSnapshot;

export interface SnapshotOptions {
  /** Exclude node_modules and other auto-installable dirs. Default: true */
  shallow?: boolean;
  /** Auto-install deps from package.json after restoring a shallow snapshot. Default: true */
  autoInstall?: boolean;
}

/* ---- Spawn ---- */

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
