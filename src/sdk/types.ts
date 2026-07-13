import type { VolumeSnapshot } from "../engine-types";
import type { MemoryHandlerOptions } from "../memory-handler";
export type { PerformanceStats, PerformanceTiming } from "../performance-tracker";

/* ---- Boot options ---- */

export interface NodepodOptions {
  files?: Record<string, string | Uint8Array>;
  env?: Record<string, string>;
  workdir?: string;
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
  /** Package snapshot backend. "auto" currently prefers IndexedDB; explicit
   *  "opfs" canaries packfiles and falls back automatically. */
  packageStore?: "auto" | "memory" | "opfs";
  /**
   * set to false to force SAB off even if the runtime has it.
   * useful for envs without COOP/COEP or for testing partial mode.
   * when off: execSync/spawnSync throw on call, threaded wasi modules
   * (rolldown, lightningcss, tailwind-oxide) refuse to load, and cross
   * thread vfs reads fall back to async message passing.
   * defaults to true.
   */
  enableSharedArrayBuffer?: boolean;
  /**
   * capacity in bytes of the SharedArrayBuffer-backed fs mirror used by
   * workers and WASI modules. default is 256 MiB — enough for typical app
   * dependency trees including WASM toolchains. must be set before boot
   * because a SharedArrayBuffer cannot grow after workers receive it.
   */
  sharedVFSBufferSize?: number;
  /** domains allowed through the cors proxy. merged with built-in defaults
   *  (npm, github, esm.sh etc). pass null to allow everything */
  allowedFetchDomains?: string[] | null;
  /**
   * "lean" excludes node_modules/.npm/.cache from per-spawn VFS snapshots;
   * workers fetch those files on demand over a synchronous fs proxy. Cuts
   * per-process memory roughly by the size of node_modules. Requires
   * SharedArrayBuffer (COOP/COEP) — silently falls back to "full" without it.
   * Default: "lean" when SharedArrayBuffer is available, otherwise "full".
   */
  spawnSnapshot?: "full" | "lean";
  /**
   * Start downloading + compiling esbuild-wasm (~10MB) during boot so it's
   * ready by the time installs or builds need it. The download overlaps
   * Service Worker registration and package installs. Default: false; the
   * engine otherwise initializes automatically on first use.
   */
  preloadEsbuild?: boolean;
  /**
   * URL of the process-worker bundle asset (dist/__worker__.js). When the
   * asset is reachable, workers boot from it instead of the copy embedded in
   * the library string, saving parse time and heap. Auto-detected next to
   * the built library when omitted; the embedded copy remains the fallback.
   */
  workerUrl?: string;
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
